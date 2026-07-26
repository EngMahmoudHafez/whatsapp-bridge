import { jidNormalizedUser } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';
import { config } from '../config/index.js';

export function buildMessageStoreKeys(key) {
  if (!key?.remoteJid || !key?.id) return [];
  const raw = `${key.remoteJid}:${key.id}`;
  const normalized = jidNormalizedUser(key.remoteJid);
  if (normalized && normalized !== key.remoteJid) {
    return [raw, `${normalized}:${key.id}`];
  }
  return [raw];
}

export function pruneMessageStore(store) {
  if (!store || store.size === 0) return;
  const now = Date.now();

  if (config.MESSAGE_STORE_TTL_MS > 0) {
    for (const [key, entry] of store) {
      if (now - entry.timestamp > config.MESSAGE_STORE_TTL_MS) {
        store.delete(key);
      }
    }
  }

  if (config.MESSAGE_STORE_MAX > 0 && store.size > config.MESSAGE_STORE_MAX) {
    for (const key of store.keys()) {
      store.delete(key);
      if (store.size <= config.MESSAGE_STORE_MAX) break;
    }
  }
}

export function cacheMessage(session, msg) {
  if (!msg?.message) return;
  if (!session.messageStore) {
    session.messageStore = new Map();
  }
  const keys = buildMessageStoreKeys(msg.key);
  if (!keys.length) return;
  const entry = { message: msg.message, timestamp: Date.now() };
  for (const key of keys) {
    session.messageStore.set(key, entry);
  }
  pruneMessageStore(session.messageStore);
}

export function getMessageFromStore(messageStore, key) {
  if (!messageStore) return undefined;
  const keys = buildMessageStoreKeys(key);
  if (!keys.length) return undefined;
  const now = Date.now();
  for (const storeKey of keys) {
    const entry = messageStore.get(storeKey);
    if (!entry) continue;
    if (config.MESSAGE_STORE_TTL_MS > 0 && now - entry.timestamp > config.MESSAGE_STORE_TTL_MS) {
      messageStore.delete(storeKey);
      continue;
    }
    return entry.message;
  }
  return undefined;
}

