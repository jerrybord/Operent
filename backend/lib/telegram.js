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

module.exports = { validateInitData, extractUser, sendMessage, createInvoice };
