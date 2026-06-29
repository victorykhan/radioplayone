import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
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

    let maxListeners = 100;
    try {
      const xmlPath = path.join(__dirname, '../../icecast.xml');
      if (fs.existsSync(xmlPath)) {
        const content = fs.readFileSync(xmlPath, 'utf8');
        const match = content.match(/<mount-name>\/radio<\/mount-name>[\s\S]*?<max-listeners>(\d+)<\/max-listeners>/);
        if (match) {
          maxListeners = parseInt(match[1]);
        }
      }
    } catch (err) {
      logger.error('Failed to parse icecast.xml for limits: %O', err);
    }

    settings.broadcast = {
      host: process.env.ICECAST_HOST || 'play.vawam.ca',
      port: process.env.ICECAST_PORT || '8000',
      mount: process.env.ICECAST_MOUNT || '/radio.mp3',
      username: process.env.ICECAST_USERNAME || 'source',
      maxListeners
    };

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

// 4. Upload station favicon
router.post('/favicon', authenticateJWT, requireRole(['ADMIN']), upload.single('favicon'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No favicon file uploaded' });
  }

  try {
    const imagesDir = path.join(__dirname, '../../public/images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const fileSuffix = Date.now();
    const ext = path.extname(req.file.originalname) || '.ico';
    const destFilePath = path.join(imagesDir, `favicon_${fileSuffix}${ext}`);

    // Move file
    fs.renameSync(req.file.path, destFilePath);

    const faviconUrl = `/images/favicon_${fileSuffix}${ext}`;

    // Fetch existing theme settings and update favicon url
    const existingThemeRecord = await prisma.systemSetting.findUnique({ where: { key: 'theme' } });
    let themeObj = { primary: '#00f0ff', secondary: '#7000ff', background: '#0d101f' };
    if (existingThemeRecord) {
      themeObj = JSON.parse(existingThemeRecord.value);
    }
    themeObj.faviconUrl = faviconUrl;

    await prisma.systemSetting.upsert({
      where: { key: 'theme' },
      update: { value: JSON.stringify(themeObj) },
      create: { key: 'theme', value: JSON.stringify(themeObj) }
    });

    res.json({ message: 'Favicon uploaded successfully', faviconUrl });
  } catch (error) {
    logger.error('Failed to upload favicon: %O', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to process favicon' });
  }
});

// 5. Upload Open Graph image
router.post('/og-image', authenticateJWT, requireRole(['ADMIN']), upload.single('ogImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  try {
    const imagesDir = path.join(__dirname, '../../public/images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const fileSuffix = Date.now();
    const destFilePath = path.join(imagesDir, `og_${fileSuffix}.png`);

    // Process and resize via Sharp for OG standard dimensions (1200x630)
    await sharp(req.file.path)
      .resize(1200, 630, { fit: 'cover' })
      .toFormat('png')
      .toFile(destFilePath);

    fs.unlinkSync(req.file.path);

    const ogImageUrl = `/images/og_${fileSuffix}.png`;

    // Fetch existing seo settings and update openGraphImageUrl
    const existingSeoRecord = await prisma.systemSetting.findUnique({ where: { key: 'seo' } });
    let seoObj = {};
    if (existingSeoRecord) {
      seoObj = JSON.parse(existingSeoRecord.value);
    }
    seoObj.openGraphImageUrl = ogImageUrl;

    await prisma.systemSetting.upsert({
      where: { key: 'seo' },
      update: { value: JSON.stringify(seoObj) },
      create: { key: 'seo', value: JSON.stringify(seoObj) }
    });

    res.json({ message: 'Open Graph image uploaded successfully', ogImageUrl });
  } catch (error) {
    logger.error('Failed to upload OG image: %O', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to process OG image' });
  }
});

// Get default cover slots status
router.get('/default-covers', authenticateJWT, async (req, res) => {
  try {
    const defaultsDir = path.join(__dirname, '../../public/covers/defaults');
    const slots = [];
    for (let slot = 1; slot <= 5; slot++) {
      const filePath = path.join(defaultsDir, `default-${slot}.jpg`);
      const exists = fs.existsSync(filePath);
      slots.push({
        slot,
        url: exists ? `/covers/defaults/default-${slot}.jpg?_t=${Date.now()}` : null,
        exists
      });
    }
    res.json(slots);
  } catch (error) {
    logger.error('Failed to retrieve default cover slots: %O', error);
    res.status(500).json({ error: 'Failed to retrieve default covers' });
  }
});

// Upload default cover to slot
router.post('/default-covers/:slot', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), upload.single('cover'), async (req, res) => {
  const slot = parseInt(req.params.slot);
  if (isNaN(slot) || slot < 1 || slot > 5) {
    return res.status(400).json({ error: 'Invalid default cover slot (must be 1-5)' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Image file required' });
  }

  try {
    const defaultsDir = path.join(__dirname, '../../public/covers/defaults');
    if (!fs.existsSync(defaultsDir)) {
      fs.mkdirSync(defaultsDir, { recursive: true });
    }

    const targetPath = path.join(defaultsDir, `default-${slot}.jpg`);

    // Process and resize image to 500x500 square via Sharp
    await sharp(req.file.path)
      .resize(500, 500, { fit: 'cover' })
      .toFormat('jpeg')
      .toFile(targetPath);

    fs.unlinkSync(req.file.path);

    const coverUrl = `/covers/defaults/default-${slot}.jpg?_t=${Date.now()}`;
    res.json({ message: `Default cover art slot ${slot} updated successfully`, coverUrl });
  } catch (error) {
    logger.error('Failed to process default cover upload: %O', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to process default cover art image' });
  }
});

// 4. Update Icecast Max Listeners Limit
router.post('/icecast-limit', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  const { limit } = req.body;
  const parsedLimit = parseInt(limit);
  if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
    return res.status(400).json({ error: 'Limit must be a valid number between 1 and 10000' });
  }

  try {
    const xmlPath = path.join(__dirname, '../../icecast.xml');
    if (!fs.existsSync(xmlPath)) {
      return res.status(404).json({ error: 'icecast.xml configuration template not found' });
    }

    let content = fs.readFileSync(xmlPath, 'utf8');

    // 1. Replace clients limit
    const clientsRegex = /(<clients>)\d+(<\/clients>)/;
    content = content.replace(clientsRegex, `$1${parsedLimit}$2`);

    // 2. Replace /radio mount max-listeners limit
    const radioMountRegex = /(<mount-name>\/radio<\/mount-name>[\s\S]*?<max-listeners>)\d+(<\/max-listeners>)/g;
    content = content.replace(radioMountRegex, `$1${parsedLimit}$2`);

    // Write back to template
    fs.writeFileSync(xmlPath, content, 'utf8');

    // 3. Deploy to /etc/icecast2/icecast.xml and reload Icecast server
    const deployCommand = 'sudo cp /home/ubuntu/radioplayone/icecast.xml /etc/icecast2/icecast.xml && sudo systemctl reload icecast2';
    
    exec(deployCommand, async (error, stdout, stderr) => {
      if (error) {
        logger.error('Failed to deploy icecast.xml or reload icecast2: %O. Stderr: %s', error, stderr);
        // If /etc/icecast2/icecast.xml doesn't exist, we assume this is a dev/test environment
        if (!fs.existsSync('/etc/icecast2/icecast.xml')) {
          return res.json({ 
            message: 'Local icecast.xml updated. (Systemd reload skipped in development)', 
            limit: parsedLimit 
          });
        }
        return res.status(500).json({ error: 'Failed to reload Icecast server configuration: ' + stderr });
      }

      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: 'ICECAST_LIMIT_UPDATED',
          details: `Updated Icecast max listeners limit to: ${parsedLimit}`
        }
      });

      logger.info('Icecast max listeners updated and configuration reloaded successfully');
      res.json({ message: 'Icecast limits updated and reloaded successfully', limit: parsedLimit });
    });
  } catch (error) {
    logger.error('Failed to update Icecast limits: %O', error);
    res.status(500).json({ error: 'Failed to update Icecast limits' });
  }
});

export default router;
