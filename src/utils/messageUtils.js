import { normalizeMessageContent } from '@whiskeysockets/baileys';

export function getMessageText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

export function getPrimaryMessageType(message) {
  if (!message) return 'unknown';
  const keys = Object.keys(message).filter((key) => key !== 'messageContextInfo');
  return keys[0] || 'unknown';
}

export function getPollCreation(message, depth = 0) {
  if (!message) return null;
  if (depth > 3) return null;

  const normalized = normalizeMessageContent(message) || message;
  const direct =
    normalized.pollCreationMessage ||
    normalized.pollCreationMessageV2 ||
    normalized.pollCreationMessageV3;
  if (direct) return direct;

  const v4 = normalized.pollCreationMessageV4?.message;
  if (v4) {
    const nested = getPollCreation(v4, depth + 1);
    if (nested) return nested;
  }

  const v5 = normalized.pollCreationMessageV5?.message;
  if (v5) {
    const nested = getPollCreation(v5, depth + 1);
    if (nested) return nested;
  }

  return null;
}

export function getMessageSecret(msg) {
  return (
    msg?.message?.messageContextInfo?.messageSecret ||
    msg?.messageContextInfo?.messageSecret ||
    msg?.message?.pollCreationMessage?.contextInfo?.messageSecret ||
    msg?.message?.pollCreationMessageV2?.contextInfo?.messageSecret ||
    msg?.message?.pollCreationMessageV3?.contextInfo?.messageSecret ||
    msg?.message?.pollCreationMessageV4?.message?.messageContextInfo?.messageSecret ||
    msg?.message?.pollCreationMessageV5?.message?.messageContextInfo?.messageSecret ||
    msg?.message?.pollCreationMessage?.encKey ||
    msg?.message?.pollCreationMessageV2?.encKey ||
    msg?.message?.pollCreationMessageV3?.encKey ||
    msg?.message?.pollCreationMessageV4?.message?.pollCreationMessage?.encKey ||
    msg?.message?.pollCreationMessageV5?.message?.pollCreationMessage?.encKey ||
    null
  );
}

export function extractButtonReply(message) {
  const buttons = message?.buttonsResponseMessage;
  if (buttons) {
    return {
      responseType: 'buttons_response',
      id: buttons.selectedButtonId || null,
      text: buttons.selectedDisplayText || null
    };
  }

  const template = message?.templateButtonReplyMessage;
  if (template) {
    return {
      responseType: 'template_button_reply',
      id: template.selectedId || null,
      text: template.selectedDisplayText || null,
      index: template.selectedIndex ?? null
    };
  }

  const interactive = message?.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (interactive) {
    return {
      responseType: 'interactive_response',
      name: interactive.name || null,
      paramsJson: interactive.paramsJson || null,
      version: interactive.version ?? null
    };
  }

  return null;
}

export function extractListReply(message) {
  const list = message?.listResponseMessage;
  if (!list) return null;
  return {
    responseType: 'list_response',
    title: list.title || null,
    description: list.description || null,
    selectedRowId: list.singleSelectReply?.selectedRowId || null
  };
}

export function stringifyButtonParams(buttons) {
  if (!Array.isArray(buttons)) return buttons;
  return buttons.map((button) => {
    if (
      button &&
      typeof button === 'object' &&
      button.buttonParamsJson &&
      typeof button.buttonParamsJson !== 'string'
    ) {
      return {
        ...button,
        buttonParamsJson: JSON.stringify(button.buttonParamsJson)
      };
    }
    return button;
  });
}

export function normalizeInteractiveContent(content) {
  if (!content || typeof content !== 'object') return content;
  const normalized = { ...content };

  if (Array.isArray(normalized.interactiveButtons)) {
    normalized.interactiveButtons = stringifyButtonParams(normalized.interactiveButtons);
  }

  const nativeButtons = normalized.interactiveMessage?.nativeFlowMessage?.buttons;
  if (Array.isArray(nativeButtons)) {
    normalized.interactiveMessage = {
      ...normalized.interactiveMessage,
      nativeFlowMessage: {
        ...normalized.interactiveMessage.nativeFlowMessage,
        buttons: stringifyButtonParams(nativeButtons)
      }
    };
  }

  return normalized;
}

