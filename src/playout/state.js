// Playout State Manager (Shared in-memory state)
class PlayoutStateManager {
  constructor() {
    this.currentTrack = null;    // Active Track metadata model
    this.startedAt = null;       // DateTime timestamp when track started
    this.elapsedSeconds = 0;     // Current track progress in seconds
    this.upcomingQueue = [];     // Array of upcoming track models
    this.history = [];           // Recently played tracks (last 10)
    this.playoutMode = 'AUTO';   // Playout Mode: AUTO, MANUAL, PLAYLIST
    this.activePlaylistId = null; // ID of currently executing playlist
  }

  setCurrentTrack(track) {
    if (this.currentTrack) {
      // Append current track to history log
      this.history.unshift({
        id: this.currentTrack.id,
        title: this.currentTrack.title,
        artist: this.currentTrack.artist,
        fileType: this.currentTrack.fileType,
        playedAt: this.startedAt
      });
      if (this.history.length > 20) {
        this.history.pop();
      }
    }
    this.currentTrack = track;
    this.startedAt = new Date();
    this.elapsedSeconds = 0;
  }

  setUpcomingQueue(queue) {
    this.upcomingQueue = queue;
  }

  setPlayoutMode(mode) {
    this.playoutMode = mode; // AUTO, MANUAL, PLAYLIST
  }

  getNowPlaying() {
    if (!this.currentTrack) {
      return { now_playing: null, up_next: this.upcomingQueue };
    }

    const elapsed = Math.round((new Date() - this.startedAt) / 1000);
    this.elapsedSeconds = elapsed;

    return {
      now_playing: {
        id: this.currentTrack.id,
        title: this.currentTrack.title,
        artist: this.currentTrack.artist,
        duration: this.currentTrack.duration,
        started_at: this.startedAt,
        elapsed: Math.min(elapsed, Math.round(this.currentTrack.duration)),
        coverArtUrl: `/covers/${this.currentTrack.fileHash}.jpg`
      },
      up_next: this.upcomingQueue.map(item => ({
        id: item.id,
        title: item.title,
        artist: item.artist,
        fileType: item.fileType
      }))
    };
  }
}

const playoutState = new PlayoutStateManager();
export default playoutState;
