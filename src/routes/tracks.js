import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';
import { processAudioFile } from '../lib/audioProcessor.js';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getRandomDefaultCover() {
  const defaultsDir = path.join(__dirname, '../../public/covers/defaults');
  if (fs.existsSync(defaultsDir)) {
    const existing = [];
    for (let slot = 1; slot <= 5; slot++) {
      if (fs.existsSync(path.join(defaultsDir, `default-${slot}.jpg`))) {
        existing.push(`/covers/defaults/default-${slot}.jpg`);
      }
    }
    if (existing.length > 0) {
      const idx = Math.floor(Math.random() * existing.length);
      return existing[idx];
    }
  }
  return '/covers/default-vinyl.svg';
}

const router = express.Router();

// Multer upload configurations (to a temporary uploads directory)
const uploadDir = path.join(__dirname, '../../storage/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.flac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Only audio files are allowed: ${allowedTypes.join(', ')}`));
    }
  }
});

const uploadImage = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Only images are allowed: ${allowedTypes.join(', ')}`));
    }
  }
});

// Helper to partition track paths to avoid directory saturation
const getTrackDestPath = (fileHash, ext) => {
  const prefix1 = fileHash.substring(0, 2);
  const prefix2 = fileHash.substring(2, 4);
  const destDir = path.join(__dirname, '../../storage/tracks', prefix1, prefix2);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  return {
    dir: destDir,
    fullPath: path.join(destDir, `${fileHash}${ext}`),
    relative: `/tracks/${prefix1}/${prefix2}/${fileHash}${ext}`
  };
};

// 1. Single Track Ingestion - Initial Parse Step
router.post('/upload', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  const tempFilePath = req.file.path;

  try {
    // Process audio (calculate hash, extract metadata)
    const audioData = await processAudioFile(tempFilePath);
    
    // Check if the track already exists in database
    const existingTrack = await prisma.track.findUnique({
      where: { fileHash: audioData.fileHash }
    });

    if (existingTrack) {
      // Remove temp file
      fs.unlinkSync(tempFilePath);
      return res.status(409).json({ 
        error: 'Duplicate track found in library',
        track: existingTrack
      });
    }

    // Parse filename fallback if title is missing
    let resolvedTitle = audioData.title;
    let resolvedArtist = audioData.artist;
    
    if (!resolvedTitle) {
      // Extract from filename: "Artist - Title.mp3"
      const nameWithoutExt = path.basename(req.file.originalname, path.extname(req.file.originalname));
      const parts = nameWithoutExt.split('-');
      if (parts.length > 1) {
        resolvedArtist = parts[0].trim();
        resolvedTitle = parts.slice(1).join('-').trim();
      } else {
        resolvedTitle = nameWithoutExt.trim();
        resolvedArtist = 'Unknown Artist';
      }
    }

    res.json({
      tempFileId: req.file.filename,
      metadata: {
        title: resolvedTitle,
        artist: resolvedArtist,
        album: audioData.album || '',
        duration: audioData.duration,
        fileHash: audioData.fileHash,
        fileType: 'SONG',
        hasEmbeddedPicture: !!audioData.picture
      }
    });

  } catch (error) {
    logger.error('Error during single upload processing: %O', error);
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    res.status(500).json({ error: 'Failed to process audio metadata' });
  }
});

// 2. Single Track Ingestion - Final Confirmation & Save Step
router.post('/confirm', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const { tempFileId, title, artist, album, fileType, categories, volumeTrim, cueStart, cueEnd, isExplicit } = req.body;

  if (!tempFileId || !title) {
    return res.status(400).json({ error: 'tempFileId and title are required' });
  }

  const tempFilePath = path.join(uploadDir, tempFileId);
  if (!fs.existsSync(tempFilePath)) {
    return res.status(404).json({ error: 'Temporary file session expired or not found' });
  }

  try {
    const audioData = await processAudioFile(tempFilePath);
    const ext = path.extname(tempFilePath);
    
    // Get destination path partitioned by hash
    const dest = getTrackDestPath(audioData.fileHash, ext);
    
    // Move temp file to permanent storage
    fs.renameSync(tempFilePath, dest.fullPath);

    // Handle embedded album art extraction
    let coverArtUrl = getRandomDefaultCover();
    if (audioData.picture) {
      const coverDir = path.join(__dirname, '../../public/covers');
      if (!fs.existsSync(coverDir)) {
        fs.mkdirSync(coverDir, { recursive: true });
      }
      const coverFilePath = path.join(coverDir, `${audioData.fileHash}.jpg`);
      
      // Resize cover to 500x500 square via sharp
      await sharp(audioData.picture.data)
        .resize(500, 500, { fit: 'cover' })
        .toFormat('jpeg')
        .toFile(coverFilePath);
      
      coverArtUrl = `/covers/${audioData.fileHash}.jpg`;
    }

    // Prepare Category Connections
    const categoryConnect = [];
    if (categories && Array.isArray(categories)) {
      for (const catName of categories) {
        // Find or create category
        const cat = await prisma.trackCategory.upsert({
          where: { name: catName },
          update: {},
          create: { name: catName }
        });
        categoryConnect.push({ id: cat.id });
      }
    }

    // Save to Database
    const track = await prisma.track.create({
      data: {
        title,
        artist: artist || 'Unknown Artist',
        album: album || '',
        duration: audioData.duration,
        fileHash: audioData.fileHash,
        filePath: dest.relative,
        fileType: fileType || 'SONG',
        coverArtUrl: coverArtUrl,
        volumeTrim: parseFloat(volumeTrim) || 1.0,
        cueStart: parseFloat(cueStart) || 0.0,
        cueEnd: parseFloat(cueEnd) || audioData.duration,
        isExplicit: !!isExplicit,
        categories: {
          connect: categoryConnect
        }
      },
      include: {
        categories: true
      }
    });

    // Create system audit log
    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'TRACK_UPLOADED',
        details: `Uploaded track: ${track.title} by ${track.artist}`
      }
    });

    res.status(201).json({ message: 'Track saved successfully', track });

  } catch (error) {
    logger.error('Error confirming track ingestion: %O', error);
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    res.status(500).json({ error: 'Failed to save track to library' });
  }
});

// 3. Bulk Upload - Parallel Ingestion & Auto-Save
router.post('/bulk', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), upload.array('audio', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No audio files uploaded' });
  }

  const results = {
    total: req.files.length,
    success: [],
    skipped: [],
    failed: []
  };

  for (const file of req.files) {
    const tempPath = file.path;
    try {
      const audioData = await processAudioFile(tempPath);
      
      // Deduplicate check
      const existingTrack = await prisma.track.findUnique({
        where: { fileHash: audioData.fileHash }
      });

      if (existingTrack) {
        fs.unlinkSync(tempPath);
        results.skipped.push({
          filename: file.originalname,
          reason: 'Duplicate file hash',
          track: existingTrack
        });
        continue;
      }

      // Filename fallbacks
      let resolvedTitle = audioData.title;
      let resolvedArtist = audioData.artist;
      
      if (!resolvedTitle) {
        const nameWithoutExt = path.basename(file.originalname, path.extname(file.originalname));
        const parts = nameWithoutExt.split('-');
        if (parts.length > 1) {
          resolvedArtist = parts[0].trim();
          resolvedTitle = parts.slice(1).join('-').trim();
        } else {
          resolvedTitle = nameWithoutExt.trim();
          resolvedArtist = 'Unknown Artist';
        }
      }

      // Move file
      const ext = path.extname(tempPath);
      const dest = getTrackDestPath(audioData.fileHash, ext);
      fs.renameSync(tempPath, dest.fullPath);

      // Extract cover if present
      let coverArtUrl = getRandomDefaultCover();
      if (audioData.picture) {
        const coverDir = path.join(__dirname, '../../public/covers');
        if (!fs.existsSync(coverDir)) {
          fs.mkdirSync(coverDir, { recursive: true });
        }
        const coverFilePath = path.join(coverDir, `${audioData.fileHash}.jpg`);
        await sharp(audioData.picture.data)
          .resize(500, 500, { fit: 'cover' })
          .toFormat('jpeg')
          .toFile(coverFilePath);
        coverArtUrl = `/covers/${audioData.fileHash}.jpg`;
      }

      // Save database entry directly
      const track = await prisma.track.create({
        data: {
          title: resolvedTitle,
          artist: resolvedArtist,
          album: audioData.album || '',
          duration: audioData.duration,
          fileHash: audioData.fileHash,
          filePath: dest.relative,
          fileType: 'SONG',
          coverArtUrl: coverArtUrl,
          cueEnd: audioData.duration
        }
      });

      results.success.push({
        filename: file.originalname,
        track
      });

    } catch (err) {
      logger.error('Bulk file process failed for %s: %s', file.originalname, err.message);
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      results.failed.push({
        filename: file.originalname,
        error: err.message
      });
    }
  }

  // Audit bulk action
  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: 'BULK_TRACKS_UPLOADED',
      details: `Bulk uploaded: ${results.success.length} succeeded, ${results.skipped.length} skipped, ${results.failed.length} failed`
    }
  });

  res.json({ message: 'Bulk processing completed', results });
});

// 4. List tracks (with paging, sorting, filtering, and category folders)
router.get('/', authenticateJWT, async (req, res) => {
  const { page = 1, limit = 50, sortField = 'title', sortOrder = 'asc', search, categoryId, fileType, showDeleted = 'false' } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build filter object
  const where = {
    isDeleted: showDeleted === 'true'
  };

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { artist: { contains: search } },
      { album: { contains: search } }
    ];
  }

  if (categoryId) {
    where.categories = {
      some: { id: parseInt(categoryId) }
    };
  }

  if (fileType) {
    where.fileType = fileType;
  }

  try {
    const total = await prisma.track.count({ where });
    const tracks = await prisma.track.findMany({
      where,
      skip,
      take,
      orderBy: {
        [sortField]: sortOrder.toLowerCase()
      },
      include: {
        categories: true
      }
    });

    res.json({
      tracks,
      pagination: {
        total,
        page: parseInt(page),
        limit: take,
        pages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    logger.error('Failed listing tracks: %O', error);
    res.status(500).json({ error: 'Failed to retrieve tracks' });
  }
});

// 5. Update track metadata & playback overrides
router.patch('/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER', 'DJ']), async (req, res) => {
  const trackId = parseInt(req.params.id);
  const updates = req.body;

  let originalTrack;
  try {
    originalTrack = await prisma.track.findUnique({ where: { id: trackId } });
    if (!originalTrack) {
      return res.status(404).json({ error: 'Track not found' });
    }
  } catch (err) {
    logger.error('Failed fetching original track: %O', err);
    return res.status(500).json({ error: 'Failed to find track' });
  }

  // Filter allowed fields to prevent arbitrary updates
  const allowedFields = [
    'title', 'artist', 'album', 'fileType', 'isExplicit',
    'volumeTrim', 'cueStart', 'cueIntro', 'cueOutro', 'cueEnd', 'fadeDuration', 'categoryIds'
  ];

  const filteredUpdates = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if (['volumeTrim', 'cueStart', 'cueIntro', 'cueOutro', 'cueEnd', 'fadeDuration'].includes(field)) {
        if (updates[field] === '' || updates[field] === null || updates[field] === undefined) {
          if (field === 'cueEnd') filteredUpdates[field] = originalTrack.duration;
          else if (field === 'volumeTrim') filteredUpdates[field] = 1.0;
          else if (field === 'fadeDuration') filteredUpdates[field] = null;
          else filteredUpdates[field] = 0.0;
        } else {
          const val = parseFloat(updates[field]);
          if (isNaN(val)) {
            if (field === 'cueEnd') filteredUpdates[field] = originalTrack.duration;
            else if (field === 'volumeTrim') filteredUpdates[field] = 1.0;
            else if (field === 'fadeDuration') filteredUpdates[field] = null;
            else filteredUpdates[field] = 0.0;
          } else {
            filteredUpdates[field] = val;
          }
        }
      } else if (field === 'categoryIds') {
        if (Array.isArray(updates[field])) {
          filteredUpdates.categories = {
            set: updates[field].map(id => ({ id: parseInt(id) }))
          };
        }
      } else if (field === 'isExplicit') {
        filteredUpdates[field] = !!updates[field];
      } else {
        filteredUpdates[field] = updates[field];
      }
    }
  }

  try {
    const updatedTrack = await prisma.track.update({
      where: { id: trackId },
      data: filteredUpdates
    });

    // Create Audit Log
    const logDetails = `Updated track ${trackId} metadata. Modified: ${Object.keys(filteredUpdates).join(', ')}`;
    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'TRACK_UPDATED',
        details: logDetails.substring(0, 250)
      }
    });

    res.json({ message: 'Track updated successfully', track: updatedTrack });

  } catch (error) {
    logger.error('Failed to update track: %O', error);
    res.status(500).json({ error: 'Failed to update track metadata' });
  }
});

// 6. Update track categories (folder dragging)
router.put('/:id/categories', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const trackId = parseInt(req.params.id);
  const { categoryIds } = req.body; // Array of IDs

  if (!Array.isArray(categoryIds)) {
    return res.status(400).json({ error: 'categoryIds must be an array' });
  }

  try {
    const track = await prisma.track.findUnique({ where: { id: trackId } });
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Set many-to-many relationship
    const updatedTrack = await prisma.track.update({
      where: { id: trackId },
      data: {
        categories: {
          set: categoryIds.map(id => ({ id: parseInt(id) }))
        }
      },
      include: {
        categories: true
      }
    });

    res.json({ message: 'Categories updated successfully', track: updatedTrack });

  } catch (error) {
    logger.error('Failed updating track categories: %O', error);
    res.status(500).json({ error: 'Failed to update categories' });
  }
});

// 7. Update cover art poster upload
router.put('/:id/cover', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), uploadImage.single('cover'), async (req, res) => {
  const trackId = parseInt(req.params.id);
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  try {
    const track = await prisma.track.findUnique({ where: { id: trackId } });
    if (!track) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Track not found' });
    }

    const coverDir = path.join(__dirname, '../../public/covers');
    if (!fs.existsSync(coverDir)) {
      fs.mkdirSync(coverDir, { recursive: true });
    }
    const coverFilePath = path.join(coverDir, `${track.fileHash}.jpg`);

    // Process & resize image via sharp
    await sharp(req.file.path)
      .resize(500, 500, { fit: 'cover' })
      .toFormat('jpeg')
      .toFile(coverFilePath);

    // Delete uploaded temp file
    fs.unlinkSync(req.file.path);

    // Update database record
    const coverUrl = `/covers/${track.fileHash}.jpg`;
    await prisma.track.update({
      where: { id: trackId },
      data: { coverArtUrl: coverUrl }
    });

    res.json({ 
      message: 'Cover art updated successfully', 
      coverArtUrl: coverUrl 
    });

  } catch (error) {
    logger.error('Failed to update cover art: %O', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to process cover art image' });
  }
});

// 8. Soft Delete Track
router.delete('/:id', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  const trackId = parseInt(req.params.id);

  try {
    const track = await prisma.track.findUnique({ where: { id: trackId } });
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Safety check: block delete if assigned to any Fallback Pool playlist
    const fallbackAssigned = await prisma.playlistTrack.findFirst({
      where: {
        trackId: trackId,
        playlist: {
          isFallbackPool: true
        }
      },
      include: {
        playlist: true
      }
    });

    if (fallbackAssigned) {
      logger.warn('Delete Blocked: Track %s is part of fallback pool playlist %s', trackId, fallbackAssigned.playlist.name);
      return res.status(400).json({ error: `Cannot delete track. It is assigned to the Fallback Pool playlist "${fallbackAssigned.playlist.name}".` });
    }

    await prisma.track.update({
      where: { id: trackId },
      data: { isDeleted: true }
    });

    // Create system log
    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'TRACK_DELETED',
        details: `Soft-deleted track ${trackId}: ${track.title} by ${track.artist}`
      }
    });

    res.json({ message: 'Track soft-deleted successfully' });

  } catch (error) {
    logger.error('Failed to delete track: %O', error);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

// 9. Preview audio file
router.get('/:id/audio', authenticateJWT, async (req, res) => {
  const trackId = parseInt(req.params.id);
  try {
    const track = await prisma.track.findUnique({ where: { id: trackId } });
    if (!track || track.isDeleted) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const fullPath = path.join(__dirname, '../../storage', track.filePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Audio file not found on disk' });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(fullPath);
  } catch (error) {
    logger.error('Failed to stream audio file for preview: %O', error);
    res.status(500).json({ error: 'Failed to stream audio file' });
  }
});

export default router;
