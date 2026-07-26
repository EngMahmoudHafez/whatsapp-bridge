import express from 'express';
import pinoHttp from 'pino-http';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { restoreSessions } from './services/sessionService.js';
import { authMiddleware } from './middleware/auth.js';
import routes from './routes/index.js';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.use('/api', routes);

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get(['/', '/index.html'], authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    req.log.error({ err: error }, 'request failed');
  } else {
    req.log.warn({ err: error }, 'request rejected');
  }
  res.status(statusCode).json({ error: error.message || 'Internal error.' });
});

async function start() {
  await fs.mkdir(config.SESSION_DIR, { recursive: true });
  app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, logFile: config.LOG_FILE },
      'server listening'
    );
  });
  restoreSessions(logger);
}

start().catch((error) => {
  logger.fatal({ err: error }, 'server failed to start');
  process.exit(1);
});
