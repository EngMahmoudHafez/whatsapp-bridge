import {
  authenticate,
  createSession,
  deleteSession,
  getSession
} from '../middleware/auth.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

export function login(req, res) {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (!authenticate(username, password)) {
    logger.warn({ username, ip: req.ip }, 'dashboard login failed');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const sessionId = createSession(username);
  res.cookie(config.AUTH_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.COOKIE_SECURE,
    maxAge: config.AUTH_SESSION_TTL_MS
  });

  logger.info({ username, ip: req.ip }, 'dashboard login succeeded');
  res.json({ success: true, message: 'Login successful' });
}

export function logout(req, res) {
  const sessionId = req.cookies?.[config.AUTH_COOKIE_NAME];
  const dashboardSession = sessionId ? getSession(sessionId) : null;
  if (sessionId) {
    deleteSession(sessionId);
  }
  res.clearCookie(config.AUTH_COOKIE_NAME);
  logger.info({ username: dashboardSession?.userId, ip: req.ip }, 'dashboard logout');
  res.json({ success: true, message: 'Logout successful' });
}

export function checkAuth(req, res) {
  res.json({ authenticated: true, user: req.user });
}

