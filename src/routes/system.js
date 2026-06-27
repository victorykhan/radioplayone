import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import dns from 'dns';
import { fileURLToPath } from 'url';
import { authenticateJWT, requireRole } from './auth.js';
import prisma from '../db.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const AUTH = [authenticateJWT, requireRole(['ADMIN', 'PRODUCER'])];

// Helper: Average CPU Average Times
function cpuAverage() {
  const cpus = os.cpus();
  let idleMs = 0;
  let totalMs = 0;
  cpus.forEach((core) => {
    for (const type in core.times) {
      totalMs += core.times[type];
    }
    idleMs += core.times.idle;
  });
  return { idle: idleMs / cpus.length, total: totalMs / cpus.length };
}

// Helper: Measure CPU percentage over interval
function getCpuUsage() {
  return new Promise((resolve) => {
    const startMeasure = cpuAverage();
    setTimeout(() => {
      const endMeasure = cpuAverage();
      const idleDifference = endMeasure.idle - startMeasure.idle;
      const totalDifference = endMeasure.total - startMeasure.total;
      if (totalDifference === 0) return resolve(0);
      const percentageCpu = 100 - Math.round(100 * idleDifference / totalDifference);
      resolve(Math.min(100, Math.max(0, percentageCpu)));
    }, 150);
  });
}

// Helper: Disk Space Resolver
function getDiskSpace() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('wmic logicaldisk get size,freespace,deviceid', (err, stdout) => {
        if (err || !stdout) {
          return resolve({ total: 100 * 1024 * 1024 * 1024, free: 50 * 1024 * 1024 * 1024, used: 50 * 1024 * 1024 * 1024, percentage: 50 });
        }
        const lines = stdout.trim().split('\r\n').map(l => l.trim().split(/\s+/));
        const cLine = lines.find(l => l[0] === 'C:');
        if (cLine && cLine.length >= 3) {
          const free = parseInt(cLine[1]);
          const total = parseInt(cLine[2]);
          const used = total - free;
          return resolve({ total, free, used, percentage: Math.round((used / total) * 100) });
        }
        resolve({ total: 100 * 1024 * 1024 * 1024, free: 50 * 1024 * 1024 * 1024, used: 50 * 1024 * 1024 * 1024, percentage: 50 });
      });
    } else {
      exec('df -B1 /', (err, stdout) => {
        if (err || !stdout) {
          return resolve({ total: 100 * 1024 * 1024 * 1024, free: 50 * 1024 * 1024 * 1024, used: 50 * 1024 * 1024 * 1024, percentage: 50 });
        }
        const lines = stdout.trim().split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          const total = parseInt(parts[1]);
          const used = parseInt(parts[2]);
          const free = parseInt(parts[3]);
          if (total > 0) {
            return resolve({ total, free, used, percentage: Math.round((used / total) * 100) });
          }
        }
        resolve({ total: 100 * 1024 * 1024 * 1024, free: 50 * 1024 * 1024 * 1024, used: 50 * 1024 * 1024 * 1024, percentage: 50 });
      });
    }
  });
}

// Helper: Calculate Directory Size Recursively
function getDirectorySize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return size;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        size += getDirectorySize(filePath);
      } else {
        size += stats.size;
      }
    }
  } catch (err) {
    logger.error('Failed reading directory size: %O', err);
  }
  return size;
}

// Helper: Internet Ping Check
function checkConnectivity() {
  return new Promise((resolve) => {
    dns.lookup('google.com', (err) => {
      if (err) resolve(false);
      else resolve(true);
    });
  });
}

// ──────────────────────────────────────────────────────────────
// GET /status — Fetch real-time system performance details
// ──────────────────────────────────────────────────────────────
router.get('/status', ...AUTH, async (req, res) => {
  try {
    const cpuUsage = await getCpuUsage();
    const diskSpace = await getDiskSpace();
    const isOnline = await checkConnectivity();

    // Memory (RAM) Info
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramPercentage = Math.round((usedMem / totalMem) * 100);

    // Audio Library space (storage folder)
    const storagePath = path.join(__dirname, '../../storage');
    const audioSpaceBytes = getDirectorySize(storagePath);

    // Additional hardware metadata
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'Generic CPU';
    const cpuCores = cpus.length;
    const sysUptime = os.uptime(); // in seconds
    const osPlatform = os.platform();
    const osRelease = os.release();

    // Process Specific info
    const processMemory = process.memoryUsage();
    const processUptime = process.uptime(); // in seconds

    // Audio tracks count from DB
    const audioTracksCount = await prisma.track.count({ where: { isDeleted: false } });

    res.json({
      cpu: {
        usagePercentage: cpuUsage,
        model: cpuModel,
        cores: cpuCores
      },
      ram: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usagePercentage: ramPercentage
      },
      disk: {
        total: diskSpace.total,
        used: diskSpace.used,
        free: diskSpace.free,
        usagePercentage: diskSpace.percentage
      },
      audioSpace: {
        bytesUsed: audioSpaceBytes,
        tracksCount: audioTracksCount
      },
      network: {
        connected: isOnline,
        hostname: os.hostname(),
        interfaces: os.networkInterfaces()
      },
      os: {
        platform: osPlatform,
        release: osRelease,
        uptime: sysUptime
      },
      process: {
        uptime: processUptime,
        memoryUsage: processMemory.rss
      }
    });

  } catch (error) {
    logger.error('Failed retrieving system performance status: %O', error);
    res.status(500).json({ error: 'Failed to retrieve system status' });
  }
});

export default router;
