import express from 'express';
import geoip from 'geoip-lite';
import crypto from 'crypto';
import prisma from '../db.js';
import logger from '../logger.js';

const router = express.Router();

// Helper to determine device type from User Agent
const parseDeviceType = (userAgent) => {
  if (!userAgent) return 'Desktop';
  const ua = userAgent.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) {
    return 'Mobile';
  }
  if (ua.includes('vlc') || ua.includes('winamp') || ua.includes('itunes') || ua.includes('media player')) {
    return 'Media Player';
  }
  if (ua.includes('alexa') || ua.includes('echo') || ua.includes('assistant') || ua.includes('sonos')) {
    return 'Smart Speaker';
  }
  return 'Desktop';
};

// Hook triggered when a listener connects (listener-add)
router.post('/connect', async (req, res) => {
  const { ip, agent, id, mount } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Icecast listener ID (id) is required' });
  }

  try {
    // 1. GDPR-compliant IP hashing
    const ipHash = crypto.createHash('sha256').update(ip || 'unknown-ip').digest('hex');

    // 2. Perform local Geo-IP Lookup
    let country = 'Unknown';
    let city = 'Unknown';
    
    if (ip && ip !== '127.0.0.1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
      const geo = geoip.lookup(ip);
      if (geo) {
        country = geo.country || 'Unknown';
        city = geo.city || 'Unknown';
      }
    }

    const deviceType = parseDeviceType(agent);

    // Create session in Database
    const session = await prisma.listenerSession.create({
      data: {
        icecastId: String(id),
        ipHash,
        country,
        city,
        userAgent: agent || 'Unknown',
        deviceType
      }
    });

    logger.debug('Icecast Listener connected: Session %s, Country: %s', session.id, country);
    res.sendStatus(200);

  } catch (error) {
    logger.error('Failed to log listener connection webhook: %O', error);
    res.sendStatus(500); // icecast will ignore but good to be clean
  }
});

// Hook triggered when a listener disconnects (listener-remove)
router.post('/disconnect', async (req, res) => {
  const { id, duration } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Icecast listener ID (id) is required' });
  }

  try {
    // Find the active session for this listener ID
    const session = await prisma.listenerSession.findFirst({
      where: {
        icecastId: String(id),
        disconnectedAt: null
      },
      orderBy: { connectedAt: 'desc' } // ensure we fetch the latest one
    });

    if (!session) {
      logger.warn('Received Icecast disconnect webhook for unknown listener: %s', id);
      return res.sendStatus(200);
    }

    const now = new Date();
    const finalDuration = duration ? parseInt(duration) : Math.round((now - session.connectedAt) / 1000);

    // Update Session
    await prisma.listenerSession.update({
      where: { id: session.id },
      data: {
        disconnectedAt: now,
        duration: finalDuration
      }
    });

    logger.debug('Icecast Listener disconnected: Session %s, Duration: %s sec', session.id, finalDuration);
    res.sendStatus(200);

  } catch (error) {
    logger.error('Failed to log listener disconnection webhook: %O', error);
    res.sendStatus(500);
  }
});

export default router;
