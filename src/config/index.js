import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function optionalEnvironmentVariable(name) {
  return process.env[name]?.trim() || null;
}

function dashboardPassword(apiKey) {
  const configuredPassword = optionalEnvironmentVariable('AUTH_PASSWORD');
  if (
    configuredPassword &&
    (configuredPassword.length < 12 ||
      configuredPassword === 'replace-with-a-long-random-password')
  ) {
    throw new Error('AUTH_PASSWORD must be changed to a value of at least 12 characters.');
  }
  return configuredPassword || apiKey;
}

const apiKey = optionalEnvironmentVariable('API_KEY');

export const config = {
  PORT: Number(process.env.PORT || 3000),
  SESSION_DIR: process.env.SESSION_DIR
    ? path.resolve(process.env.SESSION_DIR)
    : path.join(__dirname, '..', '..', 'data', 'sessions'),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FILE: path.resolve(process.env.LOG_FILE || './logs/app.log'),
  SESSION_CONFIG_FILE: 'session.json',
  IDEMPOTENCY_TTL_MS: Number(process.env.IDEMPOTENCY_TTL_MS || 600000),
  IDEMPOTENCY_MAX_KEYS: Number(process.env.IDEMPOTENCY_MAX_KEYS || 20000),
  MESSAGE_STORE_TTL_MS: Number(process.env.MESSAGE_STORE_TTL_MS || 3600000),
  MESSAGE_STORE_MAX: Number(process.env.MESSAGE_STORE_MAX || 5000),
  API_KEY: apiKey,
  CORS_ORIGINS: (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  MAX_BULK_SIZE: Number(process.env.MAX_BULK_SIZE || 100),
  WEBHOOK_TIMEOUT_MS: Number(process.env.WEBHOOK_TIMEOUT_MS || 10000),
  WEBHOOK_RETRIES: Number(process.env.WEBHOOK_RETRIES || 3),
  WHATSAPP_QUERY_TIMEOUT_MS: Number(process.env.WHATSAPP_QUERY_TIMEOUT_MS || 120000),
  SESSION_PROCESS_LOCK_FILE: '.bridge-session.lock',
  SESSION_PROCESS_LOCK_STALE_MS: 120000,
  SESSION_PROCESS_LOCK_HEARTBEAT_MS: 30000,
  SESSION_RECONNECT_DELAY_MS: 1000,
  SESSION_LOCK_RETRY_DELAY_MS: 5000,
  AUTH_USERNAME: process.env.AUTH_USERNAME || 'admin',
  AUTH_PASSWORD: dashboardPassword(apiKey),
  AUTH_COOKIE_NAME: 'sessionId',
  AUTH_SESSION_TTL_MS: 24 * 60 * 60 * 1000,
  COOKIE_SECURE: process.env.NODE_ENV === 'production'
};

