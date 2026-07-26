import { sessions, getOrCreateSession, cleanupSession, waitForSessionQr, saveSessionConfig } from '../services/sessionService.js';
import { sanitizeSessionId, buildWebhookConfig } from '../utils/validation.js';
import pino from 'pino';
import { config } from '../config/index.js';

const logger = pino({ level: config.LOG_LEVEL });

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

export async function connectSession(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const { mode = 'qr', phoneNumber, waitMs, webhookUrl, webhookSecret, reset } = req.body || {};
    if (mode !== 'qr' && mode !== 'pair') {
      res.status(400).json({ error: "mode must be 'qr' or 'pair'." });
      return;
    }

    if (reset || sessions.get(sessionId)?.status !== 'open') {
      await cleanupSession(sessionId, true, logger);
    }

    const session = await getOrCreateSession(sessionId, logger);
    if (!webhookUrl) {
      res.status(400).json({ error: 'webhookUrl is required.' });
      return;
    }

    const webhookConfig = buildWebhookConfig(
      { webhookUrl, webhookSecret },
      session.webhook
    );
    if (!webhookConfig) {
      res.status(400).json({ error: 'webhookUrl is invalid or could not be configured.' });
      return;
    }
    session.webhook = webhookConfig;
    await saveSessionConfig(session.authPath, { webhook: session.webhook }, logger);

    if (mode === 'pair') {
      if (!phoneNumber || typeof phoneNumber !== 'string') {
        res.status(400).json({ error: 'phoneNumber is required for pair mode.' });
        return;
      }
      const pairingCode = await session.sock.requestPairingCode(phoneNumber);
      res.json({
        id: session.id,
        status: session.status,
        pairingCode,
        webhookUrl: session.webhook?.url || null,
        phoneNumber: session.identity?.phoneNumber || null,
        userJid: session.identity?.userJid || null,
        lid: session.identity?.lid || null,
        name: session.identity?.name || null
      });
      return;
    }

    const qr = await waitForSessionQr(session, waitMs);
    if (!qr) {
      res.status(202).json({
        id: session.id,
        status: session.status,
        qr: null,
        webhookUrl: session.webhook?.url || null,
        phoneNumber: session.identity?.phoneNumber || null,
        userJid: session.identity?.userJid || null,
        lid: session.identity?.lid || null,
        name: session.identity?.name || null
      });
      return;
    }
    res.json({
      id: session.id,
      status: session.status,
      qr,
      webhookUrl: session.webhook?.url || null,
      phoneNumber: session.identity?.phoneNumber || null,
      userJid: session.identity?.userJid || null,
      lid: session.identity?.lid || null,
      name: session.identity?.name || null
    });
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

export async function deleteSession(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    await cleanupSession(sessionId, true, logger);
    res.json({ id: sessionId, status: 'logged_out', deleted: true });
  } catch (error) {
    next(error);
  }
}

