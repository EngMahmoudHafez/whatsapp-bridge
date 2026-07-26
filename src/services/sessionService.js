import fs from 'fs/promises';
import path from 'path';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
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

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function removeSessionFiles(sessionId, logger) {
  const sessionPath = path.join(config.SESSION_DIR, sessionId);
  try {
    await fs.rm(sessionPath, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error, sessionId }, 'could not remove session files');
  }
}

export async function cleanupSession(sessionId, deleteFiles = false, logger) {
  const existing = sessions.get(sessionId);
  if (existing) {
    try {
      await existing.sock.logout();
    } catch (error) {
      logger.warn({ err: error, sessionId }, 'logout failed during cleanup');
    }
    sessions.delete(sessionId);
  }

  if (deleteFiles) {
    await removeSessionFiles(sessionId, logger);
  }
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
  const baileysLogger = logger.child({ component: 'baileys' }, { level: 'warn' });

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    printQRInTerminal: false,
    browser: ['Windows', 'Chrome', '10.0'],
    auth: state,
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
    pollsById: new Map()
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
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      session.status = 'closed';
      session.identity = null;
      logger.warn({ sessionId, statusCode }, 'whatsapp disconnected');

      if (shouldReconnect) {
        sessions.delete(sessionId);
        setTimeout(() => {
          getOrCreateSession(sessionId, logger).catch((error) => {
            logger.error({ err: error, sessionId }, 'reconnect failed');
          });
        }, 1000);
      } else {
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

export async function getOrCreateSession(sessionId, logger) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const pending = sessionLocks.get(sessionId);
  if (pending) return pending;
  const promise = createSession(sessionId, logger).finally(() => {
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

