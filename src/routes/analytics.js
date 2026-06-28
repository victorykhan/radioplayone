import express from 'express';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';

const router = express.Router();

// 1. Core dashboard stats (Overview)
router.get('/dashboard', authenticateJWT, async (req, res) => {
  try {
    // Current live listener count (sum of active ListenerSessions)
    const activeListeners = await prisma.listenerSession.count({
      where: { disconnectedAt: null }
    });

    // Total tracks played today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const playsToday = await prisma.playLog.count({
      where: {
        playedAt: { gte: startOfToday }
      }
    });

    // Total Listening Hours (TLH) this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const completedSessions = await prisma.listenerSession.findMany({
      where: {
        connectedAt: { gte: startOfMonth },
        disconnectedAt: { not: null }
      },
      select: { duration: true }
    });

    const totalSeconds = completedSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const totalListeningHours = (totalSeconds / 3600).toFixed(2);

    // Active ad campaigns count
    const now = new Date();
    const activeCampaigns = await prisma.campaign.count({
      where: {
        startDate: { lte: now },
        endDate: { gte: now }
      }
    });

    res.json({
      activeListeners,
      playsToday,
      monthlyListeningHours: parseFloat(totalListeningHours),
      activeCampaigns
    });

  } catch (error) {
    logger.error('Dashboard analytics failed: %O', error);
    res.status(500).json({ error: 'Failed to aggregate dashboard metrics' });
  }
});

// 2. Listener Geo-IP and Device stats
router.get('/listeners', authenticateJWT, async (req, res) => {
  try {
    // Group active sessions by country
    const countryStats = await prisma.listenerSession.groupBy({
      by: ['country'],
      where: { disconnectedAt: null },
      _count: { id: true }
    });

    // Group active sessions by device type
    const deviceStats = await prisma.listenerSession.groupBy({
      by: ['deviceType'],
      where: { disconnectedAt: null },
      _count: { id: true }
    });

    res.json({
      countries: countryStats.map(c => ({ country: c.country, count: c._count.id })),
      devices: deviceStats.map(d => ({ device: d.deviceType, count: d._count.id }))
    });

  } catch (error) {
    logger.error('Failed to get listener geographics: %O', error);
    res.status(500).json({ error: 'Failed to retrieve listener demographics' });
  }
});

// 3. Per-Track Retention and Drop-off Analytics (Paginated & Filterable)
router.get('/tracks-performance', authenticateJWT, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const { startDate, endDate } = req.query;

    const where = {};
    if (startDate) {
      where.playedAt = {
        ...where.playedAt,
        gte: new Date(startDate)
      };
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      where.playedAt = {
        ...where.playedAt,
        lte: end
      };
    }

    const skip = (page - 1) * limit;

    const total = await prisma.playLog.count({ where });

    const playLogs = await prisma.playLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { playedAt: 'desc' },
      include: {
        track: {
          select: { title: true, artist: true }
        }
      }
    });

    const performance = playLogs.map(log => {
      let retention = 100.0;
      if (log.listenersStart > 0) {
        retention = (log.listenersEnd / log.listenersStart) * 100.0;
      }
      return {
        id: log.id,
        title: log.track.title,
        artist: log.track.artist,
        playedAt: log.playedAt,
        durationPlayed: log.durationPlayed,
        status: log.status,
        listenersStart: log.listenersStart,
        listenersEnd: log.listenersEnd,
        retentionRate: parseFloat(retention.toFixed(1))
      };
    });

    res.json({
      data: performance,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    logger.error('Track performance analytics failed: %O', error);
    res.status(500).json({ error: 'Failed to retrieve track stats' });
  }
});

// 4. Advertiser Proof of Play campaign audits
router.get('/campaign/:id/report', authenticateJWT, async (req, res) => {
  const campaignId = req.params.id;

  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        ads: {
          include: {
            track: true
          }
        }
      }
    });

    if (!campaign) {
      return res.status(404).json({ error: 'Ad campaign not found' });
    }

    const adTrackIds = campaign.ads.map(ad => ad.trackId);

    // Fetch all play log entries for these ads
    const logs = await prisma.playLog.findMany({
      where: {
        trackId: { in: adTrackIds },
        wasAd: true
      },
      orderBy: { playedAt: 'desc' }
    });

    // Calculate metrics
    const totalPlays = logs.length;
    const completedPlays = logs.filter(l => l.status === 'COMPLETED').length;
    
    // Total impressions: sum of average audience size per play
    const totalImpressions = logs.reduce((sum, l) => {
      const avgAudience = (l.listenersStart + l.listenersEnd) / 2;
      return sum + avgAudience;
    }, 0);

    const completionRate = totalPlays > 0 ? ((completedPlays / totalPlays) * 100).toFixed(1) : 0;
    const revenueGenerated = (campaign.cpc * totalPlays).toFixed(2);

    res.json({
      campaign: {
        id: campaign.id,
        client: campaign.clientName,
        name: campaign.name,
        targetPlays: campaign.targetPlays,
        targetImpressions: campaign.targetImpressions,
        startDate: campaign.startDate,
        endDate: campaign.endDate
      },
      summary: {
        totalPlays,
        completedPlays,
        completionRate: parseFloat(completionRate),
        totalImpressions: Math.round(totalImpressions),
        revenueGenerated: parseFloat(revenueGenerated)
      },
      playLogs: logs.map(l => ({
        playedAt: l.playedAt,
        duration: l.durationPlayed,
        status: l.status,
        audienceStart: l.listenersStart,
        audienceEnd: l.listenersEnd
      }))
    });

  } catch (error) {
    logger.error('Campaign auditing failed: %O', error);
    res.status(500).json({ error: 'Failed to retrieve campaign audit reports' });
  }
});

// 5. Per-Track Analytics
router.get('/track/:id', authenticateJWT, async (req, res) => {
  const trackId = parseInt(req.params.id);
  const { startDate, endDate } = req.query;

  try {
    const where = { trackId };
    if (startDate) {
      where.playedAt = { ...where.playedAt, gte: new Date(startDate) };
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      where.playedAt = { ...where.playedAt, lte: end };
    }

    const playLogs = await prisma.playLog.findMany({
      where,
      orderBy: { playedAt: 'desc' },
      include: {
        track: {
          select: { title: true, artist: true, duration: true }
        }
      }
    });

    if (playLogs.length === 0) {
      const track = await prisma.track.findUnique({
        where: { id: trackId },
        select: { title: true, artist: true }
      });
      if (!track) return res.status(404).json({ error: 'Track not found' });
      return res.json({
        track,
        stats: {
          totalPlays: 0,
          totalSeconds: 0,
          totalMinutes: 0,
          totalHours: 0,
          avgListeners: 0
        },
        history: []
      });
    }

    const trackInfo = playLogs[0].track;

    let totalSeconds = 0;
    let totalListeners = 0;

    const history = playLogs.map(log => {
      totalSeconds += log.durationPlayed || 0;
      totalListeners += log.listenersStart || 0;
      let retention = 100.0;
      if (log.listenersStart > 0) {
        retention = (log.listenersEnd / log.listenersStart) * 100.0;
      }
      return {
        id: log.id,
        playedAt: log.playedAt,
        durationPlayed: log.durationPlayed,
        listenersStart: log.listenersStart,
        listenersEnd: log.listenersEnd,
        retentionRate: parseFloat(retention.toFixed(1))
      };
    });

    const totalPlays = playLogs.length;
    const avgListeners = totalPlays > 0 ? (totalListeners / totalPlays) : 0;

    res.json({
      track: {
        id: trackId,
        title: trackInfo.title,
        artist: trackInfo.artist
      },
      stats: {
        totalPlays,
        totalSeconds,
        totalMinutes: parseFloat((totalSeconds / 60).toFixed(1)),
        totalHours: parseFloat((totalSeconds / 3600).toFixed(2)),
        avgListeners: parseFloat(avgListeners.toFixed(1))
      },
      history: history.reverse() // Chronological order for chart
    });

  } catch (error) {
    logger.error('Failed to get per-track analytics: %O', error);
    res.status(500).json({ error: 'Failed to retrieve track stats' });
  }
});

export default router;

