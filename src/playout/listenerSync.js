import http from 'http';
import crypto from 'crypto';
import geoip from 'geoip-lite';
import prisma from '../db.js';
import logger from '../logger.js';
import playoutEngine from './engine.js';


let syncInterval = null;

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

// Regex XML Parser for Icecast clients XML
function parseIcecastXml(xmlString) {
  const listeners = [];
  const listenerRegex = /<listener>([\s\S]*?)<\/listener>/g;
  let match;
  while ((match = listenerRegex.exec(xmlString)) !== null) {
    const content = match[1];
    const ip = (content.match(/<IP>(.*?)<\/IP>/) || [])[1] || '';
    const ua = (content.match(/<UserAgent>(.*?)<\/UserAgent>/) || [])[1] || '';
    const connected = parseInt((content.match(/<Connected>(.*?)<\/Connected>/) || [])[1] || '0');
    const id = (content.match(/<ID>(.*?)<\/ID>/) || [])[1] || '';
    listeners.push({ ip, ua, connected, id });
  }
  return listeners;
}

// Fetch XML from Icecast Admin API helper (native http to prevent dependencies)
function fetchIcecastClients() {
  return new Promise((resolve, reject) => {
    const host = process.env.ICECAST_HOST || '127.0.0.1';
    const port = process.env.ICECAST_PORT || '8000';
    const mount = process.env.ICECAST_MOUNT || '/radio';
    const password = process.env.ICECAST_ADMIN_PASSWORD || 'RadioAdmin2024!';
    const user = 'admin';

    const authHeader = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
    const url = `http://${host}:${port}/admin/listclients?mount=${encodeURIComponent(mount)}`;

    http.get(url, {
      headers: { 'Authorization': authHeader }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP status code ${res.statusCode}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Fetch general server stats XML from Icecast Admin API
function fetchIcecastStats() {
  return new Promise((resolve, reject) => {
    const host = process.env.ICECAST_HOST || '127.0.0.1';
    const port = process.env.ICECAST_PORT || '8000';
    const password = process.env.ICECAST_ADMIN_PASSWORD || 'RadioAdmin2024!';
    const user = 'admin';

    const authHeader = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
    const url = `http://${host}:${port}/admin/stats.xml`;

    http.get(url, {
      headers: { 'Authorization': authHeader }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP status code ${res.statusCode}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}


// Sync execution
async function syncListeners() {
  try {
    // 0. Poll stats to check if a live DJ is connected to /live mount
    try {
      const statsXml = await fetchIcecastStats();
      const match = statsXml.match(/<source mount="\/live">([\s\S]*?)<\/source>/);
      const isLiveConnected = match ? (match[1].includes('<source_ip>') || match[1].includes('<server_type>')) : false;

      if (isLiveConnected !== playoutEngine.isDJLive) {
        playoutEngine.isDJLive = isLiveConnected;
        logger.info(`Listener Sync: Live DJ status changed. Connected: ${isLiveConnected}`);

        // Update Liquidsoap interactive switch state and HTTP decoder state
        try {
          if (isLiveConnected) {
            logger.info('Listener Sync: DJ connected. Starting decoder and activating switch...');
            await playoutEngine.sendTelnetCommand('live_dj.start');
            await playoutEngine.sendTelnetCommand('var.set live_dj_active = true');
          } else {
            logger.info('Listener Sync: DJ disconnected. Deactivating switch and stopping decoder...');
            await playoutEngine.sendTelnetCommand('var.set live_dj_active = false');
            await playoutEngine.sendTelnetCommand('live_dj.stop');
            
            logger.info('Listener Sync: DJ disconnected. Resuming playout automation immediately.');
            await playoutEngine.skip();
          }
        } catch (telnetErr) {
          logger.error(`Listener Sync: Failed to toggle Live DJ in Liquidsoap: ${telnetErr.message}`);
        }
      }
    } catch (statsErr) {
      if (playoutEngine.isDJLive) {
        playoutEngine.isDJLive = false;
        logger.warn(`Listener Sync: Failed to poll Icecast stats, setting DJ status to offline: ${statsErr.message}`);
      }
    }

    const xmlData = await fetchIcecastClients();
    const activeIcecastListeners = parseIcecastXml(xmlData);
    const activeIds = activeIcecastListeners.map(l => String(l.id));

    // 1. Process active listeners
    for (const listener of activeIcecastListeners) {
      const ip = listener.ip;
      const ipHash = crypto.createHash('sha256').update(ip || 'unknown-ip').digest('hex');

      // Check if session exists in DB
      let session = await prisma.listenerSession.findFirst({
        where: {
          icecastId: String(listener.id),
          disconnectedAt: null
        }
      });

      if (!session) {
        // Perform Geo-IP lookup
        let country = 'Unknown';
        let city = 'Unknown';
        let latitude = null;
        let longitude = null;
        if (ip && ip !== '127.0.0.1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
          const geo = geoip.lookup(ip);
          if (geo) {
            country = geo.country || 'Unknown';
            city = geo.city || 'Unknown';
            if (geo.ll) {
              latitude = geo.ll[0];
              longitude = geo.ll[1];
            }
          }
        }

        const deviceType = parseDeviceType(listener.ua);

        // Create new session
        session = await prisma.listenerSession.create({
          data: {
            icecastId: String(listener.id),
            ipHash,
            country,
            city,
            latitude,
            longitude,
            userAgent: listener.ua || 'Unknown',
            deviceType,
            duration: listener.connected
          }
        });
        logger.info('Listener Sync: Logged new listener connection. Session: %s, Country: %s, Lat: %s, Lng: %s, Device: %s', session.id, country, latitude, longitude, deviceType);
      } else {
        // Update duration
        await prisma.listenerSession.update({
          where: { id: session.id },
          data: { duration: listener.connected }
        });
      }
    }

    // 2. Process disconnected listeners
    // Any session in DB marked active but whose Icecast ID is no longer active
    const activeDbSessions = await prisma.listenerSession.findMany({
      where: { disconnectedAt: null }
    });

    for (const session of activeDbSessions) {
      if (!activeIds.includes(session.icecastId)) {
        const disconnectedAt = new Date();
        const finalDuration = Math.round((disconnectedAt - session.connectedAt) / 1000);

        await prisma.listenerSession.update({
          where: { id: session.id },
          data: {
            disconnectedAt,
            duration: Math.max(session.duration || 0, finalDuration)
          }
        });
        logger.info('Listener Sync: Logged listener disconnection. Session: %s, Duration: %s sec', session.id, finalDuration);
      }
    }

  } catch (error) {
    // Only log under debug or if it isn't an ECONNREFUSED (meaning Icecast isn't running yet)
    if (error.code === 'ECONNREFUSED') {
      logger.debug('Listener Sync: Icecast server not reachable at local port.');
    } else {
      logger.error('Listener Sync: Verification synchronization failed: %s', error.message);
    }
  }
}

// Start Background Task Sync
export function startListenerSync() {
  if (syncInterval) clearInterval(syncInterval);
  logger.info('Listener Sync: Initializing background verification loop (every 5s)');
  syncInterval = setInterval(syncListeners, 5000);
}

// Stop Background Task Sync
export function stopListenerSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}
