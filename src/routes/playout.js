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

// Set master output volume (Admin/Producer/DJ)
router.post('/volume', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const { volume } = req.body; // 0–100 integer from client
  if (volume === undefined || isNaN(volume) || volume < 0 || volume > 100) {
    return res.status(400).json({ error: 'volume must be a number 0–100' });
  }
  try {
    // Liquidsoap uses amplify factor: 1.0 = 100%, 0.0 = mute
    const amplify = (parseFloat(volume) / 100).toFixed(4);
    await playoutEngine.setVolume(amplify);
    res.json({ message: `Master volume set to ${volume}%`, amplify });
  } catch (error) {
    logger.error('Failed to set master volume: %O', error);
    res.status(500).json({ error: 'Failed to set volume' });
  }
});

// Manually Load Track into Playout Queue (Up Next) (Admin/Producer/DJ)
router.post('/load-track', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId is required' });

  try {
    const track = await prisma.track.findUnique({ where: { id: parseInt(trackId) } });
    if (!track || track.isDeleted) {
      return res.status(404).json({ error: 'Track not found or deleted' });
    }

    // Append track to playout manual queue
    playoutState.addToQueue(track);
    res.json({ message: `Queued track "${track.title}" in Up Next successfully` });
  } catch (error) {
    logger.error('Failed to manually queue track: %O', error);
    res.status(500).json({ error: 'Failed to queue track' });
  }
});

// Manually Load Playlist into Playout Queue (Up Next) (Admin/Producer/DJ)
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

    // Append all tracks of playlist sequentially to playout manual queue
    playlist.tracks.forEach(pt => {
      if (pt.track && !pt.track.isDeleted) {
        playoutState.addToQueue(pt.track);
      }
    });

    res.json({ message: `Queued playlist "${playlist.name}" (${playlist.tracks.length} tracks) in Up Next` });
  } catch (error) {
    logger.error('Failed to manually queue playlist: %O', error);
    res.status(500).json({ error: 'Failed to queue playlist' });
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
    res.json({ message: `Triggered Cart ${slot}: "${cart.track.title}"`, trackId: cart.track.id });

  } catch (error) {
    logger.error('Failed to trigger instant cart: %O', error);
    res.status(500).json({ error: 'Failed to trigger instant cart audio' });
  }
});

// Local endpoint queried by Liquidsoap to fetch the next imaging/sweeper path
router.get('/next-imaging-path', async (req, res) => {
  try {
    const track = await playoutEngine.fetchNextImagingForLiquidsoap();
    if (!track) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      return res.send('');
    }
    
    const cueIn = track.cueStart || 0;
    const cueOut = track.cueEnd || track.duration || 0;
    const volume = track.volumeTrim || 1.0;
    
    const annotatedPath = `annotate:liq_cue_in=${cueIn.toFixed(2)},liq_cue_out=${cueOut.toFixed(2)},liq_amplify=${volume.toFixed(2)}:/home/ubuntu/radioplayone/storage/${track.filePath}`;
    
    logger.info(`Liquidsoap imaging fetch: ${annotatedPath}`);
    res.send(annotatedPath);
  } catch (error) {
    logger.error('Failed to get next imaging track for Liquidsoap: %O', error);
    res.status(500).send('error');
  }
});

// Local endpoint queried by Liquidsoap to fetch the next track path
router.get('/next-track-path', async (req, res) => {
  try {
    const track = await playoutEngine.fetchNextTrackForLiquidsoap();
    if (!track) {
      // Delay response by 3 seconds to prevent Liquidsoap tight-loop polling
      await new Promise(resolve => setTimeout(resolve, 3000));
      return res.send('');
    }
    
    const cueIn = track.cueStart || 0;
    const cueOut = track.cueEnd || track.duration || 0;
    const volume = track.volumeTrim || 1.0;
    
    // Construct annotated string for Liquidsoap
    const annotatedPath = `annotate:liq_cue_in=${cueIn.toFixed(2)},liq_cue_out=${cueOut.toFixed(2)},liq_amplify=${volume.toFixed(2)}:/home/ubuntu/radioplayone/storage/${track.filePath}`;
    
    logger.info(`Liquidsoap fetch: ${annotatedPath}`);
    res.send(annotatedPath);
  } catch (error) {
    logger.error('Failed to get next track for Liquidsoap: %O', error);
    res.status(500).send('error');
  }
});

// Local endpoint queried by Liquidsoap when a track begins playing
router.post('/track-started', async (req, res) => {
  try {
    await playoutEngine.onTrackStartedInLiquidsoap();
    res.json({ status: 'ok' });
  } catch (error) {
    logger.error('Failed to handle Liquidsoap track-started event: %O', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 9. Instant Track Swap
router.post('/instant-swap', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const { trackId } = req.body;

  if (!trackId) {
    return res.status(400).json({ error: 'trackId is required to swap the live track' });
  }

  try {
    const result = await playoutEngine.instantSwapTrack(trackId);
    res.json(result);
  } catch (error) {
    logger.error('Failed to trigger instant track swap: %O', error);
    res.status(500).json({ error: error.message || 'Failed to trigger instant swap' });
  }
});

export default router;
