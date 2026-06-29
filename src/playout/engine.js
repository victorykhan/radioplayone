import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import net from 'net';
import prisma from '../db.js';
import logger from '../logger.js';
import playoutState from './state.js';
import { getStationTimezone } from '../utils/timezone.js';

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
    this.activeScheduleSlotId = null; // Track current scheduled calendar slot
    this.musicCountSinceLastSweeper = 0; // Tracks songs played since last sweeper insert
    this.musicCountSinceLastAd = 0; // Tracks songs played since last ad insert
    
    this.generateSilenceTrack();
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

      if (playoutState.isStopped) {
        playoutState.setCurrentTrack(null);
        return null;
      }
      if (playoutState.isPaused) {
        return null;
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

      // 4. Check if we need to insert an Ad (Layer 5)
      if (this.musicCountSinceLastAd >= 3 && (!playoutState.queue || playoutState.queue.length === 0)) {
        const adTrack = await this.fetchNextAdTrack();
        if (adTrack) {
          this.musicCountSinceLastAd = 0; // Reset counter
          this.loadingTrack = adTrack;
          this.loadingIsCart = false;
          logger.info('Liquidsoap: Serving campaign ad break: "%s"', adTrack.title);
          return adTrack;
        }
      }

      // 4.5. Check if we need to insert a Transition Sweeper (Layer 3 & 4 sequential transition)
      const sweeperInterval = await this.getSweeperInterval();
      if (this.musicCountSinceLastSweeper >= sweeperInterval && (!playoutState.queue || playoutState.queue.length === 0)) {
        const nextSong = await this.peekNextScheduledTrack();
        if (nextSong && nextSong.fileType === 'SONG') {
          const transitionTrack = await this.findMatchingImaging(nextSong, 'TRANSITION');
          if (transitionTrack) {
            this.musicCountSinceLastSweeper = 0; // Reset counter
            this.loadingTrack = transitionTrack;
            this.loadingIsCart = false;
            logger.info('Liquidsoap: Serving auto-inserted transition sweeper: "%s" before song "%s"', transitionTrack.title, nextSong.title);
            return transitionTrack;
          }
        }
      }

      // 5. Fall through to standard queue/scheduler selection
      const nextTrack = await this.fetchNextTrack();
      if (nextTrack) {
        this.loadingTrack = nextTrack;
        this.loadingIsCart = false;
        logger.info('Liquidsoap: Serving next scheduled track: "%s"', nextTrack.title);
        return nextTrack;
      }

      logger.warn('Liquidsoap: Playout queue is empty.');
      playoutState.setCurrentTrack(null);
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

      // Increment campaign play counts if this is an ad/promo track
      if (track.fileType === 'AD' || track.fileType === 'PROMO') {
        try {
          const adTrackRef = await prisma.adTrack.findFirst({
            where: { trackId: track.id },
            include: { campaign: true }
          });
          if (adTrackRef && adTrackRef.campaign) {
            await prisma.campaign.update({
              where: { id: adTrackRef.campaignId },
              data: {
                currentPlays: { increment: 1 }
              }
            });
            logger.info('PlayoutEngine: Incremented plays for Campaign "%s" (current: %s)', adTrackRef.campaign.name, adTrackRef.campaign.currentPlays + 1);
          }
        } catch (err) {
          logger.error('PlayoutEngine: Failed to update campaign stats: %s', err.message);
        }
      }

      // Increment song counter to schedule sweeper and ad intervals
      if (track.fileType === 'SONG') {
        this.musicCountSinceLastSweeper++;
        this.musicCountSinceLastAd++;
        logger.debug('PlayoutEngine: Incremented song counters. Sweeper: %s, Ad: %s', this.musicCountSinceLastSweeper, this.musicCountSinceLastAd);
      }
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
          dbTrack.playoutSource = 'Manual Queue';
          return dbTrack;
        }
      } catch (err) {
        logger.warn('Queue: Failed to fetch queued track %s: %s', manualItem.trackId, err.message);
      }
    }

    const nowUTC = new Date();

    try {
      // 1. RESOLVE CALENDAR SCHEDULE SLOTS (3 Months Advance Slots)
      const activeSlot = await prisma.scheduleSlot.findFirst({
        where: {
          startAt: { lte: nowUTC },
          endAt: { gte: nowUTC }
        },
        include: {
          playlist: {
            include: {
              tracks: {
                orderBy: { position: 'asc' },
                include: { track: true }
              }
            }
          }
        }
      });

      if (activeSlot && activeSlot.playlist.tracks.length > 0) {
        // If a new scheduled slot has started, switch active playlists
        if (this.activeScheduleSlotId !== activeSlot.id) {
          logger.info('Scheduler: Switching to scheduled calendar slot: "%s"', activeSlot.playlist.name);
          this.activeScheduleSlotId = activeSlot.id;
          playoutState.activePlaylistId = activeSlot.playlistId;
          playoutState.activePlaylistIndex = 0;
        }
      } else {
        // No active slot; clean slot tracking
        this.activeScheduleSlotId = null;
      }
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
            playoutState.activePlaylistTracks = activePlaylist.tracks.map(pt => pt.track);
            const idx = playoutState.activePlaylistIndex;
            if (idx >= 0 && idx < activePlaylist.tracks.length) {
              const playlistTrack = activePlaylist.tracks[idx];
              playoutState.activePlaylistIndex++;
              playlistTrack.track.playoutSource = `Show: ${activePlaylist.name}`;
              return playlistTrack.track;
            } else {
              if (activePlaylist.isLooping) {
                playoutState.activePlaylistIndex = 1;
                activePlaylist.tracks[0].track.playoutSource = `Show: ${activePlaylist.name}`;
                return activePlaylist.tracks[0].track;
              } else {
                playoutState.activePlaylistId = null;
                playoutState.activePlaylistIndex = 0;
                playoutState.activePlaylistTracks = [];
              }
            }
          } else {
            playoutState.activePlaylistId = null;
            playoutState.activePlaylistIndex = 0;
            playoutState.activePlaylistTracks = [];
          }
        } catch (err) {
          logger.error('Scheduler failed during active playlist track retrieval: %s', err.message);
          playoutState.activePlaylistId = null;
          playoutState.activePlaylistIndex = 0;
          playoutState.activePlaylistTracks = [];
        }
      }

      // 2. CHECK REGULAR HOUR-BASED SCHEDULES (Legacy repeating schedule format)
      if (playoutState.activePlaylistId === null) {
        const currentHourMinute = `${String(nowUTC.getHours()).padStart(2, '0')}:${String(nowUTC.getMinutes()).padStart(2, '0')}`;
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
          playoutState.activePlaylistTracks = scheduledPlaylist.tracks.map(pt => pt.track);
          playoutState.activePlaylistIndex = 1;
          scheduledPlaylist.tracks[0].track.playoutSource = `Playlist: ${scheduledPlaylist.name}`;
          return scheduledPlaylist.tracks[0].track;
        }
      }

      // 3. CHECK MULTIPLE ACTIVE FALLBACK POOLS
      const fallbackPlaylists = await prisma.playlist.findMany({
        where: { isFallbackPool: true },
        include: {
          tracks: {
            orderBy: { position: 'asc' },
            include: { track: true }
          }
        }
      });

      if (fallbackPlaylists.length > 0) {
        // Collect all tracks across fallback playlists
        const allFallbackTracks = fallbackPlaylists.flatMap(p => p.tracks);
        if (allFallbackTracks.length > 0) {
          playoutState.fallbackTracks = allFallbackTracks.map(pt => pt.track);
          const idx = playoutState.fallbackPlaylistIndex % allFallbackTracks.length;
          playoutState.fallbackPlaylistIndex = idx + 1;
          const selectedTrack = allFallbackTracks[idx].track;
          logger.info('Scheduler selected track from Fallback Pools: %s', selectedTrack.title);
          selectedTrack.playoutSource = 'Fallback Pool';
          return selectedTrack;
        }
      }

      // Legacy fallback item resolver
      const fallbackItem = await prisma.fallbackPoolItem.findFirst({
        orderBy: { priority: 'desc' },
        include: { track: true }
      });

      if (fallbackItem && !fallbackItem.track.isDeleted) {
        logger.info('Scheduler selected track from legacy Fallback Pool: %s', fallbackItem.track.title);
        fallbackItem.track.playoutSource = 'Legacy Fallback Pool';
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
          randomTracks[0].playoutSource = 'Random Library Song';
          return randomTracks[0];
        }
      }

      // Final fallback: any song in db
      const randomTrack = await prisma.track.findFirst({
        where: { isDeleted: false, fileType: 'SONG' }
      });
      if (randomTrack) {
        randomTrack.playoutSource = 'Random Library Fallback';
      }
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

    await this.sendTelnetCommand('playout.flush_and_skip');
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

    await this.sendTelnetCommand('playout.flush_and_skip');
  }

  // Resume playout (Triggers skip to start playing cued paused track)
  async resume() {
    if (!playoutState.isPaused || !this.pausedTrackToResume) {
      return;
    }
    logger.info('Playout resume requested.');
    playoutState.isPaused = false;
    
    // Liquidsoap will automatically fetch on the next request cycle, but we skip to speed up transition
    await this.sendTelnetCommand('playout.flush_and_skip');
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
    await this.sendTelnetCommand('playout.flush_and_skip');
  }

  // Skip current track
  async skip() {
    logger.info('Playout skip requested.');
    this.cartTrackToPlay = null;
    this.interruptedTrackToResume = null;
    this.interruptedOffsetToResume = 0;

    await this.sendTelnetCommand('playout.flush_and_skip');
  }

  // Start playout
  async start() {
    logger.info('Playout start initiated.');
    playoutState.isStopped = false;
    playoutState.isPaused = false;
    this.isPlaying = true;
    await this.sendTelnetCommand('playout.flush_and_skip');
  }

  async disconnect() {
    logger.info('Disconnecting playout source from Icecast via Telnet');
    this.isSourceConnected = false;
    try {
      await this.sendTelnetCommand('playout_output.skip');
    } catch (err) {
      logger.error('Failed to disconnect playout_output: %O', err);
    }
  }

  async connect() {
    logger.info('Connecting playout source to Icecast via Telnet');
    this.isSourceConnected = true;
    try {
      await this.sendTelnetCommand('playout.flush_and_skip');
    } catch (err) {
      logger.error('Failed to connect playout_output: %O', err);
    }
  }

  async setVolume(amplify) {
    // amplify is a float string like "0.7500" from 0.0000 to 1.0000
    logger.info('Setting master volume to amplify=%s', amplify);
    try {
      await this.sendTelnetCommand(`var.set master_vol = ${amplify}`);
    } catch (err) {
      logger.error('Failed to set master volume: %O', err);
    }
  }

  // Swap active live track with a new track
  async instantSwapTrack(newTrackId) {
    try {
      logger.info('Instant Swap: Swapping active live track with track ID: %s', newTrackId);
      
      const newTrack = await prisma.track.findUnique({
        where: { id: parseInt(newTrackId) }
      });
      if (!newTrack || newTrack.isDeleted) {
        throw new Error('Replacement track not found or has been soft-deleted');
      }

      // 1. Process the currently playing track
      const current = playoutState.currentTrack;
      if (current) {
        const elapsed = playoutState.isPaused 
          ? playoutState.pausedElapsed 
          : Math.round((new Date() - playoutState.startedAt) / 1000);
        
        // Push the current track back to index 0 of the manual queue
        // Mark it as interrupted so it renders in red
        const interruptedQueueItem = {
          ...current,
          cueStart: (current.cueStart || 0) + elapsed, // Resume from where it was cut off!
          isInterrupted: true
        };
        
        playoutState.addToQueue(interruptedQueueItem, 0);
        logger.info('Instant Swap: Pushed interrupted track "%s" back to manual queue (resume cue offset: %ss)', current.title, interruptedQueueItem.cueStart.toFixed(1));
      }

      // 2. Add the new replacement track at index 0
      // Mark it as swapped next so it renders in blue
      const swapQueueItem = {
        ...newTrack,
        isSwappedNext: true
      };
      playoutState.addToQueue(swapQueueItem, 0);
      logger.info('Instant Swap: Added replacement track "%s" to head of the queue', newTrack.title);

      // Reset resumed states so they do not conflict
      this.cartTrackToPlay = null;
      this.interruptedTrackToResume = null;
      this.interruptedOffsetToResume = 0;

      // 3. Trigger skip in Liquidsoap
      logger.info('Instant Swap: Executing playout.flush_and_skip via Telnet');
      await this.sendTelnetCommand('playout.flush_and_skip');
      
      return { message: `Interrupted "${current ? current.title : 'Live'}" and swapped to "${newTrack.title}" successfully` };
    } catch (error) {
      logger.error('Failed performing instant track swap: %O', error);
      throw error;
    }
  }

  // Fetch next campaign ad track based on priority-weighted lag and cap constraints
  async fetchNextAdTrack() {
    try {
      const now = new Date();
      const currentHour = now.getHours();

      // Find all active campaigns by date and isActive flag
      const activeCampaigns = await prisma.campaign.findMany({
        where: {
          startDate: { lte: now },
          endDate: { gte: now },
          isActive: true
        },
        include: {
          ads: {
            include: { track: true }
          }
        }
      });

      const eligibleCampaigns = [];

      for (const campaign of activeCampaigns) {
        // Contract limit check
        if (campaign.currentPlays >= campaign.targetPlays) continue;

        // Hour range constraint check
        if (currentHour < campaign.validHoursStart || currentHour > campaign.validHoursEnd) continue;

        const trackIds = campaign.ads.map(ad => ad.trackId);
        if (trackIds.length === 0) continue;

        // Cap constraints check
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const playsThisHour = await prisma.playLog.count({
          where: {
            trackId: { in: trackIds },
            playedAt: { gte: oneHourAgo }
          }
        });
        if (playsThisHour >= campaign.hourlyCap) continue;

        const playsToday = await prisma.playLog.count({
          where: {
            trackId: { in: trackIds },
            playedAt: { gte: startOfToday }
          }
        });
        if (playsToday >= campaign.dailyCap) continue;

        // Priority lag ratio calculation
        const totalDuration = campaign.endDate - campaign.startDate;
        const timeElapsed = now - campaign.startDate;
        const expectedPlays = totalDuration > 0 ? (timeElapsed / totalDuration) * campaign.targetPlays : campaign.targetPlays;
        // Priority multiplier
        const priorityScore = (expectedPlays - campaign.currentPlays) * (campaign.priority || 1);

        eligibleCampaigns.push({ campaign, score: priorityScore });
      }

      if (eligibleCampaigns.length === 0) return null;

      // Sort by priority score descending
      eligibleCampaigns.sort((a, b) => b.score - a.score);
      const selectedCampaign = eligibleCampaigns[0].campaign;

      const adsList = selectedCampaign.ads.filter(ad => !ad.track.isDeleted);
      if (adsList.length === 0) return null;

      const randomAd = adsList[Math.floor(Math.random() * adsList.length)].track;
      randomAd.playoutSource = `Ad Campaign: ${selectedCampaign.name}`;
      return randomAd;

    } catch (err) {
      logger.error('PlayoutEngine: Failed to fetch next ad track: %s', err.message);
      return null;
    }
  }

  // Get dynamic sweeper interval (default: 3) supporting global custom settings and daypart overrides
  async getSweeperInterval() {
    try {
      // 1. Check if there are active daypart overrides
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'sweeper_dayparts' } });
      if (setting && setting.value) {
        const dayparts = JSON.parse(setting.value); // Array of { startHour, endHour, interval }
        const currentHour = new Date().getHours();
        
        const activeDaypart = dayparts.find(dp => {
          const start = parseInt(dp.startHour);
          const end = parseInt(dp.endHour);
          if (start <= end) {
            return currentHour >= start && currentHour <= end;
          } else {
            // Overnights (e.g. 22:00 to 04:00)
            return currentHour >= start || currentHour <= end;
          }
        });
        
        if (activeDaypart && activeDaypart.interval) {
          const val = parseInt(activeDaypart.interval);
          if (!isNaN(val) && val > 0) return val;
        }
      }

      // 2. Fall back to global custom default interval
      const globalSetting = await prisma.systemSetting.findUnique({ where: { key: 'sweeper_interval' } });
      if (globalSetting && globalSetting.value) {
        const val = parseInt(globalSetting.value);
        if (!isNaN(val) && val > 0) return val;
      }
    } catch (e) {
      logger.error('Failed retrieving sweeper interval settings: %s', e.message);
    }
    return 3; // Standard fallback
  }

  // Helper to find a matching imaging track for a given song based on rules
  async findMatchingImaging(song, playMode) {
    try {
      const imagings = await prisma.imagingElement.findMany({
        where: {
          isActive: true,
          playMode: playMode,
          type: { in: ['SWEEPER', 'STATION_ID', 'DJ_DROP'] },
          track: { isDeleted: false }
        },
        include: { track: true }
      });

      if (imagings.length === 0) return null;

      let candidates = imagings;
      if (song && song.fileType === 'SONG') {
        candidates = imagings.filter(img => {
          // BPM Match
          if (img.bpmMin !== null && img.bpmMin !== undefined && img.bpmMin > 0) {
            if (!song.bpm || song.bpm < img.bpmMin) return false;
          }
          if (img.bpmMax !== null && img.bpmMax !== undefined && img.bpmMax > 0) {
            if (!song.bpm || song.bpm > img.bpmMax) return false;
          }
          // Energy Match
          if (img.energyMin !== null && img.energyMin !== undefined && img.energyMin > 0) {
            if (!song.energy || song.energy < img.energyMin) return false;
          }
          if (img.energyMax !== null && img.energyMax !== undefined && img.energyMax > 0) {
            if (!song.energy || song.energy > img.energyMax) return false;
          }
          // Mood Match
          if (img.mood && img.mood.trim() !== '') {
            if (!song.mood) return false;
            const songMoodClean = song.mood.trim().toLowerCase();
            const imgMoods = img.mood.split(',').map(m => m.trim().toLowerCase());
            const hasMoodMatch = imgMoods.some(m => songMoodClean.includes(m) || m.includes(songMoodClean));
            if (!hasMoodMatch) return false;
          }
          return true;
        });
      }

      if (candidates.length === 0) {
        candidates = imagings;
      }

      const randomIndex = Math.floor(Math.random() * candidates.length);
      return candidates[randomIndex].track;
    } catch (error) {
      logger.error('Failed to find matching imaging track: %O', error);
      return null;
    }
  }

  // Peek at the upcoming scheduled track without shifting or advancing index
  async peekNextScheduledTrack() {
    try {
      if (playoutState.upcomingQueue.length > 0) {
        const manualItem = playoutState.upcomingQueue[0];
        return await prisma.track.findUnique({ where: { id: manualItem.trackId } });
      }

      if (playoutState.activePlaylistId !== null) {
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
            return activePlaylist.tracks[idx].track;
          } else if (activePlaylist.isLooping) {
            return activePlaylist.tracks[0].track;
          }
        }
      }

      const fallbackPlaylists = await prisma.playlist.findMany({
        where: { isFallbackPool: true },
        include: {
          tracks: {
            orderBy: { position: 'asc' },
            include: { track: true }
          }
        }
      });
      if (fallbackPlaylists.length > 0) {
        const allFallbackTracks = fallbackPlaylists.flatMap(p => p.tracks);
        if (allFallbackTracks.length > 0) {
          const idx = playoutState.fallbackPlaylistIndex % allFallbackTracks.length;
          return allFallbackTracks[idx].track;
        }
      }

      const fallbackItem = await prisma.fallbackPoolItem.findFirst({
        orderBy: { priority: 'desc' },
        include: { track: true }
      });
      if (fallbackItem && !fallbackItem.track.isDeleted) {
        return fallbackItem.track;
      }

      return await prisma.track.findFirst({
        where: { isDeleted: false, fileType: 'SONG' }
      });
    } catch (error) {
      logger.error('Error peeking next track: %O', error);
      return null;
    }
  }

  // Fetch a dynamic imaging sweeper track automatically every X tracks
  async fetchNextImagingForLiquidsoap() {
    try {
      const sweeperInterval = await this.getSweeperInterval();
      if (this.musicCountSinceLastSweeper >= sweeperInterval) {
        const song = playoutState.currentTrack;
        const track = await this.findMatchingImaging(song, 'OVERLAY');
        if (track) {
          logger.info('Scheduler: Serving auto-inserted matched overlay sweeper: "%s" for song "%s"', track.title, song ? song.title : 'None');
          this.musicCountSinceLastSweeper = 0; // Reset counter
          return track;
        }
      }
      return null;
    } catch (error) {
      logger.error('Failed fetching next imaging: %O', error);
      return null;
    }
  }

  // Generate 5-second silent track on boot
  generateSilenceTrack() {
    const storageDir = path.resolve(__dirname, '../../storage');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    const silencePath = path.join(storageDir, 'silence.mp3');
    if (!fs.existsSync(silencePath)) {
      logger.info('PlayoutEngine: Generating 5-second safety silence track at %s', silencePath);
      exec(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 5 -q:a 9 "${silencePath}"`, (err) => {
        if (err) {
          logger.error('PlayoutEngine: Failed to generate silence track: %s', err.message);
        } else {
          logger.info('PlayoutEngine: Silence track generated successfully.');
        }
      });
    }
  }
}

const playoutEngine = new PlayoutEngine();
export default playoutEngine;
