import { config } from '../config/index.js';

// Simple in-memory session store
const sessions = new Map();

export function createSession(userId) {
  const sessionId = Math.random().toString(36).substring(7) + Date.now().toString(36);
  sessions.set(sessionId, {
    userId,
    createdAt: Date.now()
  });
  return sessionId;
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

export function authenticate(username, password) {
  return username === config.AUTH_USERNAME && password === config.AUTH_PASSWORD;
}

export function authMiddleware(req, res, next) {
  // Allow access to login page, health check, and API login endpoint
  if (req.path === '/login.html' || req.path === '/health' || req.path === '/api/auth/login' || req.path.startsWith('/api/auth/')) {
    return next();
  }

  // Check for session cookie
  const sessionId = req.cookies?.sessionId;
  if (!sessionId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }

  const session = getSession(sessionId);
  if (!session) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }

  req.user = session;
  next();
}

