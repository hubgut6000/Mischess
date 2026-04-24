'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { getPool } = require('./db/pool');
const { migrate } = require('./db/schema');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const gameRoutes = require('./routes/games');
const friendsRoutes = require('./routes/friends');
const { initWebSocket } = require('./ws');
const { startAnalysisQueue } = require('./anticheat');
const { csrfMiddleware } = require('./csrf');

const PORT = process.env.PORT || 3000;

async function boot() {
  // Run DB migrations before accepting any traffic
  try {
    await migrate(getPool());
  } catch (e) {
    console.error('[boot] migration failed — is DATABASE_URL set?', e);
    process.exit(1);
  }

  const app = express();
  const server = http.createServer(app);

  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      }
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
  app.use('/api/', globalLimiter);

  // CSRF protection for state-changing API routes
  app.use('/api/', csrfMiddleware);

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/games', gameRoutes);
  app.use('/api/friends', friendsRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    etag: true,
  }));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  initWebSocket(server);
  startAnalysisQueue();

  server.listen(PORT, () => {
    console.log(`[mischess] server listening on :${PORT}`);
  });
}

boot().catch(err => {
  console.error('[boot] fatal', err);
  process.exit(1);
});

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
