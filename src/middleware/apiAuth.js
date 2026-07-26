import crypto from 'crypto';
import { config } from '../config/index.js';

function suppliedApiKey(req) {
  const headerKey = req.get('x-api-key');
  if (headerKey) return headerKey;

  const authorization = req.get('authorization');
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] || null;
}

function matchesConfiguredApiKey(candidate) {
  if (!candidate || !config.API_KEY) return false;
  const supplied = Buffer.from(candidate);
  const expected = Buffer.from(config.API_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function apiAuthMiddleware(req, res, next) {
  if (!config.API_KEY || matchesConfiguredApiKey(suppliedApiKey(req))) {
    next();
    return;
  }

  req.log?.warn({ ip: req.ip, path: req.path }, 'unauthorized API request');
  res.status(401).json({
    error: 'Unauthorized',
    message: 'Valid API key required. Send it in X-API-Key or Authorization: Bearer <key>.'
  });
}
