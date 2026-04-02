/**
 * Generates openclaw.json config from user's form data
 */

const fs   = require('fs');
const path = require('path');
const { SKILLS_BY_ID, getSkillInstructions } = require('./skills-registry');

// Load soul files from templates
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'agent-workspace');
function loadSoul(goal) {
  const goalFile = path.join(TEMPLATES_DIR, 'goals', `${goal}.md`);
  const baseSoul = path.join(TEMPLATES_DIR, 'SOUL.md');
  try {
    if (fs.existsSync(goalFile)) return fs.readFileSync(goalFile, 'utf8');
    if (fs.existsSync(baseSoul))  return fs.readFileSync(baseSoul, 'utf8');
  } catch (e) { /* ignore */ }
  return null;
}

// Map form model names to openclaw model identifiers
const MODEL_MAP = {
  'haiku':    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  'sonnet':   { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'opus':     { provider: 'anthropic', model: 'claude-opus-4-6' },
  'codex':    { provider: 'openai',    model: 'gpt-4o' },
  'gpt4mini': { provider: 'openai',    model: 'gpt-4o-mini' },
  'o3':       { provider: 'openai',    model: 'o3' },
  'kimi':     { provider: 'kimi',      model: 'moonshot-v1-128k' },
};

// Proactivity presets
const PROACTIVITY_CONFIG = {
  'passive': {
    proactive: false,
    cronEnabled: false,
    nudges: false,
  },
  'smart': {
    proactive: true,
    cronEnabled: true,
    nudges: true,
    maxDailyNudges: 5,
  },
  'autopilot': {
    proactive: true,
    cronEnabled: true,
    nudges: true,
    maxDailyNudges: 50,
    autoExecute: true,
  },
};

// Goal-based fallback prompts (used only if soul file is missing)
const GOAL_PROMPTS = {
  'business':    'You are a business automation specialist. Focus on workflows, operations efficiency, and process optimization.',
  'social':      'You are a social media manager. Focus on content creation, engagement optimization, and community management.',
  'development': 'You are a development assistant. Focus on code quality, debugging, and deployment workflows.',
  'research':    'You are a research analyst. Focus on data gathering, analysis, and actionable insights.',
  'personal':    'You are a personal assistant. Focus on task management, scheduling, and daily organization.',
};

/**
 * Generate full openclaw.json config
 * @param {Object} formData - Data from the WebApp form
 * @param {string} proxyBaseUrl - URL of our LLM proxy
 * @returns {Object} openclaw.json config
 */
function generateConfig(formData, proxyBaseUrl) {
  const {
    agentId,
    name = 'Agent',
    botToken,
    telegramUserId,
    description = '',
    goal = 'personal',
    skills = [],
    personalities = [],
    model = 'sonnet',
    proactivity = 'smart',
    routing = null,
    language = 'english',
  } = formData;

  const LANGUAGE_INSTRUCTIONS = {
    russian:  'Always respond in Russian (Русский). Communicate exclusively in Russian regardless of the language used in instructions or queries.',
    chinese:  'Always respond in Chinese Mandarin (普通话/中文). Communicate exclusively in Mandarin regardless of the language used in instructions.',
    hindi:    'Always respond in Hindi (हिन्दी). Communicate exclusively in Hindi regardless of the language used in instructions.',
    spanish:  'Always respond in Spanish (Español). Communicate exclusively in Spanish regardless of the language used in instructions.',
    arabic:   'Always respond in Arabic (العربية). Communicate exclusively in Arabic regardless of the language used in instructions.',
    english:  '',
  };
  const languageInstruction = LANGUAGE_INSTRUCTIONS[language] || '';

  // Resolve model config
  const primaryModel = MODEL_MAP[model] || MODEL_MAP['sonnet'];

  // Validate skill IDs
  const validSkills = skills.filter(id => SKILLS_BY_ID[id]);

  // Build skill descriptions for system prompt
  const skillLines = validSkills
    .map(id => {
      const s = SKILLS_BY_ID[id];
      return s ? `  • ${s.emoji} ${s.name} — ${s.description}` : null;
    })
    .filter(Boolean)
    .join('\n');

  // Build system prompt
  const soulContent = loadSoul(goal);
  const goalPrompt  = soulContent || GOAL_PROMPTS[goal] || GOAL_PROMPTS['personal'];
  const proactivitySettings = PROACTIVITY_CONFIG[proactivity] || PROACTIVITY_CONFIG['smart'];

  // Cron instructions if scheduling is enabled
  const cronInstructions = proactivitySettings.cronEnabled ? `\n\n=== SCHEDULED TASKS (CRON) ===

When the user asks to do something repeatedly or on a schedule ("remind me every morning", "send weather daily", "check prices hourly"), automatically create a cron task by including this invisible XML tag anywhere in your reply:

  <cron schedule="SCHEDULE" task="TASK_DESCRIPTION"/>

SCHEDULE formats:
  daily HH:MM     — every day at a given time (e.g. daily 08:00)
  every Nm        — every N minutes (e.g. every 30m)
  every Nh        — every N hours (e.g. every 2h)
  hourly          — every hour

TASK_DESCRIPTION: a self-contained instruction of what to do when the task fires.

Example: User asks "Remind me about standup every day at 9"
→ You reply: "Done! I'll remind you about standup at 09:00 every day. <cron schedule="daily 09:00" task="Send standup reminder to user"/>"

Rules:
- ALWAYS include the <cron> tag when scheduling is requested — never just promise to do it
- The tag is stripped before the message is shown to the user
- When a task fires, you receive [SCHEDULED TASK] prefix — execute and send result` : '';

  // HTML formatting override — soul files mention MarkdownV2 but the bot uses parse_mode=HTML
  const htmlFormatNote = `\n\n=== CRITICAL: TELEGRAM HTML FORMATTING ===
This bot sends ALL messages with parse_mode=HTML. MANDATORY rules:

TAGS — always use these:
• <b>текст</b> — жирный (заголовки, ключевые слова)
• <i>текст</i> — курсив (акценты)
• <code>текст</code> — инлайн-код (команды, значения, числа)
• <pre><code class="language-js">блок кода</code></pre> — многострочный код
• <blockquote>текст</blockquote> — цитата или ключевой вывод

NEVER use: *bold*  _italic_  \`\`\`code\`\`\`  **bold**  ## headers

SPACING — критически важно:
• Пустая строка между секциями (<b>Header</b> и следующим блоком разделяет пустая строка)
• Каждый пункт списка — на ОТДЕЛЬНОЙ строке. НИКОГДА не пиши несколько • на одной строке.
• После каждого <b>Заголовок:</b> — перенос строки, потом содержимое

Пример ПРАВИЛЬНОГО форматирования:
<b>📊 Заголовок</b>

<b>Подраздел:</b>
• Пункт 1
• Пункт 2
• Пункт 3

<b>Вывод:</b>
Текст вывода.

Plain unformatted text — НЕ ДОПУСТИМ.`;

  const systemPrompt = [
    // Soul content comes FIRST — it defines who the agent is and how it responds
    `=== YOUR CORE INSTRUCTIONS (MANDATORY — FOLLOW EXACTLY) ===\n`,
    goalPrompt,
    htmlFormatNote,
    // Agent identity and runtime context
    `\n\n=== AGENT IDENTITY ===`,
    `Your name is ${name}. You are an AI agent running as a Telegram bot, built on the Operent platform.`,
    `You do NOT have a terminal, shell, or filesystem. You CANNOT run commands or scripts. Never pretend to execute anything.`,
    `If a skill requires an API key the user hasn't provided, politely ask them to send it.`,
    description ? `\nUser context: ${description}` : '',
    skillLines ? `\nInstalled skills:\n${skillLines}` : '',
    personalities && personalities.length > 0
      ? `\n\n=== ADDITIONAL ROLES & PERSONALITIES ===\nYou have been configured with the following extra roles. Blend them naturally into your behavior:\n\n` +
        personalities.map(p => `[${p.key.toUpperCase()}]${p.instructions ? '\n' + p.instructions : ''}`).join('\n\n')
      : '',
    cronInstructions,
    languageInstruction ? `\n\nLANGUAGE RULE: ${languageInstruction}` : '',
  ].filter(Boolean).join('\n');

  // Build skill instructions map for agent runtime
  const skillInstructions = {};
  for (const id of validSkills) {
    const s = SKILLS_BY_ID[id];
    if (s) skillInstructions[id] = s.instructions;
  }

  // Build the config
  const config = {
    version: '1.0',
    agent: {
      name,
      systemPrompt,
      ...PROACTIVITY_CONFIG[proactivity] || PROACTIVITY_CONFIG['smart'],
    },
    channels: {
      telegram: {
        botToken: '{{BOT_TOKEN}}',
        dmPolicy: 'open',
        allowedUsers: [telegramUserId],
      },
    },
    models: {
      baseUrl: `${proxyBaseUrl}/v1/${agentId}`,
      defaults: {
        provider: primaryModel.provider,
        model: primaryModel.model,
      },
    },
    skills: {
      enabled: validSkills,
      instructions: skillInstructions,
    },
  };

  // Add routing if Custom Routing selected
  if (routing) {
    config.models.routing = {};
    for (const [taskType, modelKey] of Object.entries(routing)) {
      const m = MODEL_MAP[modelKey] || MODEL_MAP['sonnet'];
      config.models.routing[taskType] = {
        provider: m.provider,
        model: m.model,
      };
    }
  }

  return config;
}

module.exports = { generateConfig, MODEL_MAP };
