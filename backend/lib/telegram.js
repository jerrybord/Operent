/**
 * Telegram WebApp validation & helpers
 */

const crypto = require('crypto');

/**
 * Validate Telegram WebApp initData
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    // Sort params alphabetically
    const checkString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256 with "WebAppData" as key
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

    if (computedHash !== hash) return null;

    // Parse user data
    const userStr = params.get('user');
    if (!userStr) return null;

    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

/**
 * Extract user from initData without validation (for dev/testing)
 */
function extractUser(initData) {
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (userStr) return JSON.parse(userStr);
    return null;
  } catch {
    return null;
  }
}

/**
 * Send a message via Telegram Bot API
 */
async function sendMessage(botToken, chatId, text, options = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options,
    }),
  });
  return response.json();
}

/**
 * Create Telegram Stars invoice
 */
async function createInvoice(botToken, chatId, { title, description, amount }) {
  const url = `https://api.telegram.org/bot${botToken}/sendInvoice`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      title,
      description,
      payload: `deploy_${Date.now()}`,
      currency: 'XTR',  // Telegram Stars
      prices: [{ label: title, amount }],  // amount in Stars (1 Star = ~$0.02)
    }),
  });
  return response.json();
}

/**
 * Edit text of a previously-sent message. Pass the chat_id and message_id
 * returned from sendMessage. Returns the parsed Telegram API response.
 */
async function editMessageText(botToken, chatId, messageId, text, options = {}) {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options,
    }),
  });
  return response.json();
}

/**
 * Generic Telegram Bot API call
 */
async function callBotApi(botToken, method, body = {}) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

/**
 * Prepare a KeyboardButton for managed bot creation (Bot API 9.6+).
 * Returns PreparedKeyboardButton { id } that can be triggered from a Mini App.
 */
async function savePreparedKeyboardButton(botToken, userId, suggestedName, suggestedUsername) {
  return callBotApi(botToken, 'savePreparedKeyboardButton', {
    user_id: userId,
    button: {
      text: 'Create Agent Bot',
      request_managed_bot: {
        request_id: Math.floor(Math.random() * 2147483647),
        suggested_name: suggestedName,
        suggested_username: suggestedUsername,
      },
    },
  });
}

/**
 * Get the API token of a managed bot (Bot API 9.6+).
 * @param {number} botUserId — the managed bot's user ID (not the human user)
 */
async function getManagedBotToken(botToken, botUserId) {
  return callBotApi(botToken, 'getManagedBotToken', {
    user_id: botUserId,
  });
}

module.exports = {
  validateInitData,
  extractUser,
  sendMessage,
  editMessageText,
  createInvoice,
  callBotApi,
  savePreparedKeyboardButton,
  getManagedBotToken,
};
