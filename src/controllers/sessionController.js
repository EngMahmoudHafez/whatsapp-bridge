import { sessions, getOrCreateSession, deleteStoredSession, waitForSessionQr, saveSessionConfig } from '../services/sessionService.js';
import { sanitizeSessionId, buildWebhookConfig } from '../utils/validation.js';
import { logger } from '../logger.js';

export async function listSessions(req, res) {
  const list = Array.from(sessions.values()).map((session) => ({
    id: session.id,
    status: session.status,
    lastMessageAt: session.lastMessageAt
  }));
  res.json({ sessions: list });
}

export async function getSession(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json({
      id: session.id,
      status: session.status,
      lastMessageAt: session.lastMessageAt,
      phoneNumber: session.identity?.phoneNumber || null,
      userJid: session.identity?.userJid || null,
      lid: session.identity?.lid || null,
      name: session.identity?.name || null
    });
  } catch (error) {
    next(error);
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function connectionRequest(req) {
  const sessionId = sanitizeSessionId(req.params.id);
  const { mode = 'qr', phoneNumber, waitMs, webhookUrl, webhookSecret, reset } = req.body || {};
  if (mode !== 'qr' && mode !== 'pair') throw badRequest("mode must be 'qr' or 'pair'.");
  if (mode === 'pair' && (!phoneNumber || typeof phoneNumber !== 'string')) {
    throw badRequest('phoneNumber is required for pair mode.');
  }
  return {
    sessionId,
    mode,
    phoneNumber,
    waitMs,
    reset: Boolean(reset),
    webhookUrl,
    webhookSecret
  };
}

async function configuredSession(connection) {
  if (connection.reset) {
    await deleteStoredSession(connection.sessionId, logger);
  }
  const session = await getOrCreateSession(connection.sessionId, logger);
  if (connection.webhookUrl !== undefined || connection.webhookSecret !== undefined) {
    session.webhook = buildWebhookConfig(
      {
        webhookUrl: connection.webhookUrl,
        webhookSecret: connection.webhookSecret
      },
      session.webhook
    );
    await saveSessionConfig(session.authPath, { webhook: session.webhook }, logger);
  }
  return session;
}

function sessionResponse(session, connectionDetails) {
  return {
    id: session.id,
    status: session.status,
    webhookUrl: session.webhook?.url || null,
    phoneNumber: session.identity?.phoneNumber || null,
    userJid: session.identity?.userJid || null,
    lid: session.identity?.lid || null,
    name: session.identity?.name || null,
    ...connectionDetails
  };
}

async function sendPairingResponse(req, res, session, connection) {
  const pairingCode = await session.sock.requestPairingCode(connection.phoneNumber);
  req.log.info({ sessionId: session.id, mode: connection.mode }, 'session pairing code created');
  res.json(sessionResponse(session, { pairingCode }));
}

async function sendQrResponse(req, res, session, connection) {
  const qr = await waitForSessionQr(session, connection.waitMs);
  if (!qr) {
    req.log.warn({ sessionId: session.id, status: session.status }, 'session QR not ready');
    res.status(202).json(sessionResponse(session, { qr: null }));
    return;
  }
  req.log.info({ sessionId: session.id, mode: connection.mode }, 'session QR created');
  res.json(sessionResponse(session, { qr }));
}

export async function connectSession(req, res, next) {
  try {
    const connection = connectionRequest(req);
    req.log.info(
      { sessionId: connection.sessionId, mode: connection.mode, reset: connection.reset },
      'session connection requested'
    );
    const session = await configuredSession(connection);
    if (connection.mode === 'pair') {
      await sendPairingResponse(req, res, session, connection);
      return;
    }
    await sendQrResponse(req, res, session, connection);
  } catch (error) {
    next(error);
  }
}

export async function getSessionQr(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const session = await getOrCreateSession(sessionId, logger);
    if (!session.qr) {
      res.status(404).json({ error: 'QR not ready yet.', status: session.status });
      return;
    }
    res.json({ sessionId, qr: session.qr });
  } catch (error) {
    next(error);
  }
}

export async function pairSession(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const { phoneNumber } = req.body || {};
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      throw badRequest('phoneNumber is required.');
    }
    const session = await getOrCreateSession(sessionId, logger);
    const pairingCode = await session.sock.requestPairingCode(phoneNumber);
    res.json({ sessionId, pairingCode });
  } catch (error) {
    next(error);
  }
}

export async function deleteSession(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    await deleteStoredSession(sessionId, logger);
    res.json({ id: sessionId, status: 'logged_out', deleted: true });
  } catch (error) {
    next(error);
  }
}

