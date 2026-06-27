import express from 'express';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';
import playoutState from '../playout/state.js';
import playoutEngine from '../playout/engine.js';

const router = express.Router();
const AUTH = [authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ'])];

/**
 * Helper: serialize queue for API responses
 */
function getQueueResponse() {
  return playoutState.upcomingQueue.map((item, index) => ({
    queueId: item.queueId,
    position: index,
    trackId: item.trackId,
    title: item.title,
    artist: item.artist,
    fileType: item.fileType,
    duration: item.duration,
    cueStart: item.cueStart,
    cueEnd: item.cueEnd,
    volumeTrim: item.volumeTrim,
    coverArtUrl: item.fileHash ? `/covers/${item.fileHash}.jpg` : null
  }));
}

// ──────────────────────────────────────────────────────────────
// GET / — Return full playout queue
// ──────────────────────────────────────────────────────────────
router.get('/', ...AUTH, (req, res) => {
  res.json({ queue: getQueueResponse() });
});

// ──────────────────────────────────────────────────────────────
// POST /add — Add a track to the queue
// Body: { trackId: Number, position?: Number }
// ──────────────────────────────────────────────────────────────
router.post('/add', ...AUTH, async (req, res) => {
  const { trackId, position } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId is required' });

  try {
    const track = await prisma.track.findUnique({ where: { id: parseInt(trackId) } });
    if (!track || track.isDeleted) {
      return res.status(404).json({ error: 'Track not found or deleted' });
    }

    const item = playoutState.addToQueue(track, position !== undefined ? parseInt(position) : undefined);
    logger.info('Queue: Added track "%s" at position %s (queueId: %s)', track.title, position ?? 'end', item.queueId);

    res.json({ queue: getQueueResponse() });
  } catch (error) {
    logger.error('Queue add failed: %O', error);
    res.status(500).json({ error: 'Failed to add track to queue' });
  }
});

// ──────────────────────────────────────────────────────────────
// DELETE /:queueId — Remove item from queue
// ──────────────────────────────────────────────────────────────
router.delete('/:queueId', ...AUTH, (req, res) => {
  const queueId = parseInt(req.params.queueId);
  const removed = playoutState.removeFromQueue(queueId);

  if (!removed) {
    return res.status(404).json({ error: 'Queue item not found' });
  }

  logger.info('Queue: Removed item (queueId: %s)', queueId);
  res.json({ queue: getQueueResponse() });
});

// ──────────────────────────────────────────────────────────────
// POST /reorder — Reorder queue by array of queueIds
// Body: { order: [queueId1, queueId2, ...] }
// ──────────────────────────────────────────────────────────────
router.post('/reorder', ...AUTH, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of queueIds' });
  }

  playoutState.reorderQueue(order.map(id => parseInt(id)));
  logger.info('Queue: Reordered (%s items)', order.length);
  res.json({ queue: getQueueResponse() });
});

// ──────────────────────────────────────────────────────────────
// POST /clone/:queueId — Clone a queue item
// ──────────────────────────────────────────────────────────────
router.post('/clone/:queueId', ...AUTH, (req, res) => {
  const queueId = parseInt(req.params.queueId);
  const cloned = playoutState.cloneQueueItem(queueId);

  if (!cloned) {
    return res.status(404).json({ error: 'Queue item not found' });
  }

  logger.info('Queue: Cloned "%s" (new queueId: %s)', cloned.title, cloned.queueId);
  res.json({ queue: getQueueResponse() });
});

// ──────────────────────────────────────────────────────────────
// PATCH /:queueId/cues — Update cue-in / cue-out on queue item
// Body: { cueStart?: Number, cueEnd?: Number }
// ──────────────────────────────────────────────────────────────
router.patch('/:queueId/cues', ...AUTH, (req, res) => {
  const queueId = parseInt(req.params.queueId);
  const { cueStart, cueEnd } = req.body;

  const updated = playoutState.updateQueueItemCues(queueId, { cueStart, cueEnd });
  if (!updated) {
    return res.status(404).json({ error: 'Queue item not found' });
  }

  logger.info('Queue: Updated cues for queueId %s (in: %s, out: %s)', queueId, cueStart, cueEnd);
  res.json({ queue: getQueueResponse() });
});

// ──────────────────────────────────────────────────────────────
// POST /skip — Skip currently playing track
// ──────────────────────────────────────────────────────────────
router.post('/skip', ...AUTH, async (req, res) => {
  try {
    await playoutEngine.skip();
    logger.info('Queue: Skip requested by %s', req.user?.username || 'operator');
    res.json({ success: true, message: 'Track skipped' });
  } catch (error) {
    logger.error('Queue skip failed: %O', error);
    res.status(500).json({ error: 'Failed to skip track' });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /clear — Clear entire queue
// ──────────────────────────────────────────────────────────────
router.post('/clear', ...AUTH, (req, res) => {
  playoutState.upcomingQueue = [];
  logger.info('Queue: Cleared by %s', req.user?.username || 'operator');
  res.json({ success: true, queue: [] });
});

export default router;
