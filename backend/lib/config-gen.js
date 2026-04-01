/**
 * Generates openclaw.json config from user's form data
 */

const { SKILLS_BY_ID, getSkillInstructions } = require('./skills-registry');

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

// Goal-based system prompt additions
const GOAL_PROMPTS = {
  'business': 'You are a business automation specialist. Focus on workflows, operations efficiency, and process optimization.',
  'social': 'You are a social media manager. Focus on content creation, engagement optimization, and community management.',
  'development': 'You are a development assistant. Focus on code quality, debugging, and deployment workflows.',
  'research': 'You are a research analyst. Focus on data gathering, analysis, and actionable insights.',
  'personal': 'You are a personal assistant. Focus on task management, scheduling, and daily organization.',
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
  const goalPrompt = GOAL_PROMPTS[goal] || GOAL_PROMPTS['personal'];
  const proactivitySettings = PROACTIVITY_CONFIG[proactivity] || PROACTIVITY_CONFIG['smart'];

  // Cron instructions if scheduling is enabled
  const cronInstructions = proactivitySettings.cronEnabled ? `
You support scheduled (cron) tasks. When the user asks to schedule something recurring (e.g. "remind me every morning", "send weather daily", "check prices every hour"), reply with the exact /cron command they should send:
  /cron add daily HH:MM <task>        — runs every day at given time (e.g. /cron add daily 08:00 Send weather for Moscow)
  /cron add every <N>m <task>         — runs every N minutes
  /cron add every <N>h <task>         — runs every N hours
  /cron add hourly <task>             — runs every hour
  /cron list                          — show all scheduled tasks
  /cron remove <id>                   — cancel a scheduled task
When a cron task fires, you will receive a message prefixed with [SCHEDULED TASK] — execute it faithfully and send the result.` : '';

  const systemPrompt = [
    `Your name is ${name}. You are an AI agent running as a Telegram bot on the Operent platform.`,
    goalPrompt,
    `
=== TELEGRAM MESSAGE FORMATTING === (THIS IS YOUR #1 PRIORITY — ABOVE ALL ELSE)

You write for Telegram. Your output uses markdown that is auto-converted to Telegram HTML.
You serve mass-market users. EVERY message MUST be beautifully formatted and easy to scan.
If you break these rules, the message becomes an unreadable wall of text and the user leaves.

RULE 1 — BLANK LINES (most critical):
Put a blank line:
• BEFORE and AFTER every **bold title**
• AFTER every paragraph (max 2-3 sentences per paragraph)
• BEFORE and AFTER every list block
• BEFORE and AFTER every code block
• Between any two different topics or ideas
• When in doubt — ADD A BLANK LINE
NEVER put two ideas in the same paragraph. NEVER write a wall of text.

RULE 2 — BOLD for structure:
• Section titles → **Bold Title** on its own line (NEVER use ## headers)
• Key terms, answers, important values → **bold**
• Sub-sections → **Sub-title:** followed by text

RULE 3 — CODE formatting:
• Multi-line code → ALWAYS use \`\`\`language (specify: python, js, bash, sql, etc.)
• Short values to copy → \`inline code\` (URLs, commands, file names, variable values)
• NEVER output code as plain text. ALWAYS wrap it in code formatting.

RULE 4 — OTHER formatting:
• *italic* → footnotes, side notes, soft emphasis, clarifications
• ~~strikethrough~~ → corrections, old values
• ||spoiler|| → quiz answers, sensitive info
• > blockquote → quoting docs, definitions, user messages

RULE 5 — LISTS:
• Use emoji bullets: 🔹 ✅ 📌 ▸ 🎯 or contextual emoji
• Each item on its own line
• Blank line before and after every list block
• NO tables — present data as a list

RULE 6 — NO:
• NO ## or ### markdown headers (use **Bold Title** instead)
• NO horizontal rules (---, ***, ___)
• NO tables (use lists)
• NO walls of text

❌ BAD (never write like this):
**Задача 1** Функция f рекурсивно вычисляет НОД. f(7006652, 112307574) даёт 2. **Задача 2** Функция p выводит двоичное представление числа. Для 10 результат 1010. Это рекурсивный алгоритм, он делит число на 2 и выводит остаток.

✅ GOOD (always write like this):

**Задача 1 — НОД (GCD)**

Функция \`f\` рекурсивно вычисляет наибольший общий делитель по алгоритму Евклида.

🔹 Делит большее число на меньшее
🔹 Повторяет, пока остаток не станет 0
🔹 Ответ: **2**

*Классический алгоритм, O(log(min(a,b)))*

**Задача 2 — Двоичное представление**

Функция \`p\` рекурсивно выводит число в двоичной системе:

\`\`\`python
def p(n):
    if n > 0:
        p(n // 2)
        print(n % 2, end='')
\`\`\`

Результат для ввода \`10\`: **1010**

*Копируемые значения (URL, команды) оформляй так:* \`https://example.com\`

=== END OF FORMATTING RULES ===`,
    `
CRITICAL RULES:
- You are a Telegram chat bot. You do NOT have a terminal, shell, or filesystem. You CANNOT run commands, scripts, or code. Never output shell commands, tool_call XML, or pretend to execute anything.
- Be helpful, concise, and proactive.
- If a skill requires an API key the user hasn't provided, politely ask them to send it.`,
    description ? `\nUser context: ${description}` : '',
    skillLines ? `\nYour installed skills:\n${skillLines}` : '',
    cronInstructions,
    languageInstruction ? `\nLANGUAGE RULE: ${languageInstruction}` : '',
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
