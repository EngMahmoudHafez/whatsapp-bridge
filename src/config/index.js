import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  PORT: Number(process.env.PORT || 3000),
  SESSION_DIR: process.env.SESSION_DIR
    ? path.resolve(process.env.SESSION_DIR)
    : path.join(__dirname, '..', '..', 'data', 'sessions'),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  SESSION_CONFIG_FILE: 'session.json',
  IDEMPOTENCY_TTL_MS: Number(process.env.IDEMPOTENCY_TTL_MS || 600000),
  IDEMPOTENCY_MAX_KEYS: Number(process.env.IDEMPOTENCY_MAX_KEYS || 20000),
  MESSAGE_STORE_TTL_MS: Number(process.env.MESSAGE_STORE_TTL_MS || 3600000),
  MESSAGE_STORE_MAX: Number(process.env.MESSAGE_STORE_MAX || 5000),
  // Auth config
  AUTH_USERNAME: process.env.AUTH_USERNAME || 'admin',
  AUTH_PASSWORD: process.env.AUTH_PASSWORD || 'admin123',
  SESSION_SECRET: process.env.SESSION_SECRET || 'whatsapp-bridge-secret-key-change-in-production'
};

