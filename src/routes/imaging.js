import express from 'express';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';
import playoutEngine from '../playout/engine.js';

const router = express.Router();

// 1. Get all Imaging Elements
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const items = await prisma.imagingElement.findMany({
      include: {
        track: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(items);
  } catch (error) {
    logger.error('Failed fetching imaging elements: %O', error);
    res.status(500).json({ error: 'Failed to retrieve imaging elements' });
  }
});

// 2. Create/Register a new Imaging Element (Sweeper, ID, Drop, Instant Cart)
router.post('/', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const { name, type, trackId, slotNumber, bpmMin, bpmMax, energyMin, energyMax, mood, playMode } = req.body;

  if (!name || !type || !trackId) {
    return res.status(400).json({ error: 'Name, type, and trackId are required' });
  }

  const validTypes = ['SWEEPER', 'STATION_ID', 'DJ_DROP', 'INSTANT_CART'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }

  try {
    // Verify track exists and is not soft-deleted
    const track = await prisma.track.findUnique({
      where: { id: parseInt(trackId) }
    });

    if (!track || track.isDeleted) {
      return res.status(404).json({ error: 'Assigned audio track not found or has been soft-deleted' });
    }

    // Check if track is already registered to another imaging element
    const existing = await prisma.imagingElement.findUnique({
      where: { trackId: parseInt(trackId) }
    });
    if (existing) {
      return res.status(400).json({ error: 'This audio track is already assigned to another imaging element' });
    }

    // If type is INSTANT_CART, ensure slotNumber is provided
    let slot = slotNumber ? parseInt(slotNumber) : null;
    if (type === 'INSTANT_CART' && !slot) {
      return res.status(400).json({ error: 'slotNumber is required for type INSTANT_CART' });
    }

    const item = await prisma.imagingElement.create({
      data: {
        name,
        type,
        trackId: parseInt(trackId),
        slotNumber: slot,
        bpmMin: bpmMin ? parseFloat(bpmMin) : null,
        bpmMax: bpmMax ? parseFloat(bpmMax) : null,
        energyMin: energyMin ? parseInt(energyMin) : null,
        energyMax: energyMax ? parseInt(energyMax) : null,
        mood: mood || null,
        playMode: playMode || 'OVERLAY'
      },
      include: {
        track: true
      }
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'IMAGING_ELEMENT_CREATED',
        details: `Registered imaging element "${name}" of type ${type}`
      }
    });

    res.status(201).json(item);
  } catch (error) {
    logger.error('Failed to register imaging element: %O', error);
    res.status(500).json({ error: 'Failed to register imaging element' });
  }
});

// 3. Update/Edit an Imaging Element
router.patch('/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const id = req.params.id;
  const { name, type, trackId, slotNumber, isActive, bpmMin, bpmMax, energyMin, energyMax, mood, playMode } = req.body;

  try {
    const item = await prisma.imagingElement.findUnique({ where: { id } });
    if (!item) {
      return res.status(404).json({ error: 'Imaging element not found' });
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (type !== undefined) {
      const validTypes = ['SWEEPER', 'STATION_ID', 'DJ_DROP', 'INSTANT_CART'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      }
      data.type = type;
    }
    if (trackId !== undefined) {
      const track = await prisma.track.findUnique({ where: { id: parseInt(trackId) } });
      if (!track || track.isDeleted) {
        return res.status(404).json({ error: 'Assigned audio track not found or soft-deleted' });
      }
      data.trackId = parseInt(trackId);
    }
    if (slotNumber !== undefined) {
      data.slotNumber = slotNumber ? parseInt(slotNumber) : null;
    }
    if (isActive !== undefined) {
      data.isActive = !!isActive;
    }
    if (bpmMin !== undefined) data.bpmMin = bpmMin ? parseFloat(bpmMin) : null;
    if (bpmMax !== undefined) data.bpmMax = bpmMax ? parseFloat(bpmMax) : null;
    if (energyMin !== undefined) data.energyMin = energyMin ? parseInt(energyMin) : null;
    if (energyMax !== undefined) data.energyMax = energyMax ? parseInt(energyMax) : null;
    if (mood !== undefined) data.mood = mood || null;
    if (playMode !== undefined) data.playMode = playMode || 'OVERLAY';

    const updated = await prisma.imagingElement.update({
      where: { id },
      data,
      include: { track: true }
    });

    res.json(updated);
  } catch (error) {
    logger.error('Failed to update imaging element: %O', error);
    res.status(500).json({ error: 'Failed to update imaging element' });
  }
});

// 4. Delete an Imaging Element
router.delete('/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const id = req.params.id;

  try {
    const item = await prisma.imagingElement.findUnique({
      where: { id }
    });

    if (!item) {
      return res.status(404).json({ error: 'Imaging element not found' });
    }

    await prisma.imagingElement.delete({
      where: { id }
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'IMAGING_ELEMENT_DELETED',
        details: `Deleted imaging element "${item.name}"`
      }
    });

    res.json({ message: 'Imaging element deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete imaging element: %O', error);
    res.status(500).json({ error: 'Failed to delete imaging element' });
  }
});

// 4. Trigger Instant Play of Cart (Layer 4 Overlays)
router.post('/trigger-cart/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const id = req.params.id;

  try {
    const element = await prisma.imagingElement.findUnique({
      where: { id },
      include: { track: true }
    });

    if (!element || element.type !== 'INSTANT_CART') {
      return res.status(404).json({ error: 'Instant Cart element not found' });
    }

    if (element.track.isDeleted) {
      return res.status(400).json({ error: 'The assigned audio track file has been soft-deleted' });
    }

    // Call the playCart method on playoutEngine
    await playoutEngine.playCart(element.track);

    res.json({ message: `Instant Cart "${element.name}" triggered successfully` });
  } catch (error) {
    logger.error('Failed triggering dynamic instant cart: %O', error);
    res.status(500).json({ error: 'Failed to play instant cart' });
  }
});

export default router;
