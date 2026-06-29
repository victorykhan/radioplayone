import express from 'express';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from '../middlewares/auth.js';

const router = express.Router();

// 1. GET /api/campaigns - List all campaigns
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      include: {
        ads: {
          include: {
            track: true
          }
        }
      },
      orderBy: { startDate: 'desc' }
    });
    res.json(campaigns);
  } catch (error) {
    logger.error('Failed to retrieve campaigns: %O', error);
    res.status(500).json({ error: 'Failed to retrieve campaigns' });
  }
});

// 2. POST /api/campaigns - Create a new campaign
router.post('/', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const {
    clientName,
    clientIndustry,
    name,
    startDate,
    endDate,
    targetPlays,
    targetImpressions,
    cpc,
    dailyCap,
    hourlyCap,
    validHoursStart,
    validHoursEnd,
    priority,
    isActive,
    trackIds // Array of track IDs to link
  } = req.body;

  // Validation
  if (!clientName || !name || !startDate || !endDate || !targetPlays) {
    return res.status(400).json({ error: 'Missing required campaign fields' });
  }

  try {
    const campaign = await prisma.campaign.create({
      data: {
        clientName,
        clientIndustry: clientIndustry || 'General',
        name,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        targetPlays: parseInt(targetPlays),
        targetImpressions: parseInt(targetImpressions || 0),
        cpc: parseFloat(cpc || 0),
        dailyCap: parseInt(dailyCap || 100),
        hourlyCap: parseInt(hourlyCap || 10),
        validHoursStart: parseInt(validHoursStart ?? 0),
        validHoursEnd: parseInt(validHoursEnd ?? 23),
        priority: parseInt(priority || 1),
        isActive: isActive !== false
      }
    });

    // Link tracks if provided
    if (Array.isArray(trackIds) && trackIds.length > 0) {
      const adTracksData = trackIds.map(id => ({
        campaignId: campaign.id,
        trackId: parseInt(id)
      }));
      await prisma.adTrack.createMany({
        data: adTracksData
      });
    }

    const createdCampaign = await prisma.campaign.findUnique({
      where: { id: campaign.id },
      include: { ads: { include: { track: true } } }
    });

    logger.info('Campaign created: "%s" for client "%s"', name, clientName);
    res.status(201).json(createdCampaign);
  } catch (error) {
    logger.error('Failed to create campaign: %O', error);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// 3. PATCH /api/campaigns/:id - Update an existing campaign
router.patch('/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const { id } = req.params;
  const {
    clientName,
    clientIndustry,
    name,
    startDate,
    endDate,
    targetPlays,
    targetImpressions,
    cpc,
    dailyCap,
    hourlyCap,
    validHoursStart,
    validHoursEnd,
    priority,
    isActive,
    trackIds
  } = req.body;

  try {
    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const updateData = {};
    if (clientName !== undefined) updateData.clientName = clientName;
    if (clientIndustry !== undefined) updateData.clientIndustry = clientIndustry;
    if (name !== undefined) updateData.name = name;
    if (startDate !== undefined) updateData.startDate = new Date(startDate);
    if (endDate !== undefined) updateData.endDate = new Date(endDate);
    if (targetPlays !== undefined) updateData.targetPlays = parseInt(targetPlays);
    if (targetImpressions !== undefined) updateData.targetImpressions = parseInt(targetImpressions);
    if (cpc !== undefined) updateData.cpc = parseFloat(cpc);
    if (dailyCap !== undefined) updateData.dailyCap = parseInt(dailyCap);
    if (hourlyCap !== undefined) updateData.hourlyCap = parseInt(hourlyCap);
    if (validHoursStart !== undefined) updateData.validHoursStart = parseInt(validHoursStart);
    if (validHoursEnd !== undefined) updateData.validHoursEnd = parseInt(validHoursEnd);
    if (priority !== undefined) updateData.priority = parseInt(priority);
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await prisma.campaign.update({
      where: { id },
      data: updateData
    });

    // Update track links if provided
    if (trackIds !== undefined && Array.isArray(trackIds)) {
      // Clear old links
      await prisma.adTrack.deleteMany({ where: { campaignId: id } });
      if (trackIds.length > 0) {
        const adTracksData = trackIds.map(tId => ({
          campaignId: id,
          trackId: parseInt(tId)
        }));
        await prisma.adTrack.createMany({
          data: adTracksData
        });
      }
    }

    const finalCampaign = await prisma.campaign.findUnique({
      where: { id },
      include: { ads: { include: { track: true } } }
    });

    logger.info('Campaign updated: "%s"', updated.name);
    res.json(finalCampaign);
  } catch (error) {
    logger.error('Failed to update campaign: %O', error);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// 4. DELETE /api/campaigns/:id - Delete a campaign
router.delete('/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    await prisma.campaign.delete({ where: { id } });
    logger.info('Campaign deleted: ID %s', id);
    res.json({ message: 'Campaign deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete campaign: %O', error);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

export default router;
