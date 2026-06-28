import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import net from 'net';
import prisma from '../db.js';
import logger from '../logger.js';
import playoutState from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PlayoutEngine {
  constructor() {
    this.telnetHost = '127.0.0.1';
    this.telnetPort = 1234;
    this.loadingTrack = null;
    this.loadingIsCart = false;
    this.currentPlayLog = null;
    this.isPlaying = false;

    // Transient interruption states
    this.cartTrackToPlay = null;
    this.interruptedTrackToResume = null;
    this.interruptedOffsetToResume = 0;
    this.pausedTrackToResume = null;
    this.pausedOffsetToResume = 0;
    this.isSourceConnected = true;
  }

  // Sends control commands to Liquidsoap via local Telnet interface
  sendTelnetCommand(command) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let response = '';

      client.connect(this.telnetPort, this.telnetHost, () => {
        client.write(`${command}\r\n`);
      });

      client.on('data', (data) => {
        response += data.toString();
        if (response.includes('END')) {
          client.end();
        }
      });

      client.on('close', () => {
        resolve(response.trim());
      });

      client.on('error', (err) => {
        logger.error(`Liquidsoap Telnet connection failed: ${err.message}`);
        client.destroy();
        reject(err);
      });

      setTimeout(() => {
        client.destroy();
        resolve(response.trim() || 'TIMEOUT');
      }, 2000);
    });
  }

  /**
   * Called by HTTP GET /next-track-path endpoint (queried by Liquidsoap)
   */
  async fetchNextTrackForLiquidsoap() {
    try {
      // 1. Check if we need to play an instant cart track
      if (this.cartTrackToPlay) {
        const track = this.cartTrackToPlay;
        this.cartTrackToPlay = null;
        this.loadingTrack = track;
        this.loadingIsCart = true;
        logger.info('Liquidsoap: Serving Instant Cart track: "%s"', track.title);
        return track;
      }

      // 2. Check if we need to resume an interrupted track
      if (this.interruptedTrackToResume) {
        const track = this.interruptedTrackToResume;
        const offset = this.interruptedOffsetToResume;
        this.interruptedTrackToResume = null;
        this.interruptedOffsetToResume = 0;

        const cTrack = { ...track, cueStart: offset };
        this.loadingTrack = cTrack;
        this.loadingIsCart = false;
        logger.info('Liquidsoap: Resuming interrupted track "%s" from offset %ss', track.title, offset.toFixed(1));
        return cTrack;
      }

      // 3. Check if we need to resume a paused track
      if (this.pausedTrackToResume) {
        const track = this.pausedTrackToResume;
        const offset = this.pausedOffsetToResume;
        this.pausedTrackToResume = null;
        this.pausedOffsetToResume = 0;

        const cTrack = { ...track, cueStart: offset };
        this.loadingTrack = cTrack;
        this.loadingIsCart = false;
        logger.info('Liquidsoap: Resuming paused track "%s" from offset %ss', track.title, offset.toFixed(1));
        return cTrack;
      }

      // 4. Fall through to standard queue/scheduler selection
      const nextTrack = await this.fetchNextTrack();
      if (nextTrack) {
        this.loadingTrack = nextTrack;
        this.loadingIsCart = false;
        logger.info('Liquidsoap: Serving next scheduled track: "%s"', nextTrack.title);
        return nextTrack;
      }

      logger.warn('Liquidsoap: Playout queue is empty.');
      return null;

    } catch (err) {
      logger.error('Failed fetching next track for Liquidsoap: %O', err);
      return null;
    }
  }

  /**
   * Called by HTTP POST /track-started endpoint (notified by Liquidsoap)
   */
  async onTrackStartedInLiquidsoap() {
    if (!this.loadingTrack) {
      logger.warn('Liquidsoap track started, but no loadingTrack was pending in Node.js.');
      return;
    }

    const track = this.loadingTrack;
    const isCart = this.loadingIsCart;
    this.loadingTrack = null;
    this.loadingIsCart = false;

    this.isPlaying = true;
    playoutState.isStopped = false;
    playoutState.isPaused = false;
    playoutState.startedAt = new Date();

    if (!isCart) {
      playoutState.setCurrentTrack(track);
      await this.updatePlayoutQueue();

      // Fetch active listener count
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
      logger.info('PlayLog created for: "%s"', track.title);
    }
  }

  /**
   * Selects the next track based on scheduling and queue guidelines
   */
  async fetchNextTrack() {
    const manualItem = playoutState.shiftQueue();
    if (manualItem) {
      try {
        const dbTrack = await prisma.track.findUnique({ where: { id: manualItem.trackId } });
        if (dbTrack && !dbTrack.isDeleted) {
          dbTrack.cueStart = manualItem.cueStart ?? dbTrack.cueStart;
          dbTrack.cueEnd = manualItem.cueEnd ?? dbTrack.cueEnd;
          dbTrack.volumeTrim = manualItem.volumeTrim ?? dbTrack.volumeTrim;
          return dbTrack;
        }
      } catch (err) {
        logger.warn('Queue: Failed to fetch queued track %s: %s', manualItem.trackId, err.message);
      }
    }

    const now = new Date();
    const currentHourMinute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    try {
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
              return playlistTrack.track;
            } else {
              if (activePlaylist.isLooping) {
                playoutState.activePlaylistIndex = 1;
                return activePlaylist.tracks[0].track;
              } else {
                playoutState.activePlaylistId = null;
                playoutState.activePlaylistIndex = 0;
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
        return scheduledPlaylist.tracks[0].track;
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
        const randomTracks = await prisma.track.findMany({
          where: { isDeleted: false, fileType: 'SONG' },
          skip: randomIndex,
          take: 1
        });
        if (randomTracks.length > 0) {
          logger.info('Scheduler selected random fallback song: %s', randomTracks[0].title);
          return randomTracks[0];
        }
      }

      // Final fallback: any track in db
      const randomTrack = await prisma.track.findFirst({
        where: { isDeleted: false }
      });
      return randomTrack;

    } catch (error) {
      logger.error('Error selecting next track: %O', error);
      return null;
    }
  }

  async updatePlayoutQueue() {
    try {
      const activeQueue = playoutState.upcomingQueue;
      const displayQueue = activeQueue.slice(0, 5);
      logger.info('Queue status: %O', displayQueue.map(t => t.title));
    } catch {}
  }

  // Stop playout (Skip current track to silence)
  async stop() {
    logger.info('Playout stop requested.');
    playoutState.isStopped = true;
    playoutState.isPaused = false;
    playoutState.currentTrack = null;
    playoutState.pausedElapsed = 0;
    this.isPlaying = false;

    // Reset interrupted states
    this.cartTrackToPlay = null;
    this.interruptedTrackToResume = null;
    this.interruptedOffsetToResume = 0;
    this.pausedTrackToResume = null;
    this.pausedOffsetToResume = 0;

    await this.sendTelnetCommand('playout.skip');
  }

  // Pause playout (Skip and remember elapsed offset)
  async pause() {
    if (playoutState.isPaused || playoutState.isStopped || !playoutState.currentTrack) {
      return;
    }
    logger.info('Playout pause requested.');
    
    const elapsed = (new Date() - playoutState.startedAt) / 1000;
    const currentOffset = (playoutState.currentTrack.cueStart || 0) + elapsed;

    this.pausedTrackToResume = playoutState.currentTrack;
    this.pausedOffsetToResume = currentOffset;
    playoutState.isPaused = true;

    await this.sendTelnetCommand('playout.skip');
  }

  // Resume playout (Triggers skip to start playing cued paused track)
  async resume() {
    if (!playoutState.isPaused || !this.pausedTrackToResume) {
      return;
    }
    logger.info('Playout resume requested.');
    playoutState.isPaused = false;
    
    // Liquidsoap will automatically fetch on the next request cycle, but we skip to speed up transition
    await this.sendTelnetCommand('playout.skip');
  }

  // Play an Instant Cart
  async playCart(cartTrack) {
    logger.info('Instant Cart triggered for track: "%s"', cartTrack.title);

    if (playoutState.currentTrack && !playoutState.isStopped && !playoutState.isPaused && !this.interruptedTrackToResume) {
      this.interruptedTrackToResume = playoutState.currentTrack;
      const elapsed = (new Date() - playoutState.startedAt) / 1000;
      this.interruptedOffsetToResume = (playoutState.currentTrack.cueStart || 0) + elapsed;
      logger.info('Interrupted track "%s" saved at offset %ss for resumption', this.interruptedTrackToResume.title, this.interruptedOffsetToResume.toFixed(1));
    }

    this.cartTrackToPlay = cartTrack;
    await this.sendTelnetCommand('playout.skip');
  }

  // Skip current track
  async skip() {
    logger.info('Playout skip requested.');
    this.cartTrackToPlay = null;
    this.interruptedTrackToResume = null;
    this.interruptedOffsetToResume = 0;

    await this.sendTelnetCommand('playout.skip');
  }

  // Start playout
  async start() {
    logger.info('Playout start initiated.');
    this.isPlaying = true;
    await this.sendTelnetCommand('playout.skip');
  }

  async disconnect() {
    logger.info('Disconnecting playout source from Icecast via Telnet');
    this.isSourceConnected = false;
    try {
      await this.sendTelnetCommand('playout_output.stop');
    } catch (err) {
      logger.error('Failed to disconnect playout_output: %O', err);
    }
  }

  async connect() {
    logger.info('Connecting playout source to Icecast via Telnet');
    this.isSourceConnected = true;
    try {
      await this.sendTelnetCommand('playout_output.start');
    } catch (err) {
      logger.error('Failed to connect playout_output: %O', err);
    }
  }
}

const playoutEngine = new PlayoutEngine();
export default playoutEngine;
