import fs from 'fs/promises';
import path from 'path';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import NodeCache from '@cacheable/node-cache';
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { jidNormalizedUser } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';
import {
  getAggregateVotesInPollMessage,
  updateMessageWithPollUpdate
} from '@whiskeysockets/baileys/lib/Utils/messages.js';
import { getKeyAuthor } from '@whiskeysockets/baileys/lib/Utils/generics.js';
import { config } from '../config/index.js';
import { parseWebhookUrl } from '../utils/validation.js';
import { getConnectedIdentity } from '../utils/jidUtils.js';
import { getMessageFromStore, cacheMessage } from '../utils/messageStore.js';
import { getPollCreation, getPrimaryMessageType, getMessageText, extractButtonReply, extractListReply } from '../utils/messageUtils.js';
import { pollKeyFromMessageKey, recordPollCreation } from '../utils/pollUtils.js';
import { emitWebhookEvent } from './webhookService.js';

export const sessions = new Map();
export const sessionLocks = new Map();
const sessionDeletionLocks = new Map();
const reconnectTimers = new Map();
const ownedSessionProcessLocks = new Map();
const messageRetryCaches = new Map();
let isShuttingDown = false;

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function createSessionInUseError(sessionId) {
  const error = new Error(`Session '${sessionId}' is already running in another bridge process.`);
  error.statusCode = 409;
  return error;
}

async function createSessionProcessLockFile(lockPath) {
  const handle = await fs.open(lockPath, 'wx');
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } finally {
    await handle.close();
  }
}

async function sessionProcessLockIsStale(lockPath) {
  try {
    const stats = await fs.stat(lockPath);
    return Date.now() - stats.mtimeMs > config.SESSION_PROCESS_LOCK_STALE_MS;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function removeSessionProcessLockFile(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function replaceStaleSessionProcessLock(sessionId, lockPath, logger) {
  if (!(await sessionProcessLockIsStale(lockPath))) throw createSessionInUseError(sessionId);
  logger.warn({ sessionId, lockPath }, 'removing stale session process lock');
  await removeSessionProcessLockFile(lockPath);
  try {
    await createSessionProcessLockFile(lockPath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw createSessionInUseError(sessionId);
    throw error;
  }
}

async function acquireSessionProcessLock(sessionId, logger) {
  if (ownedSessionProcessLocks.has(sessionId)) return;
  const authPath = path.join(config.SESSION_DIR, sessionId);
  const lockPath = path.join(authPath, config.SESSION_PROCESS_LOCK_FILE);
  await ensureDir(authPath);

  try {
    await createSessionProcessLockFile(lockPath);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await replaceStaleSessionProcessLock(sessionId, lockPath, logger);
  }

  ownedSessionProcessLocks.set(sessionId, lockPath);
  logger.info({ sessionId }, 'session process lock acquired');
}

async function releaseSessionProcessLock(sessionId, logger) {
  const lockPath = ownedSessionProcessLocks.get(sessionId);
  if (!lockPath) return;
  await removeSessionProcessLockFile(lockPath);
  ownedSessionProcessLocks.delete(sessionId);
  logger.info({ sessionId }, 'session process lock released');
}

function getMessageRetryCache(sessionId) {
  let cache = messageRetryCaches.get(sessionId);
  if (!cache) {
    cache = new NodeCache({ stdTTL: 3600, useClones: false });
    messageRetryCaches.set(sessionId, cache);
  }
  return cache;
}

function clearMessageRetryCache(sessionId) {
  const cache = messageRetryCaches.get(sessionId);
  if (!cache) return;
  cache.flushAll();
  messageRetryCaches.delete(sessionId);
}

function cancelSessionReconnect(sessionId) {
  const reconnectTimer = reconnectTimers.get(sessionId);
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimers.delete(sessionId);
}

async function removeSessionFiles(sessionId, logger) {
  const sessionPath = path.join(config.SESSION_DIR, sessionId);
  try {
    await fs.rm(sessionPath, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error, sessionId }, 'could not remove session files');
    throw error;
  }
}

async function logoutSession(sessionId, logger) {
  const existing = sessions.get(sessionId);
  if (!existing) return;
  existing.stopRequested = true;
  sessions.delete(sessionId);
  try {
    await existing.sock.logout();
  } catch (error) {
    logger.warn({ err: error, sessionId }, 'logout failed during deletion');
  }
}

async function performSessionDeletion(sessionId, logger) {
  cancelSessionReconnect(sessionId);
  const pendingSession = sessionLocks.get(sessionId);
  if (pendingSession) {
    try {
      await pendingSession;
    } catch (error) {
      logger.warn({ err: error, sessionId }, 'pending session failed before deletion');
    }
  }
  await acquireSessionProcessLock(sessionId, logger);
  await logoutSession(sessionId, logger);
  await removeSessionFiles(sessionId, logger);
  ownedSessionProcessLocks.delete(sessionId);
  clearMessageRetryCache(sessionId);
}

export async function deleteStoredSession(sessionId, logger) {
  const pendingDeletion = sessionDeletionLocks.get(sessionId);
  if (pendingDeletion) return pendingDeletion;
  const deletion = performSessionDeletion(sessionId, logger).finally(() => {
    sessionDeletionLocks.delete(sessionId);
  });
  sessionDeletionLocks.set(sessionId, deletion);
  return deletion;
}

async function loadSessionConfig(authPath, logger) {
  const configPath = path.join(authPath, config.SESSION_CONFIG_FILE);
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const webhook = parsed?.webhook || null;
    if (webhook?.url && typeof webhook.url === 'string') {
      let url = null;
      try {
        url = parseWebhookUrl(webhook.url);
      } catch (error) {
        logger.warn({ err: error, authPath }, 'session config has invalid webhook url');
        return { webhook: null };
      }
      return {
        webhook: {
          url,
          secret: webhook.secret ? String(webhook.secret) : ''
        }
      };
    }
    return { webhook: null };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn({ err: error, authPath }, 'could not load session config');
    }
    return { webhook: null };
  }
}

export async function saveSessionConfig(authPath, sessionConfig, logger) {
  try {
    await ensureDir(authPath);
    const configPath = path.join(authPath, config.SESSION_CONFIG_FILE);
    await fs.writeFile(configPath, JSON.stringify(sessionConfig, null, 2));
  } catch (error) {
    logger.error({ err: error, authPath }, 'failed to save session config');
    throw error;
  }
}

async function getLatestVersionSafe(logger) {
  try {
    return await fetchLatestBaileysVersion();
  } catch (error) {
    logger.warn({ err: error }, 'could not fetch Baileys version');
    return { version: undefined, isLatest: false };
  }
}

export async function createSession(sessionId, logger) {
  logger.info({ sessionId }, 'creating whatsapp session');
  const authPath = path.join(config.SESSION_DIR, sessionId);
  await ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const sessionConfig = await loadSessionConfig(authPath, logger);
  const { version } = await getLatestVersionSafe(logger);
  const messageStore = new Map();
  const baileysLogger = logger.child({ component: 'baileys', sessionId }, { level: 'warn' });

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    defaultQueryTimeoutMs: config.WHATSAPP_QUERY_TIMEOUT_MS,
    printQRInTerminal: false,
    browser: ['Windows', 'Chrome', '10.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
    },
    msgRetryCounterCache: getMessageRetryCache(sessionId),
    getMessage: async (key) => getMessageFromStore(messageStore, key)
  });

  const session = {
    id: sessionId,
    sock,
    saveCreds,
    authPath,
    webhook: sessionConfig.webhook,
    status: 'connecting',
    qr: null,
    lastMessageAt: null,
    recentEvents: new Map(),
    messageStore,
    identity: null,
    polls: new Map(),
    pollsById: new Map(),
    stopRequested: false
  };

  sessions.set(sessionId, session);
  logger.info({ sessionId, authPath }, 'whatsapp session added');

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (qr) {
      try {
        session.qr = await qrcode.toDataURL(qr);
        logger.info({ sessionId }, 'qr updated');
        qrcodeTerminal.generate(qr, { small: true });
      } catch (error) {
        logger.error({ err: error, sessionId }, 'failed to generate QR code');
      }
    }

    if (connection === 'open') {
      session.status = 'open';
      session.qr = null;
      session.identity = getConnectedIdentity(session.sock.user);
      logger.info({ sessionId }, 'whatsapp connected');
    }

    if (connection === 'close') {
      const isCurrentSession = sessions.get(sessionId) === session;
      const shouldReconnect =
        isCurrentSession &&
        !session.stopRequested &&
        !isShuttingDown &&
        statusCode !== DisconnectReason.loggedOut;
      session.status = 'closed';
      session.identity = null;
      logger.warn({ sessionId, statusCode, shouldReconnect }, 'whatsapp disconnected');

      if (shouldReconnect) {
        sessions.delete(sessionId);
        scheduleSessionReconnect(sessionId, config.SESSION_RECONNECT_DELAY_MS, logger);
      } else if (isCurrentSession && statusCode !== DisconnectReason.loggedOut) {
        sessions.delete(sessionId);
      }
    }

    await emitWebhookEvent(session, 'connection_update', {
      connection,
      status: session.status,
      qr: session.qr || null,
      lastDisconnect: statusCode ? { statusCode } : null,
      phoneNumber: session.identity?.phoneNumber || null,
      userJid: session.identity?.userJid || null,
      lid: session.identity?.lid || null,
      name: session.identity?.name || null
    }, logger);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      const meId = session.sock.user?.id;
      const meIdNormalized = meId ? jidNormalizedUser(meId) : 'me';

      if (msg.message) {
        cacheMessage(session, msg);
        recordPollCreation(session, msg, meIdNormalized, logger);
      }

      if (msg.message?.pollUpdateMessage) {
        continue;
      }

      if (type !== 'notify') {
        continue;
      }

      if (!msg.message || msg.key?.fromMe) continue;

      const messageId = msg.key?.id;
      const from = msg.key?.remoteJid;
      const sender = msg.key?.participant || msg.key?.remoteJid;
      const timestamp = msg.messageTimestamp;

      const buttonReply = extractButtonReply(msg.message);
      if (buttonReply) {
        await emitWebhookEvent(session, 'button_reply', {
          messageId,
          from,
          sender,
          timestamp,
          ...buttonReply,
          raw: msg
        }, logger);
        continue;
      }

      const listReply = extractListReply(msg.message);
      if (listReply) {
        await emitWebhookEvent(session, 'list_reply', {
          messageId,
          from,
          sender,
          timestamp,
          ...listReply,
          raw: msg
        }, logger);
        continue;
      }

      const pollCreation = getPollCreation(msg.message);
      if (pollCreation) {
        await emitWebhookEvent(session, 'poll', {
          messageId,
          from,
          sender,
          timestamp,
          pollName: pollCreation.name || '',
          options: (pollCreation.options || []).map((option) => option.optionName || ''),
          selectableCount: pollCreation.selectableOptionsCount || null,
          raw: msg
        }, logger);
        continue;
      }

      const payload = {
        messageId,
        from,
        sender,
        timestamp,
        messageType: getPrimaryMessageType(msg.message),
        text: getMessageText(msg.message),
        raw: msg
      };

      session.lastMessageAt = Date.now();
      logger.info({ sessionId, messageId: payload.messageId }, 'inbound message');

      await emitWebhookEvent(session, 'message', payload, logger);
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates || []) {
      if (!update?.key) continue;
      const pollUpdates = update.update?.pollUpdates;
      if (Array.isArray(pollUpdates) && pollUpdates.length > 0) {
        const pollKey = pollKeyFromMessageKey(update.key, update.key?.remoteJid);
        let pollData =
          session.polls.get(pollKey) || session.pollsById.get(update.key.id || '');
        const pollCreationMessage =
          getMessageFromStore(session.messageStore, update.key) ||
          pollData?.message ||
          null;
        if (!pollCreationMessage) {
          logger.warn({ sessionId, pollKey }, 'poll update without matching poll creation');
        } else {
          const pollCreation = getPollCreation(pollCreationMessage);
          if (!pollData) {
            pollData = {
              key: pollKey,
              message: pollCreationMessage,
              pollUpdates: [],
              pollEncKey: null,
              pollName: pollCreation?.name || '',
              options: (pollCreation?.options || []).map((option) => option.optionName || ''),
              selectableCount: pollCreation?.selectableOptionsCount || null,
              createdAt: Date.now(),
              creatorJids: []
            };
            session.polls.set(pollKey, pollData);
            if (update.key?.id) {
              session.pollsById.set(update.key.id, pollData);
            }
          } else if (pollCreation) {
            if (!pollData.pollName) {
              pollData.pollName = pollCreation.name || '';
            }
            if (!pollData.options?.length) {
              pollData.options = (pollCreation.options || []).map(
                (option) => option.optionName || ''
              );
            }
            if (!pollData.selectableCount) {
              pollData.selectableCount = pollCreation.selectableOptionsCount || null;
            }
          }

          const meId = session.sock.user?.id;
          const meIdNormalized = meId ? jidNormalizedUser(meId) : 'me';
          for (const pollUpdate of pollUpdates) {
            updateMessageWithPollUpdate(pollData, pollUpdate);
            const aggregate = getAggregateVotesInPollMessage(
              {
                message: pollCreationMessage,
                pollUpdates: pollData.pollUpdates
              },
              meId
            );
            const singleVoteAggregate = getAggregateVotesInPollMessage(
              {
                message: pollCreationMessage,
                pollUpdates: [pollUpdate]
              },
              meId
            );
            const voter = getKeyAuthor(pollUpdate.pollUpdateMessageKey, meIdNormalized);
            const selectedOptions = singleVoteAggregate
              .filter((option) => option.voters.includes(voter))
              .map((option) => option.name);
            await emitWebhookEvent(session, 'poll_vote', {
              pollVoteMessageId: pollUpdate.pollUpdateMessageKey?.id || null,
              pollMessageId: update.key.id,
              pollRemoteJid: update.key.remoteJid,
              pollName: pollData.pollName,
              options: pollData.options,
              selectableCount: pollData.selectableCount,
              voter,
              selectedOptions,
              aggregate,
              raw: pollUpdate
            }, logger);
          }
        }
      }
      await emitWebhookEvent(session, 'message_update', {
        messageId: update.key.id,
        from: update.key.remoteJid,
        sender: update.key.participant || update.key.remoteJid,
        update,
        raw: update
      }, logger);
    }
  });

  return session;
}

async function createLockedSession(sessionId, logger) {
  await acquireSessionProcessLock(sessionId, logger);
  try {
    return await createSession(sessionId, logger);
  } catch (error) {
    await releaseSessionProcessLock(sessionId, logger);
    throw error;
  }
}

async function reconnectSession(sessionId, logger) {
  if (isShuttingDown || sessionDeletionLocks.has(sessionId)) return;
  try {
    await getOrCreateSession(sessionId, logger);
  } catch (error) {
    if (error?.statusCode === 409) {
      scheduleSessionReconnect(sessionId, config.SESSION_LOCK_RETRY_DELAY_MS, logger);
      return;
    }
    logger.error({ err: error, sessionId }, 'reconnect failed');
  }
}

function scheduleSessionReconnect(sessionId, delayMs, logger) {
  cancelSessionReconnect(sessionId);
  const reconnectTimer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    reconnectSession(sessionId, logger);
  }, delayMs);
  reconnectTimer.unref?.();
  reconnectTimers.set(sessionId, reconnectTimer);
}

export async function getOrCreateSession(sessionId, logger) {
  const pendingDeletion = sessionDeletionLocks.get(sessionId);
  if (pendingDeletion) await pendingDeletion;
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const pending = sessionLocks.get(sessionId);
  if (pending) return pending;
  const promise = createLockedSession(sessionId, logger).finally(() => {
    sessionLocks.delete(sessionId);
  });
  sessionLocks.set(sessionId, promise);
  return promise;
}

export async function waitForSessionQr(session, timeoutMs) {
  const maxWait = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 15000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    if (session.qr) return session.qr;
    if (session.status === 'open') return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return session.qr || null;
}

export async function restoreSessions(logger) {
  try {
    const entries = await fs.readdir(config.SESSION_DIR, { withFileTypes: true });
    const sessionIds = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[a-zA-Z0-9_-]+$/.test(name));

    if (!sessionIds.length) {
      logger.info('no saved sessions found');
      return;
    }

    logger.info({ count: sessionIds.length }, 'restoring saved sessions');

    for (const sessionId of sessionIds) {
      try {
        await getOrCreateSession(sessionId, logger);
      } catch (error) {
        logger.error({ err: error, sessionId }, 'could not restore session');
      }
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not scan session directory');
  }
}

function closeSessionAfterLockLoss(sessionId, error, logger) {
  ownedSessionProcessLocks.delete(sessionId);
  const session = sessions.get(sessionId);
  if (!session || session.stopRequested || isShuttingDown) return;
  session.stopRequested = true;
  sessions.delete(sessionId);
  session.sock.end(error);
  logger.error({ err: error, sessionId }, 'session auth lock disappeared; connection closed');
}

async function refreshSessionProcessLock(sessionId, lockPath, now, logger) {
  try {
    await fs.utimes(lockPath, now, now);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      closeSessionAfterLockLoss(sessionId, error, logger);
      return;
    }
    logger.error({ err: error, sessionId, lockPath }, 'session process lock heartbeat failed');
  }
}

async function refreshSessionProcessLocks(logger) {
  const now = new Date();
  for (const [sessionId, lockPath] of ownedSessionProcessLocks) {
    await refreshSessionProcessLock(sessionId, lockPath, now, logger);
  }
}

export function startSessionLockHeartbeat(logger) {
  const heartbeat = setInterval(() => {
    refreshSessionProcessLocks(logger).catch((error) => {
      logger.error({ err: error }, 'could not refresh session process locks');
    });
  }, config.SESSION_PROCESS_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
}

export async function shutdownSessions(signal, logger) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  await Promise.allSettled(sessionLocks.values());
  for (const [sessionId, session] of sessions) {
    session.stopRequested = true;
    session.sock.end(new Error(`Server shutdown: ${signal}`));
    logger.info({ sessionId }, 'session connection closed for shutdown');
  }
  sessions.clear();
  await Promise.all(
    Array.from(ownedSessionProcessLocks.keys()).map((sessionId) =>
      releaseSessionProcessLock(sessionId, logger)
    )
  );
}

