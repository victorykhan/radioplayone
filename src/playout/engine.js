import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import prisma from '../db.js';
import logger from '../logger.js';
import playoutState from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PlayoutEngine {
  constructor() {
    this.masterEncoder = null; // FFMpeg master stream to Icecast
    this.currentDecoder = null; // FFMpeg decoder for currently playing track
    this.nextDecoder = null; // FFMpeg decoder for crossfading track
    this.playoutTimeout = null;
    this.keepAliveInterval = null; // Sends PCM silence to keep Icecast source alive between tracks
    this.isPlaying = false;
    this.isDecoderActive = false; // True while a decoder is piping PCM
    this.pcmSampleRate = 44100;
    this.pcmChannels = 2;
    this.pcmBytesPerSample = 2; // 16-bit signed integer (s16le)
    // Pre-generate a 20ms silence buffer (20ms @ 44100Hz stereo s16le = 44100 * 0.02 * 2ch * 2bytes = 3528 bytes)
    this.silenceBuffer = Buffer.alloc(3528, 0);
  }

  // Get Icecast connection parameters from Environment
  getIcecastUrl() {
    const host = process.env.ICECAST_HOST || 'localhost';
    const port = process.env.ICECAST_PORT || '8000';
    const mount = process.env.ICECAST_MOUNT || '/playout';
    const password = process.env.ICECAST_SOURCE_PASSWORD || 'hackme';
    return `icecast://source:${password}@${host}:${port}${mount}`;
  }

  /**
   * Initializes the continuous master encoder to Icecast.
   * This process reads raw PCM from standard input and transcodes it to MP3 to stream to Icecast.
   */
  startMasterEncoder() {
    const icecastUrl = this.getIcecastUrl();
    logger.info('Starting master streaming encoder target: %s', icecastUrl.replace(/:[^:@]+@/, ':****@')); // Hide password in logs

    // Spawn ffmpeg to read raw s16le PCM from stdin and pipe to Icecast as MP3
    const ffmpegArgs = [
      '-f', 's16le',
      '-ar', String(this.pcmSampleRate),
      '-ac', String(this.pcmChannels),
      '-i', 'pipe:0',
      '-codec:a', 'libmp3lame',
      '-b:a', process.env.STREAM_BITRATE || '128k',
      '-content_type', 'audio/mpeg',
      '-f', 'mp3',
      icecastUrl
    ];

    this.masterEncoder = spawn('ffmpeg', ffmpegArgs);

    this.masterEncoder.stderr.on('data', (data) => {
      // ffmpeg prints stats/info to stderr. Under debug log level, we can print it
      logger.debug(`[Master FFmpeg] ${data.toString().trim()}`);
    });

    this.masterEncoder.on('close', (code) => {
      logger.warn('Master encoder stream to Icecast exited with code %s. Restarting in 5s...', code);
      this.stopKeepAlive();
      this.isPlaying = false;
      this.masterEncoder = null;
      setTimeout(() => this.startMasterEncoder(), 5000);
    });

    this.masterEncoder.on('error', (err) => {
      logger.error('Master encoder process error: %O', err);
    });

    // Start silence keep-alive: sends PCM silence every 20ms when no decoder is active
    // This prevents Icecast from dropping the source connection between tracks
    this.startKeepAlive();
  }

  startKeepAlive() {
    this.stopKeepAlive(); // Ensure no duplicate intervals
    this.keepAliveInterval = setInterval(() => {
      if (!this.isDecoderActive && this.masterEncoder && this.masterEncoder.stdin.writable) {
        try {
          this.masterEncoder.stdin.write(this.silenceBuffer);
        } catch (e) {
          // stdin may close; encoder restart will handle it
        }
      }
    }, 20);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /**
   * Selects the next track based on scheduling and queue guidelines:
   * 0. Check if there's a manually queued item (operator queue).
   * 1. Check if a scheduled playlist matches the current time block.
   * 2. Check if a playlist has tracks remaining in the queue.
   * 3. Select from Fallback Pool.
   * 4. Select random song from categories.
   */
  async fetchNextTrack() {
    // Rule 0: Manual operator queue takes highest priority
    const manualItem = playoutState.shiftQueue();
    if (manualItem) {
      logger.info('Queue: Playing manually queued track "%s" (queueId: %s)', manualItem.title, manualItem.queueId);
      // Fetch full track from DB to ensure we have the latest data, then apply queue cue overrides
      try {
        const dbTrack = await prisma.track.findUnique({ where: { id: manualItem.trackId } });
        if (dbTrack && !dbTrack.isDeleted) {
          // Apply queue-level cue overrides if they differ from defaults
          dbTrack.cueStart = manualItem.cueStart ?? dbTrack.cueStart;
          dbTrack.cueEnd = manualItem.cueEnd ?? dbTrack.cueEnd;
          dbTrack.volumeTrim = manualItem.volumeTrim ?? dbTrack.volumeTrim;
          return dbTrack;
        }
      } catch (err) {
        logger.warn('Queue: Failed to fetch queued track %s from DB: %s', manualItem.trackId, err.message);
      }
    }

    const now = new Date();
    const currentHourMinute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    try {
      // Rule 0.5: If an active playlist is currently executing, fetch the next track
      if (playoutState.activePlaylistId !== null) {
        try {
          const activePlaylist = await prisma.playlist.findUnique({
            where: { id: playoutState.activePlaylistId },
            include: {
              tracks: {
                orderBy: { position: 'asc' },
                include: { track: true }
              }
            }
          });

          if (activePlaylist && activePlaylist.tracks.length > 0) {
            const idx = playoutState.activePlaylistIndex;
            if (idx >= 0 && idx < activePlaylist.tracks.length) {
              const playlistTrack = activePlaylist.tracks[idx];
              playoutState.activePlaylistIndex++;
              logger.info('Scheduler selected track from active playlist "%s" [#%s]: %s', activePlaylist.name, idx + 1, playlistTrack.track.title);
              return playlistTrack.track;
            } else {
              // Finished the playlist
              if (activePlaylist.isLooping) {
                playoutState.activePlaylistIndex = 1;
                const playlistTrack = activePlaylist.tracks[0];
                logger.info('Scheduler looped playlist "%s" back to start: %s', activePlaylist.name, playlistTrack.track.title);
                return playlistTrack.track;
              } else {
                logger.info('Scheduler finished non-looping playlist "%s". Reverting to AutoDJ/Fallback.', activePlaylist.name);
                playoutState.activePlaylistId = null;
                playoutState.activePlaylistIndex = 0;
                // Fall through to scheduled/fallback check
              }
            }
          } else {
            playoutState.activePlaylistId = null;
            playoutState.activePlaylistIndex = 0;
          }
        } catch (err) {
          logger.error('Scheduler failed during active playlist track retrieval: %s', err.message);
          playoutState.activePlaylistId = null;
          playoutState.activePlaylistIndex = 0;
        }
      }

      // Rule 1: Check for scheduled playlist starting at the current minute
      const scheduledPlaylist = await prisma.playlist.findFirst({
        where: {
          isScheduled: true,
          scheduleTime: currentHourMinute
        },
        include: {
          tracks: {
            orderBy: { position: 'asc' },
            include: { track: true }
          }
        }
      });

      if (scheduledPlaylist && scheduledPlaylist.tracks.length > 0 && playoutState.lastScheduledTriggerTime !== currentHourMinute) {
        playoutState.lastScheduledTriggerTime = currentHourMinute;
        playoutState.activePlaylistId = scheduledPlaylist.id;
        playoutState.activePlaylistIndex = 1;
        
        const playlistTrack = scheduledPlaylist.tracks[0];
        logger.info('Scheduler triggered scheduled playlist "%s" at %s: %s', scheduledPlaylist.name, currentHourMinute, playlistTrack.track.title);
        return playlistTrack.track;
      }

      // Rule 2: Check Fallback Pool playlist
      const fallbackPlaylist = await prisma.playlist.findFirst({
        where: { name: 'Fallback Pool' },
        include: {
          tracks: {
            orderBy: { position: 'asc' },
            include: { track: true }
          }
        }
      });

      if (fallbackPlaylist && fallbackPlaylist.tracks.length > 0) {
        const idx = playoutState.fallbackPlaylistIndex % fallbackPlaylist.tracks.length;
        playoutState.fallbackPlaylistIndex = idx + 1;
        const playlistTrack = fallbackPlaylist.tracks[idx];
        logger.info('Scheduler selected track from Fallback Pool playlist: %s', playlistTrack.track.title);
        return playlistTrack.track;
      }

      // Rule 2.5: Legacy Fallback Pool items
      const fallbackItem = await prisma.fallbackPoolItem.findFirst({
        orderBy: { priority: 'desc' },
        include: { track: true }
      });

      if (fallbackItem && !fallbackItem.track.isDeleted) {
        logger.info('Scheduler selected track from legacy Fallback Pool: %s', fallbackItem.track.title);
        return fallbackItem.track;
      }

      // Rule 3: Fallback to a random song
      const songCount = await prisma.track.count({ where: { isDeleted: false, fileType: 'SONG' } });
      if (songCount > 0) {
        const randomIndex = Math.floor(Math.random() * songCount);
        const randomSongs = await prisma.track.findMany({
          where: { isDeleted: false, fileType: 'SONG' },
          skip: randomIndex,
          take: 1
        });
        logger.info('Scheduler fell back to random song: %s', randomSongs[0].title);
        return randomSongs[0];
      }

      // Last Resort: Any active track
      const track = await prisma.track.findFirst({ where: { isDeleted: false } });
      if (track) return track;

      throw new Error('No tracks available in the library database.');

    } catch (error) {
      logger.error('Failed to select next track: %s', error.message);
      return null;
    }
  }

  /**
   * Pre-fetches upcoming tracks to populate playoutState
   */
  async updatePlayoutQueue() {
    try {
      const upcoming = [];
      // Mock upcoming selections by peeking what would play next
      const fallbackPool = await prisma.fallbackPoolItem.findMany({
        take: 3,
        orderBy: { priority: 'desc' },
        include: { track: true }
      });
      fallbackPool.forEach(item => {
        if (!item.track.isDeleted) upcoming.push(item.track);
      });

      if (upcoming.length < 3) {
        const extraSongs = await prisma.track.findMany({
          where: { isDeleted: false, fileType: 'SONG' },
          take: 3 - upcoming.length
        });
        upcoming.push(...extraSongs);
      }

      playoutState.setUpcomingQueue(upcoming);
    } catch (err) {
      logger.error('Failed to pre-compile upcoming queue metadata: %s', err.message);
    }
  }

  /**
   * Plays a track, decoding it to raw PCM and writing to the master encoder.
   */
  /**
   * Plays a track, decoding it to raw PCM and writing to the master encoder.
   */
  async play(track, startFromOffset = null, isCart = false) {
    if (!this.masterEncoder) {
      logger.warn('Master encoder not initialized yet. Delaying track play.');
      return;
    }

    this.isPlaying = true;
    playoutState.isStopped = false;
    playoutState.isPaused = false;

    // Only set as current track and create PlayLog if it is not a resume or cart play
    if (startFromOffset === null && !isCart) {
      playoutState.setCurrentTrack(track);
      await this.updatePlayoutQueue();
      
      // Fetch active listener count to record log
      let activeListeners = 0;
      try {
        activeListeners = await prisma.listenerSession.count({ where: { disconnectedAt: null } });
      } catch {}

      // Create PlayLog entry
      this.currentPlayLog = await prisma.playLog.create({
        data: {
          trackId: track.id,
          durationPlayed: track.duration,
          listenerCount: activeListeners,
          wasAd: track.fileType === 'AD'
        }
      });
    }

    const audioFilePath = path.join(__dirname, '../../storage', track.filePath);
    const startOffset = startFromOffset !== null ? startFromOffset : track.cueStart;

    logger.info('Playout streaming: "%s" by %s (Offset: %ss, Duration: %s sec)', track.title, track.artist, startOffset.toFixed(1), track.duration);

    // 2. Decode track to raw PCM and pipe directly to master encoder input
    const decoderArgs = [
      '-ss', String(startOffset), // Start offset
      '-to', String(track.cueEnd),   // Stop offset
      '-i', audioFilePath,
      '-af', `volume=${track.volumeTrim}`, // apply gain
      '-f', 's16le',
      '-ar', String(this.pcmSampleRate),
      '-ac', String(this.pcmChannels),
      'pipe:1'
    ];

    if (this.currentDecoder) {
      try { this.currentDecoder.kill(); } catch {}
    }
    const decoderProcess = this.currentDecoder = spawn('ffmpeg', decoderArgs);
    this.isDecoderActive = true; // Signal keep-alive to pause silence generation

    this.currentDecoder.stdout.on('data', (pcmChunk) => {
      if (this.masterEncoder && this.masterEncoder.stdin.writable) {
        this.masterEncoder.stdin.write(pcmChunk);
      }
    });

    this.currentDecoder.stderr.on('data', (data) => {
      logger.debug(`[Decoder FFmpeg] ${data.toString().trim()}`);
    });

    this.currentDecoder.on('close', async (code) => {
      logger.info('Decoder finished playing track: %s (Exit code: %s)', track.title, code);
      
      if (this.currentDecoder === decoderProcess) {
        this.isDecoderActive = false; // Resume silence keep-alive to maintain Icecast connection
      }
      
      // If playout was stopped or paused by command, do not trigger next track on decoder close
      if (playoutState.isStopped || playoutState.isPaused) {
        return;
      }

      // If it was a cart track ending, resume the interrupted track
      if (isCart) {
        if (playoutState.interruptedTrack) {
          const originalTrack = playoutState.interruptedTrack;
          const resumeOffset = originalTrack.cueStart + playoutState.interruptedElapsed;
          
          logger.info('Cart finished. Resuming interrupted track "%s" from offset %ss', originalTrack.title, resumeOffset.toFixed(1));
          
          playoutState.interruptedTrack = null;
          playoutState.interruptedElapsed = 0;
          playoutState.pausedElapsed = resumeOffset - originalTrack.cueStart;
          
          this.play(originalTrack, resumeOffset);
        } else {
          this.skip();
        }
        return;
      }

      // Update PlayLog with exact played duration
      if (this.currentPlayLog && startFromOffset === null) {
        const durationPlayed = Math.round((new Date() - playoutState.startedAt) / 1000);
        prisma.playLog.update({
          where: { id: this.currentPlayLog.id },
          data: { 
            durationPlayed: Math.min(durationPlayed, track.duration),
            status: code === 0 ? 'COMPLETED' : 'INTERRUPTED' 
          }
        }).catch(err => logger.error('Failed to update play log: %s', err.message));
      }

      // If this decoder exited naturally (reached end of file) and is still the active track,
      // trigger the next track immediately to prevent dead space!
      if (this.currentDecoder === decoderProcess) {
        const elapsed = (new Date() - playoutState.startedAt) / 1000;

        if (code === 0 && elapsed > 2.0) {
          logger.info('Decoder finished track naturally after %ss. Triggering next track immediately to prevent dead space.', elapsed.toFixed(1));
          if (this.playoutTimeout) {
            clearTimeout(this.playoutTimeout);
            this.playoutTimeout = null;
          }

          const nextTrack = await this.fetchNextTrack();
          if (nextTrack) {
            this.play(nextTrack);
          } else {
            logger.warn('Playout Engine: Queue empty. Replaying current track as emergency filler.');
            this.play(track);
          }
        } else {
          logger.warn('Decoder closed early or abnormally (Exit code: %s, Elapsed: %ss). Preventing infinite skip loop.', code, elapsed.toFixed(1));
        }
      }
    });

    // 3. Schedule next track trigger
    const fade = track.fadeDuration !== null ? track.fadeDuration : parseFloat(process.env.DEFAULT_FADE_DURATION || '0');
    const playDuration = (track.cueEnd - startOffset) - fade;

    if (this.playoutTimeout) clearTimeout(this.playoutTimeout);
    this.playoutTimeout = setTimeout(async () => {
      if (isCart) return; // Cart exit handles skips

      logger.info('Triggering next scheduled track...');
      const nextTrack = await this.fetchNextTrack();
      if (nextTrack) {
        this.play(nextTrack);
      } else {
        logger.warn('Playout Engine: Queue empty. Replaying current track as emergency filler.');
        this.play(track);
      }
    }, Math.max(100, playDuration * 1000));
  }

  // Stop playout
  stop() {
    logger.info('Playout stop requested.');
    playoutState.isStopped = true;
    playoutState.isPaused = false;
    playoutState.currentTrack = null;
    playoutState.pausedElapsed = 0;

    if (this.playoutTimeout) {
      clearTimeout(this.playoutTimeout);
      this.playoutTimeout = null;
    }
    if (this.currentDecoder) {
      this.currentDecoder.kill();
      this.currentDecoder = null;
    }
    this.isPlaying = false;
    this.isDecoderActive = false; // Let keep-alive feed silence
  }

  // Pause playout
  pause() {
    if (playoutState.isPaused || playoutState.isStopped || !playoutState.currentTrack) {
      return;
    }
    logger.info('Playout pause requested.');
    
    // Save progress
    const elapsed = Math.round((new Date() - playoutState.startedAt) / 1000);
    playoutState.pausedElapsed = (playoutState.pausedElapsed || 0) + elapsed;
    playoutState.isPaused = true;

    if (this.playoutTimeout) {
      clearTimeout(this.playoutTimeout);
      this.playoutTimeout = null;
    }
    if (this.currentDecoder) {
      this.currentDecoder.kill();
      this.currentDecoder = null;
    }
    this.isDecoderActive = false; // Let keep-alive feed silence
  }

  // Resume playout
  resume() {
    if (!playoutState.isPaused || !playoutState.currentTrack) {
      return;
    }
    logger.info('Playout resume requested.');
    const track = playoutState.currentTrack;
    const resumeOffset = track.cueStart + playoutState.pausedElapsed;
    
    this.play(track, resumeOffset);
  }

  // Disconnect from Icecast (Close master encoder source)
  disconnect() {
    logger.info('Playout Icecast disconnect requested.');
    this.stop(); // Stop audio playout first
    this.stopKeepAlive(); // Stop silence keep alive
    
    if (this.masterEncoder) {
      this.masterEncoder.kill();
      this.masterEncoder = null;
    }
  }

  // Connect to Icecast (Start master encoder source)
  async connect() {
    logger.info('Playout Icecast connect requested.');
    this.startMasterEncoder();
    
    // Wait for encoder to start, then play next track if not already active
    setTimeout(async () => {
      if (!this.isPlaying) {
        const nextTrack = await this.fetchNextTrack();
        if (nextTrack) {
          this.play(nextTrack);
        }
      }
    }, 2000);
  }

  // Play an Instant Cart
  async playCart(cartTrack) {
    logger.info('Instant Cart triggered for track ID %s: %s', cartTrack.id, cartTrack.title);
    
    // If a track is currently playing (and we are not already playing a cart), save it for resume
    if (playoutState.currentTrack && !playoutState.isStopped && !playoutState.isPaused && playoutState.interruptedTrack === null) {
      playoutState.interruptedTrack = playoutState.currentTrack;
      const elapsed = Math.round((new Date() - playoutState.startedAt) / 1000);
      playoutState.interruptedElapsed = (playoutState.pausedElapsed || 0) + elapsed;
      logger.info('Saving active track "%s" at offset %ss for resumption after cart', playoutState.interruptedTrack.title, playoutState.interruptedElapsed);
    }

    if (this.playoutTimeout) clearTimeout(this.playoutTimeout);
    if (this.currentDecoder) this.currentDecoder.kill();

    this.play(cartTrack, null, true);
  }

  // Force skip to next track
  async skip() {
    logger.info('Playout skip requested by operator.');
    
    // Clear interrupted track context if skipped
    playoutState.interruptedTrack = null;
    playoutState.interruptedElapsed = 0;

    if (this.playoutTimeout) clearTimeout(this.playoutTimeout);
    if (this.currentDecoder) this.currentDecoder.kill();
    
    const nextTrack = await this.fetchNextTrack();
    if (nextTrack) {
      this.play(nextTrack);
    }
  }

  /**
   * Start playout system loop
   */
  async start() {
    this.startMasterEncoder();
    setTimeout(async () => {
      const initialTrack = await this.fetchNextTrack();
      if (initialTrack) {
        this.play(initialTrack);
      } else {
        logger.error('Playout could not start: Music library is empty. Please upload audio files first.');
      }
    }, 2000); // 2 second delay to let encoder warm up
  }
}

const playoutEngine = new PlayoutEngine();
export default playoutEngine;
