import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { logger } from './logger.js';
import {
  restoreSessions,
  shutdownSessions,
  startSessionLockHeartbeat
} from './services/sessionService.js';
import { authMiddleware } from './middleware/auth.js';
import routes from './routes/index.js';
import integrationRoutes from './routes/integrationRoutes.js';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
let httpServer;
let isShuttingDown = false;

function originMatchesHost(origin, host) {
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function corsOptions(req, callback) {
  callback(null, {
    credentials: true,
    origin(origin, allowOrigin) {
      const sameHost = originMatchesHost(origin, req.get('host'));
      const allowed = !origin || sameHost || config.CORS_ORIGINS.includes('*') ||
        config.CORS_ORIGINS.includes(origin);
      allowOrigin(allowed ? null : new Error('Not allowed by CORS'), allowed);
    }
  });
}

app.use(cors(corsOptions));
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(pinoHttp({ logger, genReqId: (req) => req.id }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.use('/api', routes);
app.use('/sessions', integrationRoutes);

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get(['/', '/index.html', '/dashboard'], authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    req.log.error({ err: error }, 'request failed');
  } else {
    req.log.warn({ err: error }, 'request rejected');
  }
  res.status(statusCode).json({
    error: error.message || 'Internal error.',
    requestId: req.id
  });
});

async function start() {
  await fs.mkdir(config.SESSION_DIR, { recursive: true });
  await restoreSessions(logger);
  startSessionLockHeartbeat(logger);
  httpServer = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        logFile: config.LOG_FILE,
        apiAuth: config.API_KEY ? 'enabled' : 'disabled'
      },
      'server listening'
    );
  });
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'received shutdown signal');
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await shutdownSessions(signal, logger);
  logger.info('server shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start().catch((error) => {
  logger.fatal({ err: error }, 'server failed to start');
  process.exit(1);
});
