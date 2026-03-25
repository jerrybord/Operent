/**
 * RentYourClaw Agent — Telegram Bot Runtime
 *
 * Runs inside Docker. Reads /root/.openclaw/openclaw.json and env vars.
 * Proxies LLM calls through the central backend for usage/billing tracking.
 *
 * Natural language cron:
 *   User: "Присылай мне прогноз погоды каждый день в 8 утра"
 *   Agent detects scheduling intent → LLM includes <cron schedule="daily 08:00" task="..."/>
 *   agent.js parses the tag, creates the job, strips tag from response
 *
 * Manual commands (optional override):
 *   /cron list | /cron remove <id> | /cron add <schedule> <task>
 *   /start | /reset | /status
 */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// === Config ===

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AGENT_ID = process.env.AGENT_ID || 'unknown';
const AGENT_NAME = process.env.AGENT_NAME || 'Agent';

if (!BOT_TOKEN) {
  console.error('[agent] TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

let config = {};
const CONFIG_PATH = '/root/.openclaw/openclaw.json';
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  console.log(`[agent] Loaded config for: ${config.agent?.name || AGENT_NAME}`);
} catch (e) {
  console.warn('[agent] Could not load openclaw.json, using defaults:', e.message);
}

const agentConfig    = config.agent    || {};
const modelsConfig   = config.models   || {};
const channelsConfig = config.channels?.telegram || {};
const skillsEnabled  = config.skills?.enabled || [];

const baseSystemPrompt = agentConfig.systemPrompt ||
  `Your name is ${AGENT_NAME}. You are a helpful AI assistant.`;

let allowedUsers = channelsConfig.allowedUsers || [];
const LLM_BASE_URL = modelsConfig.baseUrl || '';
const defaultModel = modelsConfig.defaults || { provider: 'anthropic', model: 'claude-sonnet-4-6' };
const cronEnabled = agentConfig.cronEnabled !== false;

// Skill descriptions for runtime injection (for existing agents)
const SKILL_DESCRIPTIONS = {
  'web-browsing':       'Browse websites and search the internet',
  'browser-automation': 'Automate web browser interactions',
  'instagram':          'Manage Instagram (posts, DMs, engagement)',
  'twitter':            'Manage Twitter/X (tweets, replies, DMs)',
  'linkedin':           'Manage LinkedIn (posts, connections)',
  'voice-messages':     'Send and transcribe voice messages',
  'speech-to-text':     'Transcribe audio recordings to text',
  'google-docs':        'Create and edit Google Docs',
  'google-sheets':      'Create and edit Google Sheets',
  'google-calendar':    'Manage Google Calendar events',
  'scheduling':         'Schedule and manage tasks',
  'data-analysis':      'Analyze data and generate insights',
  'reporting':          'Create reports and summaries',
  'youtube-management': 'Manage YouTube channel content',
};

const runtimeCapabilities = skillsEnabled
  .map(s => SKILL_DESCRIPTIONS[s])
  .filter(Boolean);

// === Build system prompt ===

function buildSystemPrompt() {
  const parts = [baseSystemPrompt];

  if (runtimeCapabilities.length > 0 && !baseSystemPrompt.includes('capabilities')) {
    parts.push(
      `\nYour enabled capabilities:\n${runtimeCapabilities.map(d => `  • ${d}`).join('\n')}`
    );
  }

  if (cronEnabled) {
    // Natural language cron instructions — the key part
    parts.push(`
IMPORTANT — Scheduled tasks (cron):
When the user asks you to do something repeatedly, on a schedule, or at a specific time in the future (e.g. "remind me every day", "send weather every morning at 8", "check prices hourly", "напоминай мне каждый день", "присылай прогноз каждое утро в 8"), you MUST create a scheduled task automatically.

To create a scheduled task, include this XML tag ANYWHERE in your response (it will be processed invisibly):
  <cron schedule="SCHEDULE" task="TASK_DESCRIPTION"/>

SCHEDULE formats:
  daily HH:MM     — every day at specific time (e.g. daily 08:00)
  every Nm        — every N minutes (e.g. every 30m)
  every Nh        — every N hours (e.g. every 2h)
  hourly          — every hour

TASK_DESCRIPTION: a clear self-contained instruction of what to do when the task fires.

Example:
  User: "Присылай мне прогноз погоды для Москвы каждый день в 8 утра"
  You respond: "Готово! Буду присылать прогноз погоды для Москвы каждый день в 08:00 🕗 <cron schedule="daily 08:00" task="Fetch and send current weather forecast for Moscow, including temperature, conditions, and what to wear"/>"

Rules:
  - ALWAYS include the <cron> tag when scheduling is requested — do NOT just promise to do it
  - Write the tag anywhere in your message, it will be stripped before showing to user
  - The task description must be self-contained (no "as I mentioned" etc.)
  - Confirm to the user naturally in their language that the task is scheduled`);
  }

  return parts.join('\n');
}

const SYSTEM_PROMPT = buildSystemPrompt();

// === Memory ===

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
    fs.writeFileSync(file, JSON.stringify(msgs.slice(-50), null, 2));
  } catch (e) {
    console.warn('[agent] Could not save conversation:', e.message);
  }
}

// === LLM ===

async function callLLM(chatId, userMessage, isScheduled = false) {
  const history = loadConversation(chatId);
  if (!isScheduled) {
    history.push({ role: 'user', content: userMessage });
  }

  const provider = defaultModel.provider || 'anthropic';

  try {
    let response;

    if (provider === 'anthropic') {
      const messages = isScheduled
        ? [{ role: 'user', content: userMessage }]
        : history.map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(`${LLM_BASE_URL}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: defaultModel.model,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      response = data.content?.[0]?.text || 'No response from AI.';
    } else {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(isScheduled
          ? [{ role: 'user', content: userMessage }]
          : history.map(m => ({ role: m.role, content: m.content }))),
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

    if (!isScheduled) {
      history.push({ role: 'assistant', content: response });
      saveConversation(chatId);
    }
    return response;
  } catch (e) {
    console.error('[agent] LLM error:', e.message);
    if (!isScheduled) history.pop();
    return `⚠️ LLM Error: ${e.message}`;
  }
}

// === Cron tag parser ===

/**
 * Extract all <cron schedule="..." task="..."/> tags from LLM response.
 * Returns { clean: string, jobs: [{schedule, task}] }
 */
function extractCronTags(text) {
  const jobs = [];
  // Match <cron schedule="..." task="..."/> or <cron task="..." schedule="..."/>
  const re = /<cron\s+(?:schedule="([^"]+)"\s+task="([^"]+)"|task="([^"]+)"\s+schedule="([^"]+)")\s*\/>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const schedule = (match[1] || match[4] || '').trim();
    const task     = (match[2] || match[3] || '').trim();
    if (schedule && task) jobs.push({ schedule, task });
  }
  // Strip all cron tags from the visible text
  const clean = text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
  return { clean, jobs };
}

// === Cron Scheduler ===

const DATA_DIR = '/root/data';
const CRON_FILE = path.join(DATA_DIR, 'crons.json');
const activeTimers = new Map();

let bot; // forward ref

function loadCrons() {
  try { return JSON.parse(fs.readFileSync(CRON_FILE, 'utf-8')); } catch { return []; }
}

function saveCrons(crons) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CRON_FILE, JSON.stringify(crons, null, 2));
  } catch (e) { console.warn('[cron] Could not save:', e.message); }
}

function msUntilNext(schedule) {
  const now = new Date();
  if (schedule === 'hourly') {
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return Math.max(1000, next - now);
  }
  const everyMin = schedule.match(/^every\s+(\d+)m$/i);
  if (everyMin) return parseInt(everyMin[1]) * 60 * 1000;
  const everyHour = schedule.match(/^every\s+(\d+)h$/i);
  if (everyHour) return parseInt(everyHour[1]) * 60 * 60 * 1000;
  const daily = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (daily) {
    const next = new Date(now);
    next.setHours(parseInt(daily[1]), parseInt(daily[2]), 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return Math.max(1000, next - now);
  }
  return 60 * 60 * 1000;
}

function describeSchedule(schedule) {
  if (schedule === 'hourly') return 'every hour';
  const m = schedule.match(/^every\s+(\d+)m$/i);
  if (m) return `every ${m[1]} min`;
  const h = schedule.match(/^every\s+(\d+)h$/i);
  if (h) return `every ${h[1]}h`;
  const d = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (d) return `daily at ${d[1].padStart(2, '0')}:${d[2]}`;
  return schedule;
}

function scheduleCron(cron) {
  const delay = msUntilNext(cron.schedule);
  const runTask = async () => {
    console.log(`[cron] Firing "${cron.task}" for chat ${cron.chatId}`);
    try {
      if (bot) bot.sendChatAction(cron.chatId, 'typing').catch(() => {});
      const reply = await callLLM(cron.chatId, `[SCHEDULED TASK] ${cron.task}`, true);
      if (bot) sendLong(cron.chatId, `⏰ ${reply}`);
    } catch (e) { console.error('[cron] task error:', e.message); }
    const handle = setTimeout(runTask, msUntilNext(cron.schedule));
    activeTimers.set(cron.id, handle);
  };
  const handle = setTimeout(runTask, delay);
  activeTimers.set(cron.id, handle);
  console.log(`[cron] Scheduled "${cron.task}" (${describeSchedule(cron.schedule)}) — first run in ~${Math.round(delay / 60000)}m`);
}

function stopCron(cronId) {
  const h = activeTimers.get(cronId);
  if (h) { clearTimeout(h); activeTimers.delete(cronId); }
}

/**
 * Create a cron job from natural language detection or /cron add command.
 * Returns the cron object.
 */
function createCronJob(chatId, schedule, task) {
  const cronId = Math.random().toString(36).slice(2, 8);
  const cron = { id: cronId, chatId, schedule: schedule.toLowerCase().trim(), task };
  const all = loadCrons();
  all.push(cron);
  saveCrons(all);
  scheduleCron(cron);
  return cron;
}

// Parse /cron add args → {schedule, task} or null
function parseCronAdd(args) {
  const daily = args.match(/^(daily\s+\d{1,2}:\d{2})\s+(.+)$/i);
  if (daily) return { schedule: daily[1].toLowerCase().trim(), task: daily[2].trim() };
  const every = args.match(/^(every\s+\d+[mh])\s+(.+)$/i);
  if (every) return { schedule: every[1].toLowerCase().trim(), task: every[2].trim() };
  const hourly = args.match(/^(hourly)\s+(.+)$/i);
  if (hourly) return { schedule: 'hourly', task: hourly[2].trim() };
  return null;
}

// === Helpers ===

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sendLong(chatId, text, opts = {}) {
  if (!bot) return;
  if (text.length <= 4000) { bot.sendMessage(chatId, text, opts).catch(() => {}); return; }
  const chunks = text.match(/.{1,4000}/gs) || [text];
  for (const chunk of chunks) bot.sendMessage(chatId, chunk, opts).catch(() => {});
}

// === Bot ===

bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Restore saved cron jobs
const savedCrons = loadCrons();
for (const cron of savedCrons) scheduleCron(cron);
console.log(`[cron] Restored ${savedCrons.length} scheduled task(s)`);

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || '').trim();

  if (!text) return;

  // Access control
  if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
    const hasRealUsers = allowedUsers.some(id => id > 100000);
    if (hasRealUsers) { bot.sendMessage(chatId, '⛔ Access denied.').catch(() => {}); return; }
    allowedUsers.push(userId);
    console.log(`[agent] Auto-added owner: ${userId}`);
  }

  // /start
  if (text === '/start') {
    const caps = runtimeCapabilities.length > 0
      ? `\n\n<b>My capabilities:</b>\n${runtimeCapabilities.map(d => `• ${d}`).join('\n')}`
      : '';
    const cronHint = cronEnabled
      ? `\n\nJust tell me naturally if you want me to do something on a schedule — e.g. "Send me weather every morning at 8".`
      : '';
    bot.sendMessage(chatId,
      `🦞 Hi! I am <b>${escHtml(AGENT_NAME)}</b>, your AI agent.${caps}${cronHint}\n\nPowered by @RentClawBot`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }

  // /reset
  if (text === '/reset') {
    conversations.delete(chatId);
    try { fs.unlinkSync(path.join(MEMORY_DIR, `chat_${chatId}.json`)); } catch {}
    bot.sendMessage(chatId, '🔄 Conversation reset.').catch(() => {});
    return;
  }

  // /status
  if (text === '/status') {
    const history = loadConversation(chatId);
    const crons = loadCrons().filter(c => c.chatId === chatId);
    bot.sendMessage(chatId,
      `📊 <b>Agent Status</b>\n\nName: ${escHtml(AGENT_NAME)}\nModel: ${defaultModel.model}\nMessages in context: ${history.length}\nScheduled tasks: ${crons.length}\nAgent ID: <code>${AGENT_ID}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }

  // /cron commands (manual override, still supported)
  if (text.startsWith('/cron')) {
    const rest = text.slice(5).trim();

    if (!rest || rest === 'list') {
      const crons = loadCrons().filter(c => c.chatId === chatId);
      if (crons.length === 0) {
        bot.sendMessage(chatId,
          'No scheduled tasks yet.\n\nJust tell me what to schedule, e.g. "Send me weather every morning at 8".',
          ).catch(() => {});
      } else {
        const lines = crons.map((c, i) =>
          `${i + 1}. <b>${escHtml(c.task)}</b>\n   ⏱ ${describeSchedule(c.schedule)} · id: <code>${c.id}</code>`
        ).join('\n\n');
        bot.sendMessage(chatId, `📋 <b>Scheduled tasks:</b>\n\n${lines}`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return;
    }

    const removeMatch = rest.match(/^remove\s+(\S+)$/i);
    if (removeMatch) {
      const cronId = removeMatch[1];
      const all = loadCrons();
      const idx = all.findIndex(c => c.id === cronId && c.chatId === chatId);
      if (idx === -1) {
        bot.sendMessage(chatId, `❌ Task not found: <code>${escHtml(cronId)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
      } else {
        stopCron(cronId);
        all.splice(idx, 1);
        saveCrons(all);
        bot.sendMessage(chatId, '✅ Scheduled task removed.').catch(() => {});
      }
      return;
    }

    const addMatch = rest.match(/^add\s+(.+)$/i);
    if (addMatch) {
      const parsed = parseCronAdd(addMatch[1]);
      if (!parsed) {
        bot.sendMessage(chatId,
          'Invalid format. Examples:\n' +
          '<code>/cron add daily 08:00 Send weather for Moscow</code>\n' +
          '<code>/cron add every 30m Check new emails</code>\n\n' +
          'Or just tell me in plain language: "Send me weather every morning at 8"',
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }
      const cron = createCronJob(chatId, parsed.schedule, parsed.task);
      const delay = msUntilNext(parsed.schedule);
      const timeStr = delay < 3600000 ? `${Math.round(delay / 60000)} min` : `${Math.round(delay / 3600000)}h`;
      bot.sendMessage(chatId,
        `✅ <b>Scheduled!</b>\n\nTask: ${escHtml(parsed.task)}\nSchedule: ${describeSchedule(parsed.schedule)}\nFirst run: in ~${timeStr}\nID: <code>${cron.id}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    bot.sendMessage(chatId,
      'Commands: <code>/cron list</code> · <code>/cron add &lt;schedule&gt; &lt;task&gt;</code> · <code>/cron remove &lt;id&gt;</code>',
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }

  // === Regular message → LLM ===
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const rawReply = await callLLM(chatId, text);

  // Extract any cron tags the LLM included
  const { clean: reply, jobs } = extractCronTags(rawReply);

  // Process cron jobs from LLM response
  for (const job of jobs) {
    if (!cronEnabled) continue;
    try {
      const cron = createCronJob(chatId, job.schedule, job.task);
      console.log(`[cron] Auto-created from LLM: "${cron.task}" (${describeSchedule(cron.schedule)}) id=${cron.id}`);
    } catch (e) {
      console.error('[cron] Failed to create from LLM tag:', e.message);
    }
  }

  sendLong(chatId, reply || '...');
});

bot.on('polling_error', (error) => {
  console.error('[agent] Polling error:', error.code, error.message);
});

console.log(`🦞 Agent "${AGENT_NAME}" (${AGENT_ID}) is running`);
if (skillsEnabled.length > 0) console.log(`[agent] Skills: ${skillsEnabled.join(', ')}`);
if (cronEnabled) console.log('[agent] Natural language cron scheduling: enabled');
