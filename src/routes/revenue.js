import express from 'express';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT } from './auth.js';

const router = express.Router();

router.get('/', authenticateJWT, async (req, res) => {
  const { range = 'weekly', sortField = 'revenue', sortOrder = 'desc', start, end } = req.query;

  try {
    // 1. Resolve date range limits
    let startDate = new Date();
    let endDate = new Date();

    if (start && end) {
      startDate = new Date(start);
      endDate = new Date(end);
    } else {
      const now = new Date();
      if (range === 'daily') {
        // Last 14 days
        startDate.setDate(now.getDate() - 14);
      } else if (range === 'weekly') {
        // Last 8 weeks
        startDate.setDate(now.getDate() - 56);
      } else if (range === 'monthly') {
        // Last 6 months
        startDate.setMonth(now.getMonth() - 6);
      } else if (range === 'annual') {
        // Last 3 years
        startDate.setFullYear(now.getFullYear() - 3);
      } else {
        // Default to last 30 days
        startDate.setDate(now.getDate() - 30);
      }
    }

    // Ensure start date is beginning of day, end date is end of day
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    // 2. Fetch all campaigns
    const campaigns = await prisma.campaign.findMany({
      include: {
        ads: {
          include: {
            track: true
          }
        }
      }
    });

    const trackIdToCampaign = {};
    const allAdTrackIds = [];

    campaigns.forEach(c => {
      c.ads.forEach(ad => {
        trackIdToCampaign[ad.trackId] = c;
        allAdTrackIds.push(ad.trackId);
      });
    });

    // 3. Fetch play logs in this range for ad tracks
    const logs = await prisma.playLog.findMany({
      where: {
        trackId: { in: allAdTrackIds },
        playedAt: { gte: startDate, lte: endDate }
      },
      include: {
        track: true
      }
    });

    // 4. Aggregate campaigns stats
    const campaignStats = {};
    campaigns.forEach(c => {
      campaignStats[c.id] = {
        id: c.id,
        name: c.name,
        clientName: c.clientName,
        clientIndustry: c.clientIndustry,
        cpc: c.cpc,
        plays: 0,
        revenue: 0
      };
    });

    // 5. Aggregate ad-level stats
    const adStats = {};
    allAdTrackIds.forEach(tid => {
      const camp = trackIdToCampaign[tid];
      adStats[tid] = {
        trackId: tid,
        title: '',
        artist: '',
        plays: 0,
        cpc: camp ? camp.cpc : 0,
        revenue: 0,
        campaignName: camp ? camp.name : 'Unknown'
      };
    });

    // 6. Aggregate interval revenue data for chart
    const intervalMap = {};

    logs.forEach(log => {
      const camp = trackIdToCampaign[log.trackId];
      if (!camp) return;

      const revenue = camp.cpc;
      
      // Update campaign stats
      campaignStats[camp.id].plays++;
      campaignStats[camp.id].revenue += revenue;

      // Update ad stats
      if (adStats[log.trackId]) {
        adStats[log.trackId].plays++;
        adStats[log.trackId].revenue += revenue;
        adStats[log.trackId].title = log.track.title;
        adStats[log.trackId].artist = log.track.artist || 'Unknown';
      }

      // Group by interval key
      const date = new Date(log.playedAt);
      let intervalKey = '';
      if (range === 'daily') {
        intervalKey = date.toISOString().split('T')[0];
      } else if (range === 'weekly') {
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(date.setDate(diff));
        intervalKey = monday.toISOString().split('T')[0];
      } else if (range === 'monthly') {
        intervalKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      } else if (range === 'annual') {
        intervalKey = `${date.getFullYear()}`;
      } else {
        intervalKey = date.toISOString().split('T')[0];
      }

      if (!intervalMap[intervalKey]) {
        intervalMap[intervalKey] = { interval: intervalKey, revenue: 0, plays: 0 };
      }
      intervalMap[intervalKey].revenue += revenue;
      intervalMap[intervalKey].plays++;
    });

    // Convert map objects to arrays
    let campaignList = Object.values(campaignStats);
    let adList = Object.values(adStats).filter(ad => ad.plays > 0);
    let chartData = Object.values(intervalMap);

    // Sort campaigns list
    campaignList.sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];
      if (typeof valA === 'string') {
        return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortOrder === 'asc' ? valA - valB : valB - valA;
    });

    // Sort top ads by revenue desc and slice top 3
    adList.sort((a, b) => b.revenue - a.revenue);
    const topAds = adList.slice(0, 3);

    // Sort chart data chronologically
    chartData.sort((a, b) => a.interval.localeCompare(b.interval));

    // Calculate overall summaries
    let totalPlays = 0;
    let totalRevenue = 0;
    campaignList.forEach(c => {
      totalPlays += c.plays;
      totalRevenue += c.revenue;
    });

    const activeCampaigns = campaigns.filter(c => c.isActive).length;
    const avgCpc = campaigns.length > 0 
      ? campaigns.reduce((acc, c) => acc + c.cpc, 0) / campaigns.length
      : 0;

    res.json({
      summary: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalPlays,
        avgCpc: parseFloat(avgCpc.toFixed(2)),
        activeCampaigns
      },
      campaigns: campaignList,
      topAds,
      chartData
    });

  } catch (error) {
    logger.error('Failed to compute ads revenue: %O', error);
    res.status(500).json({ error: 'Failed to compute ads revenue' });
  }
});

export default router;
