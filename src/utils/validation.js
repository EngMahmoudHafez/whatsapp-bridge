export function sanitizeSessionId(raw) {
  if (!raw || !/^[a-zA-Z0-9_-]+$/.test(raw)) {
    const error = new Error("Invalid session id. Use letters, numbers, '-' or '_'.");
    error.statusCode = 400;
    throw error;
  }
  return raw;
}

export function parseWebhookUrl(raw) {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !raw.trim()) {
    const error = new Error('webhookUrl must be a non-empty string.');
    error.statusCode = 400;
    throw error;
  }
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    const err = new Error('webhookUrl must be a valid URL.');
    err.statusCode = 400;
    throw err;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const error = new Error('webhookUrl must start with http:// or https://');
    error.statusCode = 400;
    throw error;
  }
  return url.toString();
}

export function buildWebhookConfig({ webhookUrl, webhookSecret }, existing) {
  let url = existing?.url || '';
  let secret = existing?.secret || '';

  if (webhookUrl !== undefined) {
    const parsed = parseWebhookUrl(webhookUrl);
    if (!parsed) {
      return null;
    }
    url = parsed;
  }

  if (webhookSecret !== undefined) {
    secret = webhookSecret ? String(webhookSecret) : '';
  }

  if (!url) return null;
  return { url, secret };
}

export function normalizeJid(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const trimmed = input.trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

