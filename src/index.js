import express from 'express';
import dotenv from 'dotenv';
import pino from 'pino';
import pinoHttp from 'pino-http';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { restoreSessions } from './services/sessionService.js';
import { authMiddleware } from './middleware/auth.js';
import routes from './routes/index.js';
import fs from 'fs/promises';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: config.LOG_LEVEL });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// API routes (with auth middleware)
app.use('/api', routes);

// Protected routes - redirect to login if not authenticated
app.get('/', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Error handler
app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  logger.error({ error }, 'request error');
  res.status(statusCode).json({ error: error.message || 'Internal error.' });
});

async function start() {
  await fs.mkdir(config.SESSION_DIR, { recursive: true });
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'server listening');
  });
  restoreSessions(logger);
}

start().catch((error) => {
  logger.error({ error }, 'server failed to start');
  process.exit(1);
});
