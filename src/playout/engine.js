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
    const mount = process.env.ICECAST_MOUNT || '/stream';
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
      // Rule 1: Check for scheduled playlist
      const scheduledPlaylist = await prisma.playlist.findFirst({
        where: {
          isScheduled: true,
          scheduleTime: { lte: currentHourMinute }
        },
        orderBy: { scheduleTime: 'desc' }, // closest scheduled
        include: {
          tracks: {
            orderBy: { position: 'asc' },
            include: { track: true }
          }
        }
      });

      if (scheduledPlaylist && scheduledPlaylist.tracks.length > 0) {
        // Find if we have already played some tracks
        // For simplicity: pop the first track in position order
        const playlistTrack = scheduledPlaylist.tracks[0];
        
        // Remove track from playlist so it doesn't repeat immediately
        await prisma.playlistTrack.delete({ where: { id: playlistTrack.id } });

        // Update playlist duration
        await prisma.playlist.update({
          where: { id: scheduledPlaylist.id },
          data: { duration: { decrement: playlistTrack.track.duration } }
        });

        logger.info('Scheduler selected track from playlist "%s": %s', scheduledPlaylist.name, playlistTrack.track.title);
        return playlistTrack.track;
      }

      // Rule 2: Check Fallback Pool items
      const fallbackItem = await prisma.fallbackPoolItem.findFirst({
        orderBy: { priority: 'desc' },
        include: { track: true }
      });

      if (fallbackItem && !fallbackItem.track.isDeleted) {
        logger.info('Scheduler selected track from Fallback Pool: %s', fallbackItem.track.title);
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
  async play(track) {
    if (!this.masterEncoder) {
      logger.warn('Master encoder not initialized yet. Delaying track play.');
      return;
    }

    this.isPlaying = true;
    playoutState.setCurrentTrack(track);
    await this.updatePlayoutQueue();

    const audioFilePath = path.join(__dirname, '../../storage', track.filePath);
    logger.info('Playout streaming: "%s" by %s (Duration: %s sec)', track.title, track.artist, track.duration);

    // Fetch active listener count to record log
    let activeListeners = 0;
    try {
      activeListeners = await prisma.listenerSession.count({ where: { disconnectedAt: null } });
    } catch {}

    // 1. Create PlayLog entry
    const playLog = await prisma.playLog.create({
      data: {
        trackId: track.id,
        durationPlayed: track.duration,
        listenerCount: activeListeners,
        wasAd: track.fileType === 'AD'
      }
    });

    // 2. Decode track to raw PCM and pipe directly to master encoder input
    // We apply volume trim if configured
    const decoderArgs = [
      '-ss', String(track.cueStart), // Start offset
      '-to', String(track.cueEnd),   // Stop offset
      '-i', audioFilePath,
      '-af', `volume=${track.volumeTrim}`, // apply gain
      '-f', 's16le',
      '-ar', String(this.pcmSampleRate),
      '-ac', String(this.pcmChannels),
      'pipe:1'
    ];

    this.currentDecoder = spawn('ffmpeg', decoderArgs);
    this.isDecoderActive = true; // Signal keep-alive to pause silence generation

    this.currentDecoder.stdout.on('data', (pcmChunk) => {
      // Pipe raw PCM bytes into master encoder
      if (this.masterEncoder && this.masterEncoder.stdin.writable) {
        this.masterEncoder.stdin.write(pcmChunk);
      }
    });

    this.currentDecoder.stderr.on('data', (data) => {
      logger.debug(`[Decoder FFmpeg] ${data.toString().trim()}`);
    });

    this.currentDecoder.on('close', (code) => {
      logger.info('Decoder finished playing track: %s (Exit code: %s)', track.title, code);
      this.isDecoderActive = false; // Resume silence keep-alive to maintain Icecast connection
      
      // Update PlayLog with exact played duration
      const durationPlayed = Math.round((new Date() - playoutState.startedAt) / 1000);
      prisma.playLog.update({
        where: { id: playLog.id },
        data: { 
          durationPlayed: Math.min(durationPlayed, track.duration),
          status: code === 0 ? 'COMPLETED' : 'INTERRUPTED' 
        }
      }).catch(err => logger.error('Failed to update play log: %s', err.message));
    });

    // 3. Schedule next track trigger
    // If crossfade is configured, we trigger earlier
    const fade = track.fadeDuration !== null ? track.fadeDuration : parseFloat(process.env.DEFAULT_FADE_DURATION || '0');
    const playDuration = (track.cueEnd - track.cueStart) - fade;

    this.playoutTimeout = setTimeout(async () => {
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

  // Force skip to next track
  async skip() {
    logger.info('Playout skip requested by operator.');
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
