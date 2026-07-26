import crypto from 'crypto';
import { config } from '../config/index.js';

const dashboardSessions = new Map();

export function createSession(userId) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  dashboardSessions.set(sessionId, {
    userId,
    expiresAt: Date.now() + config.AUTH_SESSION_TTL_MS
  });
  return sessionId;
}

export function getSession(sessionId) {
  const dashboardSession = dashboardSessions.get(sessionId);
  if (!dashboardSession) return null;
  if (dashboardSession.expiresAt <= Date.now()) {
    dashboardSessions.delete(sessionId);
    return null;
  }
  return dashboardSession;
}

export function deleteSession(sessionId) {
  dashboardSessions.delete(sessionId);
}

export function authenticate(username, password) {
  const suppliedCredentials = Buffer.from(`${username}\0${password}`);
  const expectedCredentials = Buffer.from(
    `${config.AUTH_USERNAME}\0${config.AUTH_PASSWORD}`
  );
  if (suppliedCredentials.length !== expectedCredentials.length) return false;
  return crypto.timingSafeEqual(suppliedCredentials, expectedCredentials);
}

export function authMiddleware(req, res, next) {
  const sessionId = req.cookies?.[config.AUTH_COOKIE_NAME];
  const dashboardSession = sessionId ? getSession(sessionId) : null;
  if (!dashboardSession) return rejectUnauthorizedRequest(req, res);

  req.user = dashboardSession;
  next();
}

function rejectUnauthorizedRequest(req, res) {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login.html');
}

