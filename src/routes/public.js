import express from 'express';
import jwt from 'jsonwebtoken';
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
  np.live_dj_active = playoutEngine.isDJLive;

  // Determine if requester is an authenticated operator (admin/producer/DJ)
  let showAll = false;
  const token = (req.headers.authorization && req.headers.authorization.split(' ')[1]) || req.query.token;
  if (token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET || 'your-fallback-secret-key-change-this');
      showAll = true;
    } catch (e) {
      // Invalid token, treat as public
    }
  }

  // Mask AD/PROMO track types from the public streams unless authenticated operator
  if (!showAll) {
    if (np.now_playing && (np.now_playing.fileType === 'AD' || np.now_playing.fileType === 'PROMO')) {
      np.now_playing = null;
    }
    if (np.up_next) {
      np.up_next = np.up_next.filter(item => item.fileType !== 'AD' && item.fileType !== 'PROMO');
    }
  }

  res.json(np);
});

// 2. Play history log (CORS-enabled public API)
router.get('/history', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const filteredHistory = playoutState.history.filter(item => item.fileType !== 'AD' && item.fileType !== 'PROMO');
  res.json(filteredHistory);
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
