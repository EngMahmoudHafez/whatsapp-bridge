import { jidNormalizedUser } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';
import { getKeyAuthor } from '@whiskeysockets/baileys/lib/Utils/generics.js';
import { getPollCreation, getMessageSecret } from './messageUtils.js';

export function pollKeyFromMessageKey(key, fallbackRemoteJid) {
  const remoteJid = key?.remoteJid || fallbackRemoteJid || 'unknown';
  const id = key?.id || 'unknown';
  return `${remoteJid}:${id}`;
}

export function collectJidCandidates(key, meIdNormalized) {
  const candidates = [];

  const primary = getKeyAuthor(key, meIdNormalized || 'me');
  if (primary) candidates.push(primary);
  if (key?.senderPn) candidates.push(key.senderPn);
  if (key?.participant) candidates.push(key.participant);
  if (key?.remoteJid) candidates.push(key.remoteJid);

  const normalized = [];
  for (const jid of candidates) {
    const normalizedJid = jidNormalizedUser(jid);
    if (normalizedJid && normalizedJid !== jid) {
      normalized.push(normalizedJid);
    }
  }

  const unique = new Set();
  for (const jid of [...candidates, ...normalized]) {
    if (!jid) continue;
    unique.add(jid);
  }

  return Array.from(unique);
}

export function recordPollCreation(session, msg, meIdNormalized, logger) {
  const poll = getPollCreation(msg.message);
  if (!poll) return null;

  const pollKey = pollKeyFromMessageKey(msg.key, msg.key?.remoteJid);
  if (session.polls.has(pollKey)) return session.polls.get(pollKey);

  const pollEncKey = getMessageSecret(msg) || null;
  if (!pollEncKey) {
    logger.warn({ sessionId: session.id, pollKey }, 'poll creation missing secret key');
  }

  const pollData = {
    key: pollKey,
    message: msg.message,
    pollUpdates: [],
    pollEncKey,
    pollName: poll.name || '',
    options: (poll.options || []).map((option) => option.optionName || ''),
    selectableCount: poll.selectableOptionsCount || null,
    createdAt: Date.now(),
    creatorJids: collectJidCandidates(msg.key, meIdNormalized)
  };

  session.polls.set(pollKey, pollData);
  if (msg.key?.id) {
    session.pollsById.set(msg.key.id, pollData);
  }
  logger.info({ sessionId: session.id, pollKey }, 'saved poll creation');
  return pollData;
}

