'use strict';
/**
 * Operent Telegram Bot — long-polling
 * Handles /start: language picker (first visit) or direct welcome (returning users)
 * Uses native https module (no extra deps) + better-sqlite3 (already in package)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── DB (reuse existing connection / migrations) ──────────────────────────────
const { db } = require('./lib/db');

// Ensure bot_cache table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_cache (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Prepared statements for language & cache
const stmtGetLang    = db.prepare('SELECT language FROM users WHERE telegram_id = ?');
const stmtSetLang    = db.prepare('UPDATE users SET language = ? WHERE telegram_id = ?');
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (telegram_id, telegram_username, balance_cents)
  VALUES (?, ?, 500)
  ON CONFLICT(telegram_id) DO UPDATE SET telegram_username = excluded.telegram_username
`);
const stmtGetCache   = db.prepare('SELECT value FROM bot_cache WHERE key = ?');
const stmtSetCache   = db.prepare('INSERT OR REPLACE INTO bot_cache (key, value) VALUES (?, ?)');

// ── Config ───────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TG_BOT_TOKEN || '8713361004:AAG-X5ogHHbZtqCw7HdCHWa7iA-sBbJk98k';
const BASE_URL = `https://api.telegram.org/bot${TOKEN}`;
const APP_URL  = 'https://t.me/OperentBot/operent';
const NEWS_URL = 'https://t.me/OperentAI';
const PHOTO_PATH = path.join(__dirname, '..', 'public', 'Operent.jpg');

// Custom emoji IDs
const LOBSTER_EMOJI_ID = '5397772549511717747';
const ARROW_EMOJI_ID   = '5470177992950946662';
const NEWS_EMOJI_ID    = '5355075407743826720';

// ── i18n strings ─────────────────────────────────────────────────────────────
const STRINGS = {
  en: {
    picker_text: 'Choose your language:',
    btn_en: '🇺🇸 English',
    btn_ru: '🇷🇺 Russian',
    welcome: (name) =>
      `<tg-emoji emoji-id="${LOBSTER_EMOJI_ID}">🦞</tg-emoji> <b>Welcome to Operent — your gateway to OpenClaw agents.</b>\n\n` +
      `<blockquote><b>No</b> mac, <b>no</b> VPS, <b>no</b> degen coding, just type what you need, select wanted skills, and <b>ENJOY</b>.</blockquote>\n\n` +
      `Don't be slow, <b>be productive</b> <tg-emoji emoji-id="${ARROW_EMOJI_ID}">👇</tg-emoji>`,
    btn_app:  '🦞 Open App',
    btn_news: '🔜 News',
  },
  ru: {
    picker_text: 'Выберите язык:',
    btn_en: '🇺🇸 English',
    btn_ru: '🇷🇺 Русский',
    welcome: (name) =>
      `<tg-emoji emoji-id="${LOBSTER_EMOJI_ID}">🦞</tg-emoji> <b>Добро пожаловать в Operent — ваш портал к агентам OpenClaw.</b>\n\n` +
      `<blockquote><b>Никаких</b> серверов, <b>никакого</b> кодинга — просто опишите задачу, выберите нужные навыки и <b>ПОЛУЧАЙТЕ УДОВОЛЬСТВИЕ</b>.</blockquote>\n\n` +
      `Не тормози, <b>будь продуктивным</b> <tg-emoji emoji-id="${ARROW_EMOJI_ID}">👇</tg-emoji>`,
    btn_app:  '🦞 Открыть приложение',
    btn_news: '🔜 Новости',
  },
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function apiRequest(method, body, isMultipart) {
  return new Promise((resolve, reject) => {
    const bodyStr = isMultipart ? body.data : JSON.stringify(body);
    const contentType = isMultipart ? `multipart/form-data; boundary=${body.boundary}` : 'application/json';
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, error: data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function tgCall(method, body) {
  return apiRequest(method, body, false);
}

// ── Multipart builder for sendPhoto ──────────────────────────────────────────
function buildMultipart(fields, fileField, filePath) {
  const boundary = '----OperentBotBoundary' + Date.now();
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}`
    );
  }

  if (filePath && fs.existsSync(filePath)) {
    const fileData = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`;
    const footer = `\r\n--${boundary}--`;
    const combined = Buffer.concat([
      Buffer.from(parts.join('\r\n') + '\r\n', 'utf8'),
      Buffer.from(header, 'utf8'),
      fileData,
      Buffer.from(footer, 'utf8'),
    ]);
    return { boundary, data: combined };
  }

  const body = parts.join('\r\n') + `\r\n--${boundary}--`;
  return { boundary, data: Buffer.from(body, 'utf8') };
}

async function sendPhotoMultipart(fields, filePath) {
  const mp = buildMultipart(fields, 'photo', filePath);
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TOKEN}/sendPhoto`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${mp.boundary}`,
      'Content-Length': mp.data.length,
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, error: data }); }
      });
    });
    req.on('error', reject);
    req.write(mp.data);
    req.end();
  });
}

// ── Bot logic ─────────────────────────────────────────────────────────────────
function getWelcomeKeyboard(lang) {
  const s = STRINGS[lang] || STRINGS.en;
  return {
    inline_keyboard: [
      [
        {
          text: s.btn_app,
          url: APP_URL,
          style: 'danger',
          icon_custom_emoji_id: LOBSTER_EMOJI_ID,
        },
      ],
      [
        {
          text: s.btn_news,
          url: NEWS_URL,
          icon_custom_emoji_id: NEWS_EMOJI_ID,
        },
      ],
    ],
  };
}

async function sendWelcome(chatId, lang, username) {
  const s = STRINGS[lang] || STRINGS.en;
  const caption = s.welcome(username);
  const replyMarkup = JSON.stringify(getWelcomeKeyboard(lang));

  // Check for cached file_id
  const cached = stmtGetCache.get('photo_file_id');
  if (cached) {
    const res = await tgCall('sendPhoto', {
      chat_id: chatId,
      photo: cached.value,
      caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
    if (res.ok) return;
    // If file_id became invalid, fall through to re-upload
    stmtSetCache.run('photo_file_id', ''); // clear bad cache
  }

  // Try to upload photo file
  if (fs.existsSync(PHOTO_PATH)) {
    const fields = {
      chat_id: String(chatId),
      caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    };
    const res = await sendPhotoMultipart(fields, PHOTO_PATH);
    if (res.ok && res.result && res.result.photo) {
      // Cache largest photo's file_id
      const photos = res.result.photo;
      const fileId = photos[photos.length - 1].file_id;
      stmtSetCache.run('photo_file_id', fileId);
      return;
    }
    console.error('[bot] sendPhoto failed:', JSON.stringify(res));
  }

  // Fallback: text-only message
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: caption,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || '';

  // Ensure user row exists
  stmtUpsertUser.run(userId, username);

  // Check saved language
  const row = stmtGetLang.get(userId);
  const savedLang = row && row.language;

  if (savedLang === 'en' || savedLang === 'ru') {
    // Returning user — send welcome directly
    await sendWelcome(chatId, savedLang, username);
  } else {
    // New user — send language picker
    await tgCall('sendMessage', {
      chat_id: chatId,
      text: 'Choose your language / Выберите язык:',
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            { text: '🇺🇸 English', callback_data: 'lang:en' },
            { text: '🇷🇺 Русский', callback_data: 'lang:ru' },
          ],
        ],
      }),
    });
  }
}

async function handleCallback(cbq) {
  const data   = cbq.data || '';
  const chatId = cbq.message && cbq.message.chat.id;
  const msgId  = cbq.message && cbq.message.message_id;
  const userId = cbq.from.id;
  const username = cbq.from.username || cbq.from.first_name || '';

  if (data === 'lang:en' || data === 'lang:ru') {
    const lang = data.split(':')[1];

    // Ensure user exists & save language
    stmtUpsertUser.run(userId, username);
    stmtSetLang.run(lang, userId);

    // Answer callback (removes loading spinner)
    await tgCall('answerCallbackQuery', { callback_query_id: cbq.id });

    // Delete language picker message
    if (chatId && msgId) {
      await tgCall('deleteMessage', { chat_id: chatId, message_id: msgId });
    }

    // Send welcome
    await sendWelcome(chatId, lang, username);
  } else {
    await tgCall('answerCallbackQuery', { callback_query_id: cbq.id });
  }
}

// ── Long-polling ──────────────────────────────────────────────────────────────
let offset = 0;
let running = true;

async function poll() {
  while (running) {
    try {
      const res = await tgCall('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          try {
            if (update.message && update.message.text === '/start') {
              await handleStart(update.message);
            } else if (update.callback_query) {
              await handleCallback(update.callback_query);
            }
          } catch (e) {
            console.error('[bot] update error:', e.message);
          }
        }
      }
    } catch (e) {
      console.error('[bot] poll error:', e.message);
      // Brief pause on network error to avoid tight loop
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
// Drop any pending webhook so long-polling works
tgCall('deleteWebhook', { drop_pending_updates: false })
  .then(() => {
    console.log('[bot] Webhook removed, starting long-poll...');
    poll();
  })
  .catch((e) => {
    console.error('[bot] deleteWebhook error:', e.message);
    poll(); // start anyway
  });

process.on('SIGTERM', () => { running = false; });
process.on('SIGINT',  () => { running = false; });
