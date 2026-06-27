import express from 'express';
import prisma from '../db.js';
import playoutEngine from '../playout/engine.js';
import playoutState from '../playout/state.js';
import { authenticateJWT, requireRole } from './auth.js';
import logger from '../logger.js';

const router = express.Router();

router.post('/start', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), (req, res) => {
  try {
    if (playoutState.isPaused) {
      playoutEngine.resume();
    } else {
      playoutState.isStopped = false;
      playoutState.isPaused = false;
      playoutEngine.skip();
    }
    res.json({ message: 'Playout started successfully' });
  } catch (error) {
    logger.error('Failed to start playout: %O', error);
    res.status(500).json({ error: 'Failed to start playout engine' });
  }
});

// 1. Playout Controls (Admin/Producer/DJ)
router.post('/stop', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), (req, res) => {
  try {
    playoutEngine.stop();
    res.json({ message: 'Playout stopped successfully' });
  } catch (error) {
    logger.error('Failed to stop playout: %O', error);
    res.status(500).json({ error: 'Failed to stop playout engine' });
  }
});

router.post('/pause', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), (req, res) => {
  try {
    playoutEngine.pause();
    res.json({ message: 'Playout paused successfully' });
  } catch (error) {
    logger.error('Failed to pause playout: %O', error);
    res.status(500).json({ error: 'Failed to pause playout engine' });
  }
});

router.post('/resume', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), (req, res) => {
  try {
    playoutEngine.resume();
    res.json({ message: 'Playout resumed successfully' });
  } catch (error) {
    logger.error('Failed to resume playout: %O', error);
    res.status(500).json({ error: 'Failed to resume playout engine' });
  }
});

// Disconnect from Icecast (Admin/Producer only)
router.post('/disconnect', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), (req, res) => {
  try {
    playoutEngine.disconnect();
    res.json({ message: 'Disconnected master encoder source from Icecast successfully' });
  } catch (error) {
    logger.error('Failed to disconnect playout source: %O', error);
    res.status(500).json({ error: 'Failed to disconnect source' });
  }
});

// Connect to Icecast (Admin/Producer only)
router.post('/connect', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  try {
    await playoutEngine.connect();
    res.json({ message: 'Reconnected master encoder source to Icecast successfully' });
  } catch (error) {
    logger.error('Failed to connect playout source: %O', error);
    res.status(500).json({ error: 'Failed to connect source' });
  }
});

// Manually Load and Play single Track in Active Deck instantly (Admin/Producer/DJ)
router.post('/load-track', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId is required' });

  try {
    const track = await prisma.track.findUnique({ where: { id: parseInt(trackId) } });
    if (!track || track.isDeleted) {
      return res.status(404).json({ error: 'Track not found or deleted' });
    }

    if (playoutEngine.playoutTimeout) {
      clearTimeout(playoutEngine.playoutTimeout);
      playoutEngine.playoutTimeout = null;
    }
    if (playoutEngine.currentDecoder) {
      playoutEngine.currentDecoder.kill();
      playoutEngine.currentDecoder = null;
    }

    playoutState.isStopped = false;
    playoutState.isPaused = false;
    playoutState.pausedElapsed = 0;

    playoutState.activePlaylistId = null;
    playoutState.activePlaylistIndex = 0;

    playoutEngine.play(track);
    res.json({ message: `Manually loaded track "${track.title}" into playout deck` });
  } catch (error) {
    logger.error('Failed to manually load track: %O', error);
    res.status(500).json({ error: 'Failed to load track into deck' });
  }
});

// Manually Load and Start Playlist rotation instantly (Admin/Producer/DJ)
router.post('/load-playlist', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const { playlistId } = req.body;
  if (!playlistId) return res.status(400).json({ error: 'playlistId is required' });

  try {
    const playlist = await prisma.playlist.findUnique({
      where: { id: parseInt(playlistId) },
      include: {
        tracks: {
          orderBy: { position: 'asc' },
          include: { track: true }
        }
      }
    });

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    if (!playlist.tracks || playlist.tracks.length === 0) {
      return res.status(400).json({ error: 'Selected playlist is empty' });
    }

    if (playoutEngine.playoutTimeout) {
      clearTimeout(playoutEngine.playoutTimeout);
      playoutEngine.playoutTimeout = null;
    }
    if (playoutEngine.currentDecoder) {
      playoutEngine.currentDecoder.kill();
      playoutEngine.currentDecoder = null;
    }

    playoutState.isStopped = false;
    playoutState.isPaused = false;
    playoutState.pausedElapsed = 0;

    playoutState.activePlaylistId = playlist.id;
    playoutState.activePlaylistIndex = 0;
    
    const firstPlaylistTrack = playlist.tracks[0].track;
    playoutEngine.play(firstPlaylistTrack);

    res.json({ message: `Manually loaded playlist "${playlist.name}" into deck` });
  } catch (error) {
    logger.error('Failed to manually load playlist: %O', error);
    res.status(500).json({ error: 'Failed to load playlist into deck' });
  }
});

// 2. Instant Carts Configuration & Listing
router.get('/cart', authenticateJWT, async (req, res) => {
  try {
    const carts = await prisma.instantCart.findMany({
      include: { track: true },
      orderBy: { slot: 'asc' }
    });
    res.json(carts);
  } catch (error) {
    logger.error('Failed to list instant carts: %O', error);
    res.status(500).json({ error: 'Failed to fetch instant carts config' });
  }
});

router.post('/cart', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const { slot, trackId } = req.body;

  if (!slot || slot < 1 || slot > 6) {
    return res.status(400).json({ error: 'Invalid slot index. Must be 1 to 6.' });
  }

  try {
    const track = await prisma.track.findUnique({
      where: { id: parseInt(trackId) }
    });

    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const cart = await prisma.instantCart.upsert({
      where: { slot: parseInt(slot) },
      update: { trackId: parseInt(trackId) },
      create: { slot: parseInt(slot), trackId: parseInt(trackId) },
      include: { track: true }
    });

    res.json({ message: `Instant Cart slot ${slot} configured successfully`, cart });
  } catch (error) {
    logger.error('Failed to configure instant cart slot: %O', error);
    res.status(500).json({ error: 'Failed to save instant cart configuration' });
  }
});

// 3. Trigger Instant Cart
router.post('/cart/:slot/trigger', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const slot = parseInt(req.params.slot);

  if (isNaN(slot) || slot < 1 || slot > 6) {
    return res.status(400).json({ error: 'Invalid slot' });
  }

  try {
    const cart = await prisma.instantCart.findUnique({
      where: { slot },
      include: { track: true }
    });

    if (!cart) {
      return res.status(404).json({ error: `Instant Cart slot ${slot} is not configured yet.` });
    }

    // Trigger cart playout
    await playoutEngine.playCart(cart.track);
    res.json({ message: `Triggered Cart ${slot}: "${cart.track.title}"` });

  } catch (error) {
    logger.error('Failed to trigger instant cart: %O', error);
    res.status(500).json({ error: 'Failed to trigger instant cart audio' });
  }
});

export default router;
