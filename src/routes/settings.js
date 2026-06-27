import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const uploadDir = path.join(__dirname, '../../storage/uploads');
const upload = multer({ dest: uploadDir });

// 1. Get all settings
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const dbSettings = await prisma.systemSetting.findMany();
    const settings = {};
    
    // Parse JSON string values
    dbSettings.forEach(s => {
      try {
        settings[s.key] = JSON.parse(s.value);
      } catch {
        settings[s.key] = s.value;
      }
    });

    // Provide sensible defaults if not set in DB
    if (!settings.theme) {
      settings.theme = {
        primary: '#00f0ff', // Cyan
        secondary: '#7000ff', // Purple
        logoUrl: '/images/default-logo.svg'
      };
    }
    if (!settings.station_info) {
      settings.station_info = {
        name: 'RadioPlay One',
        tagline: 'The Ultimate Web Automation System'
      };
    }

    res.json(settings);
  } catch (error) {
    logger.error('Failed to get settings: %O', error);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// 2. Save settings (theme/station info)
router.post('/', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  const { key, value } = req.body;

  if (!key || value === undefined) {
    return res.status(400).json({ error: 'Setting key and value are required' });
  }

  try {
    const stringifiedValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

    const setting = await prisma.systemSetting.upsert({
      where: { key },
      update: { value: stringifiedValue },
      create: { key, value: stringifiedValue }
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'SETTINGS_UPDATED',
        details: `Updated system settings key: ${key}`
      }
    });

    res.json({ message: 'Settings saved successfully', setting });
  } catch (error) {
    logger.error('Failed to save settings: %O', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// 3. Upload station logo
router.post('/logo', authenticateJWT, requireRole(['ADMIN']), upload.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No logo file uploaded' });
  }

  try {
    const imagesDir = path.join(__dirname, '../../public/images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const fileSuffix = Date.now();
    const destFilePath = path.join(imagesDir, `logo_${fileSuffix}.png`);

    // Process logo via sharp (e.g. limit to maximum width/height of 300px for speed)
    await sharp(req.file.path)
      .resize(300, 300, { fit: 'inside' })
      .toFormat('png')
      .toFile(destFilePath);

    // Clean temp file
    fs.unlinkSync(req.file.path);

    const logoUrl = `/images/logo_${fileSuffix}.png`;

    // Fetch existing theme settings and update logo url
    const existingThemeRecord = await prisma.systemSetting.findUnique({ where: { key: 'theme' } });
    let themeObj = { primary: '#00f0ff', secondary: '#7000ff' };
    if (existingThemeRecord) {
      themeObj = JSON.parse(existingThemeRecord.value);
    }
    themeObj.logoUrl = logoUrl;

    await prisma.systemSetting.upsert({
      where: { key: 'theme' },
      update: { value: JSON.stringify(themeObj) },
      create: { key: 'theme', value: JSON.stringify(themeObj) }
    });

    res.json({ message: 'Logo uploaded successfully', logoUrl });
  } catch (error) {
    logger.error('Failed to upload logo: %O', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to process logo image' });
  }
});

export default router;
