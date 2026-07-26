import crypto from 'crypto';
import { jidNormalizedUser } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';

export function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function normalizeEventJid(value) {
  if (!value || typeof value !== 'string') return '';
  return jidNormalizedUser(value) || value;
}

export function safeStringify(value, logger) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logger.warn({ err: error }, 'event payload not serializable');
    return '';
  }
}

export function buildEventFingerprint(type, data, logger) {
  switch (type) {
    case 'connection_update':
      return {
        type,
        connection: data.connection || data.status || '',
        status: data.status || data.connection || '',
        qr: data.qr ? hashValue(data.qr) : '',
        disconnect: data.lastDisconnect?.statusCode || ''
      };
    case 'message':
      return {
        type,
        messageId: data.messageId || '',
        from: normalizeEventJid(data.from),
        timestamp: data.timestamp || ''
      };
    case 'button_reply':
      return {
        type,
        messageId: data.messageId || '',
        responseType: data.responseType || '',
        id: data.id || '',
        name: data.name || '',
        selectedRowId: data.selectedRowId || ''
      };
    case 'list_reply':
      return {
        type,
        messageId: data.messageId || '',
        selectedRowId: data.selectedRowId || ''
      };
    case 'poll':
      return {
        type,
        messageId: data.messageId || '',
        pollName: data.pollName || ''
      };
    case 'poll_vote':
      return {
        type,
        pollVoteMessageId: data.pollVoteMessageId || '',
        pollMessageId: data.pollMessageId || '',
        voter: normalizeEventJid(data.voter),
        selectedOptions: Array.isArray(data.selectedOptions)
          ? data.selectedOptions.join('|')
          : ''
      };
    case 'message_update':
      return {
        type,
        messageId: data.messageId || '',
        status: data.update?.update?.status ?? data.update?.status ?? '',
        from: normalizeEventJid(data.from),
        updateHash: data.update?.update
          ? hashValue(safeStringify(data.update.update, logger))
          : ''
      };
    default:
      return { type, hash: data ? hashValue(safeStringify(data, logger)) : '' };
  }
}

export function buildEventId(session, type, data, logger) {
  const fingerprint = buildEventFingerprint(type, data, logger);
  const payload = {
    sessionId: session.id,
    ...fingerprint
  };
  return hashValue(safeStringify(payload, logger));
}

