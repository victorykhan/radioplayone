import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const systemLogPath = path.join(__dirname, '../../storage/logs/combined.log');

// 1. Get Activity Logs (from Database)
router.get('/activity', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  try {
    const logs = await prisma.activityLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 200,
      include: {
        user: {
          select: { email: true }
        }
      }
    });
    res.json(logs.map(l => ({
      id: l.id,
      email: l.user ? l.user.email : 'System/Anonymous',
      action: l.action,
      details: l.details,
      timestamp: l.timestamp
    })));
  } catch (error) {
    logger.error('Failed to get activity logs: %O', error);
    res.status(500).json({ error: 'Failed to retrieve activity logs' });
  }
});

// 2. Delete all Activity Logs
router.delete('/activity', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  try {
    await prisma.activityLog.deleteMany();
    logger.info('All activity logs cleared by Admin: %s', req.user.email);
    res.json({ message: 'All activity logs cleared' });
  } catch (error) {
    logger.error('Failed to clear activity logs: %O', error);
    res.status(500).json({ error: 'Failed to clear activity logs' });
  }
});

// 3. Delete specific Activity Log
router.delete('/activity/:id', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await prisma.activityLog.delete({ where: { id } });
    res.json({ message: 'Log entry deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete activity log: %O', error);
    res.status(500).json({ error: 'Failed to delete log entry' });
  }
});

// 4. Get System Winston Logs (read from file combined.log)
router.get('/system', authenticateJWT, requireRole(['ADMIN']), (req, res) => {
  if (!fs.existsSync(systemLogPath)) {
    return res.json([]);
  }

  fs.readFile(systemLogPath, 'utf8', (err, data) => {
    if (err) {
      logger.error('Failed to read system log file: %O', err);
      return res.status(500).json({ error: 'Failed to read system logs' });
    }

    // Winston format is JSON-lines. Parse each line
    const lines = data.trim().split('\n').filter(Boolean);
    const parsedLogs = [];

    // Parse from newest to oldest (limit to last 200 lines)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
      try {
        parsedLogs.push(JSON.parse(lines[i]));
      } catch {
        parsedLogs.push({ message: lines[i], timestamp: new Date(), level: 'info' });
      }
    }

    res.json(parsedLogs);
  });
});

// 5. Clear System Winston Logs
router.delete('/system', authenticateJWT, requireRole(['ADMIN']), (req, res) => {
  try {
    // Truncate/empty the combined.log and error.log files
    const errorLogPath = path.join(__dirname, '../../storage/logs/error.log');
    
    fs.writeFileSync(systemLogPath, '');
    fs.writeFileSync(errorLogPath, '');
    
    logger.info('System log files cleared by Admin: %s', req.user.email);
    res.json({ message: 'System log files cleared successfully' });
  } catch (error) {
    logger.error('Failed to clear system logs: %O', error);
    res.status(500).json({ error: 'Failed to clear system log files' });
  }
});

export default router;
