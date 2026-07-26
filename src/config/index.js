import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requiredEnvironmentVariable(name) {
  const configuredValue = process.env[name]?.trim();
  if (!configuredValue) {
    throw new Error(`${name} must be set in the environment.`);
  }
  return configuredValue;
}

function dashboardPassword() {
  const password = requiredEnvironmentVariable('AUTH_PASSWORD');
  if (password.length < 12 || password === 'replace-with-a-long-random-password') {
    throw new Error('AUTH_PASSWORD must be changed to a value of at least 12 characters.');
  }
  return password;
}

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
  AUTH_USERNAME: process.env.AUTH_USERNAME || 'admin',
  AUTH_PASSWORD: dashboardPassword(),
  AUTH_COOKIE_NAME: 'sessionId',
  AUTH_SESSION_TTL_MS: 24 * 60 * 60 * 1000,
  COOKIE_SECURE: process.env.NODE_ENV === 'production'
};

