import { authenticate, createSession, deleteSession } from '../middleware/auth.js';

export function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (!authenticate(username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const sessionId = createSession(username);
  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });

  res.json({ success: true, message: 'Login successful' });
}

export function logout(req, res) {
  const sessionId = req.cookies?.sessionId;
  if (sessionId) {
    deleteSession(sessionId);
  }
  res.clearCookie('sessionId');
  res.json({ success: true, message: 'Logout successful' });
}

export function checkAuth(req, res) {
  res.json({ authenticated: true, user: req.user });
}

