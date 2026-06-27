import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import logger from './logger.js';
import prisma from './db.js';

// Route Imports
import authRoutes from './routes/auth.js';
import trackRoutes from './routes/tracks.js';
import categoryRoutes from './routes/categories.js';
import playlistRoutes from './routes/playlists.js';
import settingsRoutes from './routes/settings.js';
import analyticsRoutes from './routes/analytics.js';
import publicRoutes from './routes/public.js';
import icecastAnalyticsRoutes from './routes/icecastAnalytics.js';
import logRoutes from './routes/logs.js';
import queueRoutes from './routes/queue.js';
import systemRoutes from './routes/system.js';

// Playout Engine Import
import playoutEngine from './playout/engine.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());

// Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Http Request Logger (Morgan integration with Winston)
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Serve Public folder (dashboard front-end and dynamic assets)
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/analytics/icecast', icecastAnalyticsRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/system', systemRoutes);

// Intercept root and SPA fallbacks to inject dynamic database settings (SEO, OG, favicon, theme)
const serveDynamicIndex = async (req, res) => {
  try {
    const indexPath = path.join(__dirname, '../public/index.html');
    if (!fs.existsSync(indexPath)) {
      return res.status(404).send('index.html not found');
    }
    let html = fs.readFileSync(indexPath, 'utf8');

    // Fetch database configurations
    const dbSettings = await prisma.systemSetting.findMany();
    const settings = {};
    dbSettings.forEach(s => {
      try {
        settings[s.key] = JSON.parse(s.value);
      } catch {
        settings[s.key] = s.value;
      }
    });

    const theme = settings.theme || {
      primary: '#00f0ff',
      secondary: '#7000ff',
      background: '#0d101f',
      logoUrl: '/images/default-logo.svg',
      faviconUrl: '/favicon.ico'
    };

    const station = settings.station_info || {
      name: 'RadioPlay One',
      tagline: 'The Ultimate Web Automation System'
    };

    const seo = settings.seo || {
      title: 'RadioPlay One - Premium Playout Automation',
      metaDescription: 'The ultimate web playout automation system.',
      openGraphTitle: 'RadioPlay One',
      openGraphDescription: 'The ultimate web playout automation system.',
      openGraphImageUrl: theme.logoUrl || '/images/default-logo.svg'
    };

    // Replace placeholders
    html = html.replace(/\{\{SEO_TITLE\}\}/g, seo.title || station.name);
    html = html.replace(/\{\{SEO_DESCRIPTION\}\}/g, seo.metaDescription || station.tagline);
    html = html.replace(/\{\{FAVICON_URL\}\}/g, theme.faviconUrl || '/favicon.ico');
    html = html.replace(/\{\{OG_TITLE\}\}/g, seo.openGraphTitle || station.name);
    html = html.replace(/\{\{OG_DESCRIPTION\}\}/g, seo.openGraphDescription || station.tagline);
    html = html.replace(/\{\{OG_IMAGE\}\}/g, seo.openGraphImageUrl || theme.logoUrl || '/images/default-logo.svg');
    html = html.replace(/\{\{THEME_BACKGROUND\}\}/g, theme.background || '#0d101f');

    res.send(html);
  } catch (err) {
    logger.error('Failed serving dynamic index: %O', err);
    res.status(500).send('Internal Server Error');
  }
};

app.get('/', serveDynamicIndex);
app.get('/index.html', serveDynamicIndex);

// Fallback route: serve index.html for SPAs
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.includes('.')) {
    return next();
  }
  serveDynamicIndex(req, res);
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled express request error: %O', err);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// Start Playout and Web Server
const startServer = async () => {
  try {
    // 1. Verify database connection
    await prisma.$connect();
    logger.info('Connected to the database successfully.');

    // 2. Start Express Web server
    app.listen(PORT, () => {
      logger.info(`RadioPlay Web Portal listening on port ${PORT}`);
    });

    // 3. Start Playout Automation Loop
    // To prevent boot loops in testing if ffmpeg/icecast isn't running,
    // we can control this via an env variable
    if (process.env.START_PLAYOUT_ON_BOOT !== 'false') {
      await playoutEngine.start();
      logger.info('Playout Engine started successfully.');
    } else {
      logger.warn('Playout Engine disabled on boot via environment setting.');
    }

  } catch (error) {
    logger.error('Critical boot error: %O', error);
    process.exit(1);
  }
};

startServer();
