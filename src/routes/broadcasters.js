import express from 'express';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT } from './auth.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to rebuild playout.liq configuration and restart Liquidsoap
async function recompilePlayoutConfig() {
  try {
    const templatePath = path.resolve(__dirname, '../../playout.liq.template');
    const activePath = path.resolve(__dirname, '../../playout.liq');

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Playout template file not found at: ${templatePath}`);
    }

    let templateContent = fs.readFileSync(templatePath, 'utf8');

    // Fetch active broadcasters
    const broadcasters = await prisma.remoteBroadcaster.findMany({
      where: { isActive: true }
    });

    let broadcasterBlocks = '';

    broadcasters.forEach(b => {
      const formatStr = b.format.toLowerCase() === 'aac' ? '%aac' : '%mp3';
      const bitrateStr = `bitrate=${b.bitrate || 128}`;
      const formatBlock = `${formatStr}(${bitrateStr})`;

      if (b.type.toUpperCase() === 'ICECAST') {
        const usernameLine = b.username ? `  username="${b.username}",\n` : '';
        const mountLine = b.mount ? `  mount="${b.mount}",\n` : '  mount="stream",\n';
        
        broadcasterBlocks += `
# Remote Icecast Broadcaster: ${b.name}
output.icecast(${formatBlock},
  id="broadcaster_${b.id}",
  host="${b.host}",
  port=${b.port},
${usernameLine}  password="${b.password}",
${mountLine}  name="${b.name}",
  stream)
`;
      } else if (b.type.toUpperCase() === 'SHOUTCAST') {
        // Shoutcast does not require mount point
        broadcasterBlocks += `
# Remote Shoutcast Broadcaster: ${b.name}
output.shoutcast(${formatBlock},
  id="broadcaster_${b.id}",
  host="${b.host}",
  port=${b.port},
  password="${b.password}",
  name="${b.name}",
  stream)
`;
      }
    });

    // Replace placeholder
    const finalContent = templateContent.replace('{{REMOTE_BROADCASTERS}}', broadcasterBlocks.trim());

    // Write to active playout.liq
    fs.writeFileSync(activePath, finalContent, 'utf8');
    logger.info('Playout config successfully recompiled.');

    // Restart Liquidsoap via PM2 in production VM context
    // In local dev, we might not have PM2 or Liquidsoap, so catch error gracefully
    exec('pm2 restart liquidsoap-engine', (err, stdout, stderr) => {
      if (err) {
        logger.warn(`Could not restart PM2 liquidsoap-engine: ${err.message}. (This is normal in local development)`);
      } else {
        logger.info('PM2 liquidsoap-engine restarted successfully after configuration change.');
      }
    });

  } catch (error) {
    logger.error('Failed to recompile playout config: %O', error);
    throw error;
  }
}

// 1. GET ALL BROADCASTERS
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const list = await prisma.remoteBroadcaster.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (error) {
    logger.error('Failed to fetch remote broadcasters: %O', error);
    res.status(500).json({ error: 'Failed to fetch remote broadcasters' });
  }
});

// 2. CREATE A BROADCASTER
router.post('/', authenticateJWT, async (req, res) => {
  const { name, host, port, mount, username, password, type, format, bitrate, isActive } = req.query.host ? req.query : req.body;
  
  // Basic validation
  if (!name || !host || !port || !password || !type) {
    return res.status(400).json({ error: 'Missing required configuration fields' });
  }

  try {
    const newBroadcaster = await prisma.remoteBroadcaster.create({
      data: {
        name,
        host,
        port: parseInt(port),
        mount: mount || null,
        username: username || null,
        password,
        type: type.toUpperCase(),
        format: format || 'MP3',
        bitrate: parseInt(bitrate) || 128,
        isActive: isActive === undefined ? true : Boolean(isActive)
      }
    });

    // Rebuild playout configuration
    await recompilePlayoutConfig();

    res.status(201).json(newBroadcaster);
  } catch (error) {
    logger.error('Failed to create remote broadcaster: %O', error);
    res.status(500).json({ error: 'Failed to create remote broadcaster' });
  }
});

// 3. UPDATE A BROADCASTER
router.put('/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { name, host, port, mount, username, password, type, format, bitrate, isActive } = req.body;

  try {
    const updated = await prisma.remoteBroadcaster.update({
      where: { id },
      data: {
        name,
        host,
        port: port ? parseInt(port) : undefined,
        mount: mount !== undefined ? mount : undefined,
        username: username !== undefined ? username : undefined,
        password,
        type: type ? type.toUpperCase() : undefined,
        format,
        bitrate: bitrate ? parseInt(bitrate) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined
      }
    });

    // Rebuild playout configuration
    await recompilePlayoutConfig();

    res.json(updated);
  } catch (error) {
    logger.error('Failed to update remote broadcaster: %O', error);
    res.status(500).json({ error: 'Failed to update remote broadcaster' });
  }
});

// 4. DELETE A BROADCASTER
router.delete('/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.remoteBroadcaster.delete({ where: { id } });

    // Rebuild playout configuration
    await recompilePlayoutConfig();

    res.json({ message: 'Remote broadcaster deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete remote broadcaster: %O', error);
    res.status(500).json({ error: 'Failed to delete remote broadcaster' });
  }
});

// Export recompile helper for manual boots/scripts
export { recompilePlayoutConfig };
export default router;
