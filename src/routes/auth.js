import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import logger from '../logger.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-radio-key';

// Middleware to verify JWT
export const authenticateJWT = (req, res, next) => {
  let token = req.query.token;
  
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    logger.warn('Failed JWT verification attempt: %s', error.message);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Middleware for Role-Based Access Control
export const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied: insufficient permissions' });
    }
    next();
  };
};

// Register endpoint (only allows registration if zero users exist, or if request is by ADMIN)
router.post('/register', async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userCount = await prisma.user.count();
    
    // If users already exist, only an ADMIN can register a new user
    if (userCount > 0) {
      // Temporarily check if the current user is authenticated as ADMIN
      // For ease of local setup, we can allow this to check req.headers.authorization
      // Or simply block it unless authorized
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(403).json({ error: 'First user already created. Admin authorization required to register others.' });
      }
      
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Only administrators can create new users.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const resolvedRole = userCount === 0 ? 'ADMIN' : (role || 'VIEWER');

    const newUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: resolvedRole
      }
    });

    logger.info('User registered successfully: %s (Role: %s)', email, resolvedRole);
    
    res.status(201).json({ 
      message: 'User registered successfully', 
      user: { id: newUser.id, email: newUser.email, role: newUser.role } 
    });

  } catch (error) {
    logger.error('Registration error: %O', error);
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

// Login endpoint
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info('User logged in: %s', email);

    // Audit log
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'USER_LOGIN',
        details: `User logged in from API`
      }
    });

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role }
    });

  } catch (error) {
    logger.error('Login error: %O', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// Verify current token endpoint
router.get('/me', authenticateJWT, (req, res) => {
  res.json({ user: req.user });
});

// 1. List all users (ADMIN only)
router.get('/', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true
      },
      orderBy: { id: 'asc' }
    });
    res.json(users);
  } catch (error) {
    logger.error('Failed to list users: %O', error);
    res.status(500).json({ error: 'Failed to retrieve users directory' });
  }
});

// 2. Delete a user (ADMIN only, prevents self-deletion)
router.delete('/:id', authenticateJWT, requireRole(['ADMIN']), async (req, res) => {
  const targetId = parseInt(req.params.id);

  if (req.user.id === targetId) {
    return res.status(400).json({ error: 'Access denied: You cannot delete your own administrative account' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: targetId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await prisma.user.delete({ where: { id: targetId } });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'USER_DELETED',
        details: `Deleted user: ${user.email} (Role: ${user.role})`
      }
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete user: %O', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router;
