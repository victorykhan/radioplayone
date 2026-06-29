import express from 'express';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';
import { getStationTimezone, convertToUTC, formatUTCToTimezone } from '../utils/timezone.js';

const router = express.Router();

// 1. List playlists with track counts and durations
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const playlists = await prisma.playlist.findMany({
      include: {
        _count: {
          select: { tracks: true }
        }
      }
    });
    res.json(playlists);
  } catch (error) {
    logger.error('Failed to list playlists: %O', error);
    res.status(500).json({ error: 'Failed to retrieve playlists' });
  }
});

// 2. Get single playlist detail (with ordered tracks)
router.get('/:id', authenticateJWT, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const playlist = await prisma.playlist.findUnique({
      where: { id },
      include: {
        tracks: {
          orderBy: { position: 'asc' },
          include: {
            track: true
          }
        }
      }
    });

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    res.json(playlist);
  } catch (error) {
    logger.error('Failed to get playlist: %O', error);
    res.status(500).json({ error: 'Failed to retrieve playlist details' });
  }
});

// 3. Create playlist
router.post('/', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const { name, isScheduled, scheduleTime, isLooping, isFallbackPool } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Playlist name is required' });
  }

  try {
    const playlist = await prisma.playlist.create({
      data: {
        name,
        isScheduled: !!isScheduled,
        scheduleTime: scheduleTime || null,
        isLooping: isLooping !== undefined ? !!isLooping : true,
        isFallbackPool: !!isFallbackPool
      }
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'PLAYLIST_CREATED',
        details: `Created playlist: ${name}`
      }
    });

    res.status(201).json(playlist);
  } catch (error) {
    logger.error('Failed to create playlist: %O', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// 4. Update playlist info (name, schedule, looping status)
router.patch('/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, isScheduled, scheduleTime, isLooping, isFallbackPool } = req.body;

  try {
    const playlist = await prisma.playlist.findUnique({ where: { id } });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const updated = await prisma.playlist.update({
      where: { id },
      data: {
        name: name !== undefined ? name : playlist.name,
        isScheduled: isScheduled !== undefined ? !!isScheduled : playlist.isScheduled,
        scheduleTime: scheduleTime !== undefined ? scheduleTime : playlist.scheduleTime,
        isLooping: isLooping !== undefined ? !!isLooping : playlist.isLooping,
        isFallbackPool: isFallbackPool !== undefined ? !!isFallbackPool : playlist.isFallbackPool
      }
    });

    res.json(updated);
  } catch (error) {
    logger.error('Failed to update playlist: %O', error);
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

// 5. Append tracks to a playlist
router.post('/:id/tracks', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const playlistId = parseInt(req.params.id);
  const { trackIds } = req.body; // Array of track IDs to add

  if (!trackIds || !Array.isArray(trackIds)) {
    return res.status(400).json({ error: 'trackIds array is required' });
  }

  try {
    const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Get current maximum position in playlist
    const maxPositionRecord = await prisma.playlistTrack.findFirst({
      where: { playlistId },
      orderBy: { position: 'desc' }
    });

    let currentPos = maxPositionRecord ? maxPositionRecord.position + 1 : 0;
    const addedTracks = [];
    let playlistDurationDelta = 0.0;

    for (const trackId of trackIds) {
      const track = await prisma.track.findUnique({ where: { id: parseInt(trackId) } });
      if (!track || track.isDeleted || track.fileType !== 'SONG') continue;

      const playlistTrack = await prisma.playlistTrack.create({
        data: {
          playlistId,
          trackId: track.id,
          position: currentPos++
        }
      });

      playlistDurationDelta += track.duration;
      addedTracks.push(playlistTrack);
    }

    // Update total playlist duration
    await prisma.playlist.update({
      where: { id: playlistId },
      data: {
        duration: {
          increment: playlistDurationDelta
        }
      }
    });

    res.json({ message: 'Tracks added to playlist', addedTracks });

  } catch (error) {
    logger.error('Failed adding tracks to playlist: %O', error);
    res.status(500).json({ error: 'Failed to add tracks' });
  }
});

// 6. Remove a track from playlist (and re-index positions)
router.delete('/:id/tracks/:playlistTrackId', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const playlistId = parseInt(req.params.id);
  const playlistTrackId = parseInt(req.params.playlistTrackId);

  try {
    const pt = await prisma.playlistTrack.findUnique({
      where: { id: playlistTrackId },
      include: { track: true }
    });

    if (!pt || pt.playlistId !== playlistId) {
      return res.status(404).json({ error: 'Track not found in this playlist' });
    }

    // Remove the junction record
    await prisma.playlistTrack.delete({ where: { id: playlistTrackId } });

    // Re-index remaining track positions to keep 0, 1, 2... ordering without gaps
    const remainingTracks = await prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: 'asc' }
    });

    let positionCounter = 0;
    for (const item of remainingTracks) {
      await prisma.playlistTrack.update({
        where: { id: item.id },
        data: { position: positionCounter++ }
      });
    }

    // Update playlist total duration
    await prisma.playlist.update({
      where: { id: playlistId },
      data: {
        duration: {
          decrement: pt.track.duration
        }
      }
    });

    res.json({ message: 'Track removed and positions reindexed' });

  } catch (error) {
    logger.error('Failed to remove track from playlist: %O', error);
    res.status(500).json({ error: 'Failed to remove track' });
  }
});

// 7. Bulk reorder playlist tracks
router.put('/:id/reorder', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const playlistId = parseInt(req.params.id);
  const { trackOrder } = req.body; // Array of { playlistTrackId: number, position: number }

  if (!trackOrder || !Array.isArray(trackOrder)) {
    return res.status(400).json({ error: 'trackOrder array is required' });
  }

  try {
    const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Perform transaction to prevent duplicates / conflicts during mid-run reordering
    await prisma.$transaction(
      trackOrder.map(item => 
        prisma.playlistTrack.update({
          where: { id: parseInt(item.playlistTrackId), playlistId },
          data: { position: parseInt(item.position) }
        })
      )
    );

    res.json({ message: 'Playlist tracks reordered successfully' });

  } catch (error) {
    logger.error('Failed reordering playlist: %O', error);
    res.status(500).json({ error: 'Failed to reorder playlist tracks' });
  }
});

// 8. Delete playlist
router.delete('/:id', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const playlist = await prisma.playlist.findUnique({ where: { id } });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    await prisma.playlist.delete({ where: { id } });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'PLAYLIST_DELETED',
        details: `Deleted playlist: ${playlist.name}`
      }
    });

    res.json({ message: 'Playlist deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete playlist: %O', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// === SCHEDULE SLOT CALENDAR ROUTES ===

// 9. List scheduled slots mapped back to station timezone
router.get('/schedules/slots', authenticateJWT, async (req, res) => {
  try {
    const tz = await getStationTimezone();
    const slots = await prisma.scheduleSlot.findMany({
      include: {
        playlist: {
          select: { name: true }
        }
      },
      orderBy: { startAt: 'asc' }
    });

    const mapped = slots.map(s => ({
      id: s.id,
      playlistId: s.playlistId,
      playlistName: s.playlist.name,
      startAt: formatUTCToTimezone(s.startAt, tz),
      endAt: formatUTCToTimezone(s.endAt, tz),
      createdAt: s.createdAt
    }));

    res.json(mapped);
  } catch (error) {
    logger.error('Failed listing schedule slots: %O', error);
    res.status(500).json({ error: 'Failed to retrieve schedule slots' });
  }
});

// 10. Add a schedule slot (converts station timezone inputs to UTC)
router.post('/schedules/slots', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const { playlistId, startAt, endAt } = req.body;

  if (!playlistId || !startAt || !endAt) {
    return res.status(400).json({ error: 'playlistId, startAt, and endAt are required' });
  }

  try {
    const tz = await getStationTimezone();
    
    // Parse client date-times relative to target timezone and convert to UTC
    const startUTC = convertToUTC(startAt, tz);
    const endUTC = convertToUTC(endAt, tz);

    if (startUTC >= endUTC) {
      return res.status(400).json({ error: 'Start time must be before end time' });
    }

    // Check for overlap in scheduled slots
    const overlap = await prisma.scheduleSlot.findFirst({
      where: {
        OR: [
          {
            startAt: { lte: startUTC },
            endAt: { gte: startUTC }
          },
          {
            startAt: { lte: endUTC },
            endAt: { gte: endUTC }
          },
          {
            startAt: { gte: startUTC },
            endAt: { lte: endUTC }
          }
        ]
      }
    });

    if (overlap) {
      return res.status(400).json({ error: 'Schedule slot overlaps with an existing slot.' });
    }

    const slot = await prisma.scheduleSlot.create({
      data: {
        playlistId: parseInt(playlistId),
        startAt: startUTC,
        endAt: endUTC
      }
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'SCHEDULE_SLOT_CREATED',
        details: `Scheduled playlist ID ${playlistId} from ${startAt} to ${endAt} (${tz})`
      }
    });

    res.status(201).json(slot);
  } catch (error) {
    logger.error('Failed to create schedule slot: %O', error);
    res.status(500).json({ error: 'Failed to create schedule slot' });
  }
});

// 11. Delete a schedule slot
router.delete('/schedules/slots/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const id = req.params.id;

  try {
    const slot = await prisma.scheduleSlot.findUnique({
      where: { id },
      include: { playlist: true }
    });

    if (!slot) {
      return res.status(404).json({ error: 'Schedule slot not found' });
    }

    await prisma.scheduleSlot.delete({ where: { id } });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'SCHEDULE_SLOT_DELETED',
        details: `Deleted scheduled slot for playlist: ${slot.playlist.name}`
      }
    });

    res.json({ message: 'Schedule slot deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete schedule slot: %O', error);
    res.status(500).json({ error: 'Failed to delete schedule slot' });
  }
});

export default router;
