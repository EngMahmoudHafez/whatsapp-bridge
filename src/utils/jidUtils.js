import { jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';

export function extractPhoneFromJid(jid) {
  const decoded = jidDecode(jid || '');
  return decoded?.user || null;
}

export function getConnectedIdentity(sockUser) {
  if (!sockUser) return null;
  const userJid = sockUser.id || null;
  return {
    userJid,
    phoneNumber: userJid ? extractPhoneFromJid(userJid) : null,
    lid: sockUser.lid || null,
    name: sockUser.name || null
  };
}

