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
  try {
    await axios.post(webhook.url, payload, {
      headers: {
        'Content-Type': 'application/json',
        ...(eventId ? { 'x-event-id': eventId } : {}),
        ...(webhook.secret ? { 'x-webhook-secret': webhook.secret } : {})
      },
      timeout: 10000
    });
  } catch (error) {
    logger.error({ error }, 'webhook request failed');
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

