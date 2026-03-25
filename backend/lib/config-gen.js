/**
 * Generates openclaw.json config from user's form data
 */

// Map form model names to openclaw model identifiers
const MODEL_MAP = {
  'haiku': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  'sonnet': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'opus': { provider: 'anthropic', model: 'claude-opus-4-6' },
  'codex': { provider: 'openai', model: 'gpt-4o' },
  'kimi': { provider: 'kimi', model: 'moonshot-v1-128k' },
};

// Map capabilities to openclaw skill bundles
const CAPABILITY_SKILLS = {
  'browser': ['web-browsing', 'browser-automation'],
  'social': ['instagram', 'twitter', 'linkedin'],
  'voice': ['voice-messages', 'speech-to-text'],
  'docs': ['google-docs', 'google-sheets'],
  'calendar': ['google-calendar', 'scheduling'],
  'analytics': ['data-analysis', 'reporting'],
  'youtube': ['youtube-management'],
};

// Human-readable descriptions for each skill
const SKILL_DESCRIPTIONS = {
  'web-browsing':        'Browse websites and search the internet',
  'browser-automation':  'Automate web browser interactions',
  'instagram':           'Manage Instagram (posts, DMs, engagement)',
  'twitter':             'Manage Twitter/X (tweets, replies, DMs)',
  'linkedin':            'Manage LinkedIn (posts, connections)',
  'voice-messages':      'Send and transcribe voice messages',
  'speech-to-text':      'Transcribe audio recordings to text',
  'google-docs':         'Create and edit Google Docs',
  'google-sheets':       'Create and edit Google Sheets',
  'google-calendar':     'Manage Google Calendar events',
  'scheduling':          'Schedule and manage tasks',
  'data-analysis':       'Analyze data and generate insights',
  'reporting':           'Create reports and summaries',
  'youtube-management':  'Manage YouTube channel content',
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
    capabilities = [],
    model = 'sonnet',
    proactivity = 'smart',
    routing = null,  // { coding: 'opus', everyday: 'sonnet', cron: 'haiku' }
  } = formData;

  // Resolve model config
  const primaryModel = MODEL_MAP[model] || MODEL_MAP['sonnet'];

  // Build skills list from capabilities
  const skills = [];
  for (const cap of capabilities) {
    if (CAPABILITY_SKILLS[cap]) {
      skills.push(...CAPABILITY_SKILLS[cap]);
    }
  }

  // Build system prompt
  const goalPrompt = GOAL_PROMPTS[goal] || GOAL_PROMPTS['personal'];
  const proactivitySettings = PROACTIVITY_CONFIG[proactivity] || PROACTIVITY_CONFIG['smart'];

  // Capability descriptions from enabled skills
  const capabilityLines = skills
    .map(s => SKILL_DESCRIPTIONS[s])
    .filter(Boolean)
    .map(d => `  • ${d}`)
    .join('\n');

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
    `Your name is ${name}. You are an OpenClaw AI agent running on the RentYourClaw platform.`,
    goalPrompt,
    description ? `User context: ${description}` : '',
    capabilityLines ? `\nYour enabled capabilities:\n${capabilityLines}` : '',
    cronInstructions,
    `\nAlways be helpful, concise, and proactive. Communicate in the language the user writes in.`,
  ].filter(Boolean).join('\n');

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
        botToken: '{{BOT_TOKEN}}',  // Injected as env var
        dmPolicy: 'open',
        allowedUsers: [telegramUserId],
      },
    },
    models: {
      // Route all requests through our proxy for usage tracking
      baseUrl: `${proxyBaseUrl}/v1/${agentId}`,
      defaults: {
        provider: primaryModel.provider,
        model: primaryModel.model,
      },
    },
    skills: {
      enabled: skills,
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

module.exports = { generateConfig, MODEL_MAP, CAPABILITY_SKILLS };
