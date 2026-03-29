/**
 * RentYourClaw Agent — Telegram Bot Runtime
 *
 * Runs inside a Docker container. Reads config from /root/.openclaw/openclaw.json
 * and env vars for bot token, agent ID, and agent name.
 *
 * Proxies LLM requests through the central backend for usage tracking.
 */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// === Config ===

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AGENT_ID = process.env.AGENT_ID || 'unknown';
const AGENT_NAME = process.env.AGENT_NAME || 'Agent';

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// Load openclaw config
let config = {};
const CONFIG_PATH = '/root/.openclaw/openclaw.json';
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  console.log(`Loaded config for agent: ${config.agent?.name || AGENT_NAME}`);
} catch (e) {
  console.warn('Could not load openclaw.json, using defaults:', e.message);
}

const agentConfig = config.agent || {};
const modelsConfig = config.models || {};
const channelsConfig = config.channels?.telegram || {};
const systemPrompt = agentConfig.systemPrompt || `Your name is ${AGENT_NAME}. You are a helpful AI assistant.`;

// Allowlist
let allowedUsers = channelsConfig.allowedUsers || [];

// LLM proxy base URL from config
const LLM_BASE_URL = modelsConfig.baseUrl || '';
const defaultModel = modelsConfig.defaults || { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };

// Conversation memory (in-memory per session, persisted to disk)
const MEMORY_DIR = '/root/memory';
const conversations = new Map();

function loadConversation(chatId) {
  if (conversations.has(chatId)) return conversations.get(chatId);
  const file = path.join(MEMORY_DIR, `chat_${chatId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    conversations.set(chatId, data);
    return data;
  } catch {
    const empty = [];
    conversations.set(chatId, empty);
    return empty;
  }
}

function saveConversation(chatId) {
  const msgs = conversations.get(chatId) || [];
  const file = path.join(MEMORY_DIR, `chat_${chatId}.json`);
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    // Keep last 50 messages to avoid unbounded growth
    const trimmed = msgs.slice(-50);
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.warn('Could not save conversation:', e.message);
  }
}

// === LLM ===

async function callLLM(chatId, userMessage) {
  const history = loadConversation(chatId);
  history.push({ role: 'user', content: userMessage });

  const provider = defaultModel.provider || 'anthropic';

  try {
    let response;

    if (provider === 'anthropic') {
      // Anthropic Messages API format
      const res = await fetch(`${LLM_BASE_URL}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: defaultModel.model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: history.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      response = data.content?.[0]?.text || 'No response from AI.';
    } else {
      // OpenAI-compatible format (Kimi, OpenAI, Codex)
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ];

      const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: defaultModel.model,
          messages,
          max_tokens: 2048,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      response = data.choices?.[0]?.message?.content || 'No response from AI.';
    }

    history.push({ role: 'assistant', content: response });
    saveConversation(chatId);
    return response;
  } catch (e) {
    console.error('LLM error:', e.message);
    // Remove the failed user message from history
    history.pop();
    return `⚠️ LLM Error: ${e.message}`;
  }
}

// === Telegram Bot ===

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text;

  if (!text) return;

  // Access control
  if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
    // Auto-add first real user as owner if allowlist only has placeholder IDs
    const hasRealUsers = allowedUsers.some(id => id > 100000);
    if (hasRealUsers) {
      bot.sendMessage(chatId, '⛔ Access denied. This agent is private.');
      return;
    }
    allowedUsers.push(userId);
    console.log(`Auto-added user ${userId} as owner`);
  }

  // /start command
  if (text === '/start') {
    bot.sendMessage(chatId,
      `🦞 Hi! I am ${AGENT_NAME}, your personal AI agent.\n\nPowered by @RentClawBot`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // /reset command — clear conversation
  if (text === '/reset') {
    conversations.delete(chatId);
    const file = path.join(MEMORY_DIR, `chat_${chatId}.json`);
    try { fs.unlinkSync(file); } catch {}
    bot.sendMessage(chatId, '🔄 Conversation reset.');
    return;
  }

  // /status command
  if (text === '/status') {
    const history = loadConversation(chatId);
    bot.sendMessage(chatId,
      `📊 <b>Agent Status</b>\n\n` +
      `Name: ${AGENT_NAME}\n` +
      `Model: ${defaultModel.model}\n` +
      `Messages in context: ${history.length}\n` +
      `Agent ID: <code>${AGENT_ID}</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Regular message — send to LLM
  bot.sendChatAction(chatId, 'typing');
  const reply = await callLLM(chatId, text);

  // Split long messages (Telegram limit is 4096 chars)
  if (reply.length > 4000) {
    const chunks = reply.match(/.{1,4000}/gs) || [reply];
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk);
    }
  } else {
    bot.sendMessage(chatId, reply);
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

console.log(`🦞 Agent "${AGENT_NAME}" (${AGENT_ID}) is running`);
