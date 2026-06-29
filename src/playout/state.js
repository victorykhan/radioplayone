// Playout State Manager (Shared in-memory state)
// Each queue item has a unique queueId for drag-reorder, clone, and removal.

let _nextQueueId = 1;

function assignQueueId(item) {
  return {
    queueId: _nextQueueId++,
    trackId: item.id || item.trackId,
    title: item.title,
    artist: item.artist,
    fileType: item.fileType,
    duration: item.duration,
    filePath: item.filePath,
    fileHash: item.fileHash,
    cueStart: item.cueStart ?? 0,
    cueEnd: item.cueEnd ?? item.duration,
    volumeTrim: item.volumeTrim ?? 1.0,
    fadeDuration: item.fadeDuration ?? null,
    isInterrupted: item.isInterrupted ?? false,
    isSwappedNext: item.isSwappedNext ?? false
  };
}

class PlayoutStateManager {
  constructor() {
    this.currentTrack = null;    // Active Track metadata model
    this.startedAt = null;       // DateTime timestamp when track started
    this.elapsedSeconds = 0;     // Current track progress in seconds
    this.upcomingQueue = [];     // Array of upcoming track models (with queueId)
    this.history = [];           // Recently played tracks (last 20)
    this.playoutMode = 'AUTO';   // Playout Mode: AUTO, MANUAL, PLAYLIST
    this.activePlaylistId = null; // ID of currently executing playlist
    this.activePlaylistIndex = 0; // Current track position in active playlist
    this.activePlaylistTracks = []; // Cached array of tracks in the currently active playlist
    this.fallbackTracks = [];       // Cached array of tracks in fallback pools
    this.lastScheduledTriggerTime = null; // HH:MM of last triggered scheduled playlist
    
    // Playback control states
    this.isPaused = false;
    this.pausedElapsed = 0;
    this.isStopped = false;
    this.interruptedTrack = null;
    this.interruptedElapsed = 0;
    this.fallbackPlaylistIndex = 0;
  }

  setCurrentTrack(track) {
    if (this.currentTrack) {
      // Append current track to history log only if not AD or PROMO
      if (this.currentTrack.fileType !== 'AD' && this.currentTrack.fileType !== 'PROMO') {
        this.history.unshift({
          id: this.currentTrack.id,
          title: this.currentTrack.title,
          artist: this.currentTrack.artist,
          fileType: this.currentTrack.fileType,
          playedAt: this.startedAt,
          coverArtUrl: `/covers/${this.currentTrack.fileHash}.jpg`
        });
        if (this.history.length > 20) {
          this.history.pop();
        }
      }
    }
    this.currentTrack = track;
    this.startedAt = new Date();
    this.elapsedSeconds = 0;
  }

  /**
   * Bulk-replace the queue (used by auto-populate).
   * Assigns a unique queueId to each item.
   */
  setUpcomingQueue(queue) {
    this.upcomingQueue = (queue || []).map(item => {
      // If item already has a queueId, keep it
      if (item.queueId) return item;
      return assignQueueId(item);
    });
  }

  /**
   * Add a single track to the queue at an optional position.
   * Returns the new queue item with its queueId.
   */
  addToQueue(track, position) {
    const item = assignQueueId(track);
    if (position !== undefined && position !== null && position >= 0 && position < this.upcomingQueue.length) {
      this.upcomingQueue.splice(position, 0, item);
    } else {
      this.upcomingQueue.push(item);
    }
    return item;
  }

  /**
   * Remove a queue item by its queueId.
   * Returns true if found and removed.
   */
  removeFromQueue(queueId) {
    const idx = this.upcomingQueue.findIndex(i => i.queueId === queueId);
    if (idx === -1) return false;
    this.upcomingQueue.splice(idx, 1);
    return true;
  }

  /**
   * Reorder the queue based on an array of queueIds.
   * Items not in the array are appended at the end.
   */
  reorderQueue(orderedQueueIds) {
    const idMap = new Map(this.upcomingQueue.map(item => [item.queueId, item]));
    const reordered = [];

    for (const qid of orderedQueueIds) {
      const item = idMap.get(qid);
      if (item) {
        reordered.push(item);
        idMap.delete(qid);
      }
    }

    // Append any items that weren't in the ordered list
    for (const remaining of idMap.values()) {
      reordered.push(remaining);
    }

    this.upcomingQueue = reordered;
  }

  /**
   * Clone a queue item, inserting the duplicate immediately after the original.
   * Returns the cloned item or null if not found.
   */
  cloneQueueItem(queueId) {
    const idx = this.upcomingQueue.findIndex(i => i.queueId === queueId);
    if (idx === -1) return null;

    const original = this.upcomingQueue[idx];
    const clone = {
      queueId: _nextQueueId++,
      trackId: original.trackId,
      title: original.title,
      artist: original.artist,
      fileType: original.fileType,
      duration: original.duration,
      filePath: original.filePath,
      fileHash: original.fileHash,
      cueStart: original.cueStart,
      cueEnd: original.cueEnd,
      volumeTrim: original.volumeTrim,
      fadeDuration: original.fadeDuration
    };

    this.upcomingQueue.splice(idx + 1, 0, clone);
    return clone;
  }

  /**
   * Update cue-in and cue-out points on a specific queue item.
   * Returns true if found and updated.
   */
  updateQueueItemCues(queueId, { cueStart, cueEnd }) {
    const item = this.upcomingQueue.find(i => i.queueId === queueId);
    if (!item) return false;

    if (cueStart !== undefined && cueStart !== null) item.cueStart = parseFloat(cueStart);
    if (cueEnd !== undefined && cueEnd !== null) item.cueEnd = parseFloat(cueEnd);
    return true;
  }

  /**
   * Pop and return the first item from the queue (engine uses this to get next track).
   * Returns null if queue is empty.
   */
  shiftQueue() {
    if (this.upcomingQueue.length === 0) return null;
    return this.upcomingQueue.shift();
  }

  setPlayoutMode(mode) {
    this.playoutMode = mode; // AUTO, MANUAL, PLAYLIST
  }

  getNowPlaying() {
    if (!this.currentTrack) {
      return { 
        now_playing: null, 
        up_next: this._serializeQueue(),
        isPaused: this.isPaused,
        isStopped: this.isStopped
      };
    }

    const elapsed = this.isPaused 
      ? this.pausedElapsed 
      : Math.round((new Date() - this.startedAt) / 1000);
    this.elapsedSeconds = elapsed;

    return {
      now_playing: {
        id: this.currentTrack.id,
        title: this.currentTrack.title,
        artist: this.currentTrack.artist,
        duration: this.currentTrack.duration,
        fileType: this.currentTrack.fileType,
        started_at: this.startedAt,
        elapsed: Math.min(elapsed, Math.round(this.currentTrack.duration)),
        coverArtUrl: `/covers/${this.currentTrack.fileHash}.jpg`,
        playoutSource: this.currentTrack.playoutSource || 'Auto-Scheduler'
      },
      up_next: this._serializeQueue(),
      isPaused: this.isPaused,
      isStopped: this.isStopped
    };
  }

  /**
   * Serialize queue for API responses — includes all fields needed by the frontend.
   */
  _serializeQueue() {
    if (this.upcomingQueue && this.upcomingQueue.length > 0) {
      return this.upcomingQueue.map((item, index) => ({
        queueId: item.queueId,
        position: index,
        id: item.trackId,
        title: item.title,
        artist: item.artist,
        fileType: item.fileType,
        duration: item.duration,
        cueStart: item.cueStart,
        cueEnd: item.cueEnd,
        isInterrupted: item.isInterrupted || false,
        isSwappedNext: item.isSwappedNext || false,
        coverArtUrl: item.fileHash ? `/covers/${item.fileHash}.jpg` : null
      }));
    }

    const predicted = [];
    
    // 1. Resolve upcoming tracks from active playlist/show
    if (this.activePlaylistId && this.activePlaylistTracks && this.activePlaylistTracks.length > 0) {
      let idx = this.activePlaylistIndex;
      for (let i = 0; i < 10; i++) {
        if (idx < this.activePlaylistTracks.length) {
          predicted.push(this.activePlaylistTracks[idx]);
          idx++;
        } else {
          break;
        }
      }
    }

    // 2. Fall back to fallback pool tracks if we don't have enough tracks predicted
    if (predicted.length < 5 && this.fallbackTracks && this.fallbackTracks.length > 0) {
      let fallbackIdx = this.fallbackPlaylistIndex;
      while (predicted.length < 10) {
        const track = this.fallbackTracks[fallbackIdx % this.fallbackTracks.length];
        predicted.push(track);
        fallbackIdx++;
      }
    }

    // Serialize predicted tracks
    return predicted.map((track, index) => ({
      queueId: `pred-${index}`,
      position: index,
      id: track.id,
      title: track.title,
      artist: track.artist,
      fileType: track.fileType,
      duration: track.duration,
      cueStart: track.cueStart || 0,
      cueEnd: track.cueEnd || track.duration,
      isInterrupted: false,
      isSwappedNext: false,
      coverArtUrl: track.fileHash ? `/covers/${track.fileHash}.jpg` : null
    }));
  }
}

const playoutState = new PlayoutStateManager();
export default playoutState;
