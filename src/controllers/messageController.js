import { sessions } from '../services/sessionService.js';
import { sanitizeSessionId, normalizeJid } from '../utils/validation.js';
import { cacheMessage } from '../utils/messageStore.js';
import { recordPollCreation } from '../utils/pollUtils.js';
import { normalizeInteractiveContent } from '../utils/messageUtils.js';
import { hydratedTemplate, InteractiveValidationError, sendButtons as sendButtonsHelper } from 'baileys_helpers';
import { jidNormalizedUser } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';
import { logger } from '../logger.js';

export async function sendMessage(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const { to, message } = req.body || {};
    if (!to || !message) {
      res.status(400).json({ error: "Both 'to' and 'message' are required." });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'open') {
      res.status(409).json({ error: 'Session is not connected.' });
      return;
    }
    const jid = normalizeJid(to);
    if (!jid) {
      res.status(400).json({ error: 'Recipient is invalid.' });
      return;
    }
    const result = await session.sock.sendMessage(jid, { text: String(message) });
    if (result?.message) {
      cacheMessage(session, result);
    }
    logger.info({ sessionId, to: jid, messageId: result?.key?.id }, 'sent message');
    res.json({ id: result?.key?.id || null });
  } catch (error) {
    next(error);
  }
}

export async function sendPoll(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const { to, name, options, selectableCount } = req.body || {};
    if (!to || !name || !Array.isArray(options)) {
      res.status(400).json({ error: 'to, name, and options are required.' });
      return;
    }
    if (options.length < 2) {
      res.status(400).json({ error: 'options must have at least 2 entries.' });
      return;
    }
    const count = selectableCount ? Number(selectableCount) : 1;
    if (!Number.isInteger(count) || count < 1 || count > options.length) {
      res
        .status(400)
        .json({ error: 'selectableCount must be between 1 and the number of options.' });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'open') {
      res.status(409).json({ error: 'Session is not connected.' });
      return;
    }
    const jid = normalizeJid(to);
    if (!jid) {
      res.status(400).json({ error: 'Recipient is invalid.' });
      return;
    }
    const result = await session.sock.sendMessage(jid, {
      poll: {
        name: String(name),
        values: options.map((value) => String(value)),
        selectableCount: count
      }
    });
    if (result?.message) {
      cacheMessage(session, result);
      const meId = session.sock.user?.id;
      const meIdNormalized = meId ? jidNormalizedUser(meId) : 'me';
      recordPollCreation(session, result, meIdNormalized, logger);
    }
    logger.info({ sessionId, to: jid, messageId: result?.key?.id }, 'sent poll');
    res.json({ id: result?.key?.id || null });
  } catch (error) {
    next(error);
  }
}

export async function sendButtons(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const {
      to,
      text,
      buttons,
      footer,
      title,
      subtitle,
      contextInfo,
      options
    } = req.body || {};

    if (!to) {
      res.status(400).json({ error: 'to is required.' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'open') {
      res.status(409).json({ error: 'Session is not connected.' });
      return;
    }

    const jid = normalizeJid(to);
    if (!jid) {
      res.status(400).json({ error: 'Recipient is invalid.' });
      return;
    }

    const { stringifyButtonParams } = await import('../utils/messageUtils.js');
    const payload = { text, buttons: stringifyButtonParams(buttons || []) };
    if (footer !== undefined) payload.footer = footer;
    if (title !== undefined) payload.title = title;
    if (subtitle !== undefined) payload.subtitle = subtitle;
    if (contextInfo !== undefined) payload.contextInfo = contextInfo;

    const result = await sendButtonsHelper(session.sock, jid, payload, options || {});
    if (result?.message) {
      cacheMessage(session, result);
    }
    logger.info({ sessionId, to: jid, messageId: result?.key?.id }, 'sent buttons');
    res.json({ id: result?.key?.id || null });
  } catch (error) {
    if (error instanceof InteractiveValidationError || error?.name === 'InteractiveValidationError') {
      res.status(400).json({ error: error.toJSON ? error.toJSON() : error.message });
      return;
    }
    next(error);
  }
}

export async function sendInteractive(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const { to, options, ...content } = req.body || {};

    if (!to) {
      res.status(400).json({ error: 'to is required.' });
      return;
    }

    if (!content.interactiveButtons && !content.interactiveMessage) {
      res.status(400).json({
        error: 'interactiveButtons or interactiveMessage is required.'
      });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'open') {
      res.status(409).json({ error: 'Session is not connected.' });
      return;
    }

    const jid = normalizeJid(to);
    if (!jid) {
      res.status(400).json({ error: 'Recipient is invalid.' });
      return;
    }

    const payload = normalizeInteractiveContent(content);
    const result = await hydratedTemplate(session.sock, jid, payload, options || {});
    if (result?.message) {
      cacheMessage(session, result);
    }
    logger.info({ sessionId, to: jid, messageId: result?.key?.id }, 'sent interactive message');
    res.json({ id: result?.key?.id || null });
  } catch (error) {
    if (error instanceof InteractiveValidationError || error?.name === 'InteractiveValidationError') {
      res.status(400).json({ error: error.toJSON ? error.toJSON() : error.message });
      return;
    }
    next(error);
  }
}

