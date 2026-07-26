import axios from 'axios';
import { buildEventId, safeStringify } from '../utils/eventUtils.js';
import { config } from '../config/index.js';

export function shouldSendEvent(session, eventId) {
  if (!config.IDEMPOTENCY_TTL_MS || config.IDEMPOTENCY_TTL_MS <= 0) return true;
  if (!session.recentEvents) {
    session.recentEvents = new Map();
  }

  const now = Date.now();
  const existing = session.recentEvents.get(eventId);
  if (existing && now - existing < config.IDEMPOTENCY_TTL_MS) {
    return false;
  }

  session.recentEvents.set(eventId, now);

  if (session.recentEvents.size > config.IDEMPOTENCY_MAX_KEYS) {
    for (const [key, ts] of session.recentEvents) {
      if (now - ts > config.IDEMPOTENCY_TTL_MS) {
        session.recentEvents.delete(key);
      }
      if (session.recentEvents.size <= config.IDEMPOTENCY_MAX_KEYS) break;
    }
  }

  return true;
}

export async function postWebhook(session, payload, eventId, logger) {
  const webhook = session?.webhook || null;
  if (!webhook?.url) return;
  const attempts = Math.max(1, config.WEBHOOK_RETRIES);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await axios.post(webhook.url, payload, {
        headers: {
          'Content-Type': 'application/json',
          ...(eventId ? { 'x-event-id': eventId } : {}),
          ...(webhook.secret ? { 'x-webhook-secret': webhook.secret } : {})
        },
        timeout: config.WEBHOOK_TIMEOUT_MS
      });
      return;
    } catch (error) {
      if (attempt === attempts) {
        logger.error({ err: error, sessionId: session.id, attempt }, 'webhook request failed');
        return;
      }
      const retryDelay = 1000 * 2 ** (attempt - 1);
      logger.warn(
        { err: error, sessionId: session.id, attempt, retryDelay },
        'webhook request failed, retrying'
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

export async function emitWebhookEvent(session, type, data, logger) {
  if (!session) return;
  const eventId = buildEventId(session, type, data, logger);
  if (!shouldSendEvent(session, eventId)) return;
  await postWebhook(
    session,
    {
      type,
      eventId,
      sessionId: session.id,
      ...data
    },
    eventId,
    logger
  );
}

