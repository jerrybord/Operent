/**
 * Operent Agent — Telegram Bot Runtime
 *
 * Runs inside Docker. Reads /root/.openclaw/openclaw.json and env vars.
 * Proxies LLM calls through the central backend for usage/billing tracking.
 *
 * Skills:
 *   Reads skill instructions from config.skills.instructions and injects into system prompt.
 *   Special runtime skills: voice-messages (handles voice/audio Telegram messages)
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
const skillInstructions = config.skills?.instructions || {};

const baseSystemPrompt = agentConfig.systemPrompt ||
  `Your name is ${AGENT_NAME}. You are a helpful AI assistant.`;

let allowedUsers = channelsConfig.allowedUsers || [];
const LLM_BASE_URL = modelsConfig.baseUrl || '';
const defaultModel = modelsConfig.defaults || { provider: 'anthropic', model: 'claude-sonnet-4-6' };
const cronEnabled = agentConfig.cronEnabled !== false;

// Check if specific skills are enabled
const hasVoiceSkill = skillsEnabled.includes('voice-messages');

// === Build system prompt ===

function buildSystemPrompt() {
  const parts = [baseSystemPrompt];

  // Inject detailed skill instructions
  const instrParts = [];
  for (const skillId of skillsEnabled) {
    const instr = skillInstructions[skillId];
    if (instr) instrParts.push(instr);
  }
  if (instrParts.length > 0) {
    parts.push('\n--- SKILL INSTRUCTIONS ---\n' + instrParts.join('\n\n---\n\n'));
  }

  // Media protocol
  parts.push(`
MEDIA — You can attach images/files using invisible XML tags in your response:
  <image prompt="detailed English description"/> — AI-generates an image and sends it
  <photo url="URL"/> — sends a photo from URL
  <file url="URL" name="file.ext"/> — sends a document from URL
Write a short message alongside the tag. For <image>, always use a detailed English prompt regardless of user language.`);

  if (cronEnabled) {
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

// === Voice transcription ===

async function transcribeAudio(audioBuffer, format, duration) {
  if (!LLM_BASE_URL) throw new Error('No LLM proxy configured');

  const res = await fetch(`${LLM_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio: audioBuffer.toString('base64'),
      format: format || 'ogg',
      duration: duration || 10,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.text || '';
}

// === Cron tag parser ===

function extractCronTags(text) {
  const jobs = [];
  const re = /<cron\s+(?:schedule="([^"]+)"\s+task="([^"]+)"|task="([^"]+)"\s+schedule="([^"]+)")\s*\/>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const schedule = (match[1] || match[4] || '').trim();
    const task     = (match[2] || match[3] || '').trim();
    if (schedule && task) jobs.push({ schedule, task });
  }
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

function createCronJob(chatId, schedule, task) {
  const cronId = Math.random().toString(36).slice(2, 8);
  const cron = { id: cronId, chatId, schedule: schedule.toLowerCase().trim(), task };
  const all = loadCrons();
  all.push(cron);
  saveCrons(all);
  scheduleCron(cron);
  return cron;
}

function parseCronAdd(args) {
  const daily = args.match(/^(daily\s+\d{1,2}:\d{2})\s+(.+)$/i);
  if (daily) return { schedule: daily[1].toLowerCase().trim(), task: daily[2].trim() };
  const every = args.match(/^(every\s+\d+[mh])\s+(.+)$/i);
  if (every) return { schedule: every[1].toLowerCase().trim(), task: every[2].trim() };
  const hourly = args.match(/^(hourly)\s+(.+)$/i);
  if (hourly) return { schedule: 'hourly', task: hourly[2].trim() };
  return null;
}

// === Media tag parser ===

function extractMediaTags(text) {
  const images = [];
  const photos = [];
  const files = [];

  // Helper: extract all key="value" pairs from a tag body
  function parseAttrs(tagBody) {
    const attrs = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(tagBody)) !== null) attrs[m[1]] = m[2];
    return attrs;
  }

  // <image prompt="..." /> — generate image via Pollinations
  text = text.replace(/<image\s+([^>]*?)\/>/gi, (_, body) => {
    const a = parseAttrs(body);
    if (a.prompt) images.push({ prompt: a.prompt, width: parseInt(a.width) || 1024, height: parseInt(a.height) || 1024 });
    return '';
  });

  // <photo url="..." /> — send photo from URL
  text = text.replace(/<photo\s+([^>]*?)\/>/gi, (_, body) => {
    const a = parseAttrs(body);
    if (a.url) photos.push({ url: a.url, caption: a.caption || '' });
    return '';
  });

  // <file url="..." name="..." /> — send file from URL
  text = text.replace(/<file\s+([^>]*?)\/>/gi, (_, body) => {
    const a = parseAttrs(body);
    if (a.url) files.push({ url: a.url, name: a.name || 'file', caption: a.caption || '' });
    return '';
  });

  const clean = text.replace(/\n{3,}/g, '\n\n').trim();
  return { clean, images, photos, files };
}

// === Helpers ===

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert markdown → Telegram HTML.
 * Supports: <b>, <i>, <code>, <pre>, <blockquote>, <tg-spoiler>, <a href>.
 * Handles both: LLM writing markdown AND LLM writing raw HTML tags.
 */
function cleanForTelegram(text) {
  let t = text;

  // 0. Remove <tool_call> XML blocks
  t = t.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  t = t.replace(/<\/?tool_call>/gi, '');

  // 1. Protect Telegram-supported HTML tags from escaping
  const PH = '\x00';
  const saved = [];
  const SAFE_TAGS = /(<\/?\s*(?:b|i|u|s|code|pre|blockquote|tg-spoiler|a)(?:\s[^>]*)?\s*>)/gi;
  t = t.replace(SAFE_TAGS, (match) => {
    saved.push(match);
    return PH + (saved.length - 1) + PH;
  });

  // 2. Escape HTML entities
  t = t.replace(/&/g, '&amp;');
  t = t.replace(/</g, '&lt;');
  t = t.replace(/>/g, '&gt;');

  // 3. Restore protected tags
  t = t.replace(new RegExp(PH + '(\\d+)' + PH, 'g'), (_, i) => saved[parseInt(i)] || '');

  // 4. Markdown → Telegram HTML conversion

  // Code blocks: ```lang\ncode\n``` → <pre><code class="language-X">code</code></pre>
  t = t.replace(/```(\w+)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
  t = t.replace(/```\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

  // Inline code: `text` → <code>text</code>
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold: **text** or __text__ → <b>text</b>
  t = t.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
  t = t.replace(/__(.+?)__/gs, '<b>$1</b>');

  // Italic: *text* or _text_ → <i>text</i>
  t = t.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>');
  t = t.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~ → <s>text</s>
  t = t.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Spoiler: ||text|| → <tg-spoiler>text</tg-spoiler>
  t = t.replace(/\|\|(.+?)\|\|/gs, '<tg-spoiler>$1</tg-spoiler>');

  // Headers: ## Title → bold with blank line
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '\n<b>$1</b>\n');

  // Blockquotes: > text → <blockquote>text</blockquote>
  // Collect consecutive > lines into one blockquote
  t = t.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
    const lines = match.split('\n')
      .map(l => l.replace(/^&gt;\s?/, ''))
      .filter(l => l.trim() !== '');
    return '<blockquote>' + lines.join('\n') + '</blockquote>\n';
  });

  // Links: [text](url) → <a href="url">text</a>
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bare URLs → clickable (only http/https, not already inside <a>)
  // Skip this — Telegram auto-links URLs anyway

  // Horizontal rules → blank line
  t = t.replace(/^[-*_]{3,}\s*$/gm, '');

  // Tables → simple list
  t = t.replace(/^\s*\|?[-:\s|]+\|[-:\s|]*\s*$/gm, '');
  t = t.replace(/\|/g, '  ');

  // 5. Whitespace cleanup
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{4,}/g, '\n\n\n');
  t = t.replace(/^\n+/, '');

  return t.trim();
}

function sendLong(chatId, text, opts = {}) {
  if (!bot) return;
  if (text.length <= 4000) { bot.sendMessage(chatId, text, opts).catch(() => {}); return; }
  const chunks = text.match(/.{1,4000}/gs) || [text];
  for (const chunk of chunks) bot.sendMessage(chatId, chunk, opts).catch(() => {});
}

// Process LLM reply: extract cron + media tags, send text + media
async function processReply(chatId, rawReply) {
  // 1. Extract cron tags
  const { clean: noCron, jobs } = extractCronTags(rawReply);
  for (const job of jobs) {
    if (!cronEnabled) continue;
    try {
      const cron = createCronJob(chatId, job.schedule, job.task);
      console.log(`[cron] Auto-created from LLM: "${cron.task}" (${describeSchedule(cron.schedule)}) id=${cron.id}`);
    } catch (e) {
      console.error('[cron] Failed to create from LLM tag:', e.message);
    }
  }

  // 2. Extract media tags
  const { clean: reply, images, photos, files } = extractMediaTags(noCron);

  // 3. Clean markdown → Telegram HTML and send
  const cleanReply = reply ? cleanForTelegram(reply) : '';
  if (cleanReply) sendLong(chatId, cleanReply, { parse_mode: 'HTML' });

  // 4. Generate and send images (via backend proxy → Together AI FLUX)
  for (const img of images) {
    try {
      bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
      console.log(`[media] Generating image: "${img.prompt.slice(0, 60)}..."`);
      const genRes = await fetch(`${LLM_BASE_URL}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: img.prompt, width: img.width, height: img.height }),
      });
      const genData = await genRes.json();
      if (genData.error) throw new Error(genData.error.message || 'Generation failed');
      if (!genData.image) throw new Error('No image data');
      const buf = Buffer.from(genData.image, 'base64');
      await bot.sendPhoto(chatId, buf, { caption: img.prompt.slice(0, 200) }, { filename: 'image.png', contentType: 'image/png' });
      console.log(`[media] Sent image (${Math.round(buf.length / 1024)}KB)`);
    } catch (e) {
      console.error('[media] Image generation failed:', e.message);
      bot.sendMessage(chatId, `⚠️ Image generation failed: ${e.message}`).catch(() => {});
    }
  }

  // 5. Send photos from URL
  for (const photo of photos) {
    try {
      bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
      const res = await fetch(photo.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await bot.sendPhoto(chatId, buf, { caption: photo.caption || '' }, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    } catch (e) {
      console.error('[media] Photo send failed:', e.message);
      bot.sendMessage(chatId, `⚠️ Could not send photo: ${e.message}`).catch(() => {});
    }
  }

  // 6. Send files from URL
  for (const file of files) {
    try {
      bot.sendChatAction(chatId, 'upload_document').catch(() => {});
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await bot.sendDocument(chatId, buf, { caption: file.caption || '' }, { filename: file.name, contentType: 'application/octet-stream' });
    } catch (e) {
      console.error('[media] File send failed:', e.message);
      bot.sendMessage(chatId, `⚠️ Could not send file: ${e.message}`).catch(() => {});
    }
  }

  // If no text and no media sent, send fallback
  if (!cleanReply && images.length === 0 && photos.length === 0 && files.length === 0) {
    sendLong(chatId, '...');
  }
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

  // Access control
  if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
    const hasRealUsers = allowedUsers.some(id => id > 100000);
    if (hasRealUsers) { bot.sendMessage(chatId, '⛔ Access denied.').catch(() => {}); return; }
    allowedUsers.push(userId);
    console.log(`[agent] Auto-added owner: ${userId}`);
  }

  // === Handle voice/audio messages ===
  if (msg.voice || msg.audio) {
    if (!hasVoiceSkill) {
      bot.sendMessage(chatId, '🎙️ Voice messages are not enabled for this agent. Enable the Voice Messages skill to use this feature.').catch(() => {});
      return;
    }

    const fileObj = msg.voice || msg.audio;
    const duration = fileObj.duration || 0;

    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      // Download audio file from Telegram
      const fileLink = await bot.getFileLink(fileObj.file_id);
      const audioRes = await fetch(fileLink);
      if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // Transcribe via backend Whisper proxy
      const transcription = await transcribeAudio(audioBuffer, 'ogg', duration);

      if (!transcription || transcription.trim().length === 0) {
        sendLong(chatId, '⚠️ Could not transcribe the voice message. Please try again or send a text message.');
        return;
      }

      console.log(`[voice] Transcribed ${duration}s audio: "${transcription.slice(0, 80)}..."`);

      // Pass transcription to LLM as regular message
      const rawReply = await callLLM(chatId, transcription);
      await processReply(chatId, rawReply);
    } catch (e) {
      console.error('[voice] Error:', e.message);
      sendLong(chatId, `⚠️ Voice processing error: ${e.message}`);
    }
    return;
  }

  // === Text messages ===
  const text = (msg.text || '').trim();
  if (!text) return;

  // /start
  if (text === '/start') {
    const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION || '';
    const skillNames = skillsEnabled.length > 0
      ? skillsEnabled.map(id => id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')).join(', ')
      : 'Chat';
    const descText = AGENT_DESCRIPTION || 'your personal tasks';
    bot.sendMessage(chatId,
      `🦞 Hi! I am Operent (<b>${escHtml(AGENT_NAME)}</b>), your personal AI agent.\n\nI created for: "${escHtml(descText)}"\nI can: "${escHtml(skillNames)}"\n\nPowered by @OperentBot`,
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
      `📊 <b>Agent Status</b>\n\nName: ${escHtml(AGENT_NAME)}\nModel: ${defaultModel.model}\nSkills: ${skillsEnabled.length > 0 ? skillsEnabled.join(', ') : 'none'}\nMessages in context: ${history.length}\nScheduled tasks: ${crons.length}\nAgent ID: <code>${AGENT_ID}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }

  // /cron commands
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
  await processReply(chatId, rawReply);
});

bot.on('polling_error', (error) => {
  console.error('[agent] Polling error:', error.code, error.message);
});

console.log(`🦞 Agent "${AGENT_NAME}" (${AGENT_ID}) is running`);
if (skillsEnabled.length > 0) console.log(`[agent] Skills: ${skillsEnabled.join(', ')}`);
