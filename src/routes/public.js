import express from 'express';
import playoutState from '../playout/state.js';
import prisma from '../db.js';
import logger from '../logger.js';

import playoutEngine from '../playout/engine.js';

const router = express.Router();

// 1. Now Playing and upcoming queue (CORS-enabled public API)
router.get('/now-playing', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // Enable CORS for external websites
  res.setHeader('Content-Type', 'application/json');
  const np = playoutState.getNowPlaying();
  np.isSourceConnected = playoutEngine.isSourceConnected;
  res.json(np);
});

// 2. Play history log (CORS-enabled public API)
router.get('/history', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(playoutState.history);
});

// 3. Weekly EPG Programming Schedule
router.get('/schedule', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    // Fetch all scheduled playlists
    const playlists = await prisma.playlist.findMany({
      where: { isScheduled: true },
      orderBy: { scheduleTime: 'asc' },
      select: {
        id: true,
        name: true,
        scheduleTime: true,
        duration: true
      }
    });

    res.json(playlists.map(pl => ({
      playlistId: pl.id,
      programName: pl.name,
      airTime: pl.scheduleTime,
      durationMinutes: Math.round(pl.duration / 60)
    })));

  } catch (error) {
    logger.error('Failed retrieving public schedule: %O', error);
    res.status(500).json({ error: 'Failed to retrieve program schedule' });
  }
});

export default router;
