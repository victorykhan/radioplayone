import express from 'express';
import prisma from '../db.js';
import logger from '../logger.js';
import { authenticateJWT, requireRole } from './auth.js';

const router = express.Router();

// 1. List all categories with track counts
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const categories = await prisma.trackCategory.findMany({
      include: {
        _count: {
          select: { tracks: { where: { isDeleted: false } } }
        }
      }
    });
    
    res.json(categories.map(cat => ({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      parentId: cat.parentId,
      trackCount: cat._count.tracks
    })));
  } catch (error) {
    logger.error('Failed listing categories: %O', error);
    res.status(500).json({ error: 'Failed to retrieve categories' });
  }
});

// 2. Create category
router.post('/', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
    const { name, description, parentId } = req.body;
  
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
  
    try {
      const existing = await prisma.trackCategory.findUnique({ where: { name } });
      if (existing) {
        return res.status(409).json({ error: 'Category with this name already exists' });
      }
  
      const category = await prisma.trackCategory.create({
        data: { 
          name, 
          description,
          parentId: parentId ? parseInt(parentId) : null
        }
      });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'CATEGORY_CREATED',
        details: `Created category: ${name}`
      }
    });

    res.status(201).json(category);
  } catch (error) {
    logger.error('Failed to create category: %O', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// 3. Update category
router.patch('/:id', authenticateJWT, requireRole(['ADMIN', 'PRODUCER']), async (req, res) => {
    const catId = parseInt(req.params.id);
    const { name, description, parentId } = req.body;
  
    try {
      const category = await prisma.trackCategory.findUnique({ where: { id: catId } });
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }
  
      if (name && name !== category.name) {
        const existing = await prisma.trackCategory.findUnique({ where: { name } });
        if (existing) {
          return res.status(409).json({ error: 'Category name already taken' });
        }
      }
  
      const updated = await prisma.trackCategory.update({
        where: { id: catId },
        data: { 
          name, 
          description,
          parentId: parentId !== undefined ? (parentId ? parseInt(parentId) : null) : undefined
        }
      });

    res.json(updated);
  } catch (error) {
    logger.error('Failed updating category: %O', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// 4. Delete category (does NOT delete tracks; they are just detached)
router.delete('/:id', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  const catId = parseInt(req.params.id);

  try {
    const category = await prisma.trackCategory.findUnique({ where: { id: catId } });
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    await prisma.trackCategory.delete({ where: { id: catId } });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'CATEGORY_DELETED',
        details: `Deleted category: ${category.name}`
      }
    });

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    logger.error('Failed deleting category: %O', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

export default router;
