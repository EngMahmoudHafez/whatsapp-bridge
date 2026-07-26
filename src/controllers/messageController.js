import { sessions } from '../services/sessionService.js';
import { sanitizeSessionId, normalizeJid } from '../utils/validation.js';
import { cacheMessage } from '../utils/messageStore.js';
import { recordPollCreation } from '../utils/pollUtils.js';
import { normalizeInteractiveContent } from '../utils/messageUtils.js';
import { hydratedTemplate, InteractiveValidationError, sendButtons as sendButtonsHelper } from 'baileys_helpers';
import { jidNormalizedUser } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';
import { logger } from '../logger.js';
import { config } from '../config/index.js';
import axios from 'axios';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 4096;
const BULK_CONCURRENCY = 5;

function requestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function connectedSession(sessionId) {
  const session = sessions.get(sessionId);
  return session?.status === 'open' ? session : null;
}

function decodeBase64Image(imageBase64) {
  if (typeof imageBase64 !== 'string') return null;
  const encoded = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (!encoded || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) return null;
  const decodedImage = Buffer.from(encoded, 'base64');
  return decodedImage.length > 0 && decodedImage.length <= MAX_IMAGE_BYTES
    ? decodedImage
    : null;
}

async function downloadImage(imageUrl) {
  const parsedUrl = new URL(imageUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('imageUrl must start with http:// or https://');
  }
  const response = await axios.get(parsedUrl.toString(), {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES
  });
  return Buffer.from(response.data);
}

function imageRequest(body) {
  const { to, imageUrl, imageBase64, caption } = body || {};
  if (!to) throw requestError("'to' is required.");
  if (!imageUrl && !imageBase64) {
    throw requestError("Either 'imageUrl' or 'imageBase64' is required.");
  }
  return { to, imageUrl, imageBase64, caption };
}

async function imageBytes(imageSource, logContext) {
  if (!imageSource.imageUrl) {
    const decodedImage = decodeBase64Image(imageSource.imageBase64);
    if (!decodedImage) throw requestError('Invalid or oversized base64 image data.');
    return decodedImage;
  }
  try {
    return await downloadImage(imageSource.imageUrl);
  } catch (error) {
    logger.warn({ err: error, ...logContext }, 'image download failed');
    throw requestError('Failed to download image from URL');
  }
}

function bulkRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw requestError('recipients must be a non-empty array.');
  }
  if (recipients.length > config.MAX_BULK_SIZE) {
    throw requestError(`Maximum ${config.MAX_BULK_SIZE} recipients allowed per request.`);
  }
  return recipients;
}

function bulkMessage(message) {
  if (typeof message !== 'string' || !message) {
    throw requestError('message is required and must be a string.');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw requestError(`Message cannot exceed ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return message;
}

function bulkDelay(delay) {
  const delayMs = Number(delay ?? 1000);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) {
    throw requestError('delay must be between 0 and 60000 milliseconds.');
  }
  return delayMs;
}

async function sendBulkRecipient({ session, sessionId, message, recipient }) {
  const phone = typeof recipient === 'string' ? recipient : recipient?.phone || recipient?.to;
  const jid = normalizeJid(phone);
  if (!jid) return { recipient, success: false, error: 'Invalid phone number format' };
  try {
    const messageReceipt = await session.sock.sendMessage(jid, { text: message });
    if (messageReceipt?.message) cacheMessage(session, messageReceipt);
    return { recipient, success: true, messageId: messageReceipt?.key?.id || null };
  } catch (error) {
    logger.error({ err: error, sessionId, recipient }, 'bulk message failed');
    return { recipient, success: false, error: error.message };
  }
}

async function sendBulkBatches(session, sessionId, bulkRequest) {
  const deliveries = [];
  for (let index = 0; index < bulkRequest.recipients.length; index += BULK_CONCURRENCY) {
    const recipients = bulkRequest.recipients.slice(index, index + BULK_CONCURRENCY);
    const requests = recipients.map((recipient) =>
      sendBulkRecipient({ session, sessionId, message: bulkRequest.message, recipient })
    );
    deliveries.push(...(await Promise.all(requests)));
    if (index + BULK_CONCURRENCY < bulkRequest.recipients.length && bulkRequest.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, bulkRequest.delayMs));
    }
  }
  return deliveries;
}

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

export async function sendImage(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const imagePayload = imageRequest(req.body);
    const session = connectedSession(sessionId);
    if (!session) {
      res.status(409).json({ error: 'Session is not connected.' });
      return;
    }
    const jid = normalizeJid(imagePayload.to);
    if (!jid) {
      res.status(400).json({ error: 'Recipient is invalid.' });
      return;
    }
    const messageReceipt = await session.sock.sendMessage(jid, {
      image: await imageBytes(imagePayload, { sessionId, imageUrl: imagePayload.imageUrl }),
      caption: imagePayload.caption ? String(imagePayload.caption) : ''
    });
    if (messageReceipt?.message) cacheMessage(session, messageReceipt);
    logger.info({ sessionId, to: jid, messageId: messageReceipt?.key?.id }, 'sent image');
    res.json({ id: messageReceipt?.key?.id || null });
  } catch (error) {
    next(error);
  }
}

export async function sendBulk(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const bulkRequest = {
      recipients: bulkRecipients(req.body?.recipients),
      message: bulkMessage(req.body?.message),
      delayMs: bulkDelay(req.body?.delay)
    };
    const session = connectedSession(sessionId);
    if (!session) {
      res.status(409).json({ error: 'Session is not connected.' });
      return;
    }
    const deliveries = await sendBulkBatches(session, sessionId, bulkRequest);
    const success = deliveries.filter((delivery) => delivery.success).length;
    logger.info(
      { sessionId, total: deliveries.length, success, failed: deliveries.length - success },
      'bulk messaging completed'
    );
    res.json({ total: deliveries.length, success, failed: deliveries.length - success, results: deliveries });
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

