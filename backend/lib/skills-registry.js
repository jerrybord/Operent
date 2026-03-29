/**
 * Skills Registry — All ClawHub skills available for agent deployment.
 *
 * Each skill has:
 *   id          — unique slug (used in config + form data)
 *   name        — display name
 *   emoji       — UI icon
 *   description — short UI description
 *   order       — display order in form
 *   runtime     — if true, agent.js has special handler code
 *   instructions — condensed SKILL.md content for LLM system prompt
 */

const SKILLS = [
  {
    id: 'voice-messages',
    name: 'Voice Messages',
    emoji: '🎙️',
    description: 'Speech-to-text transcription',
    order: 1,
    runtime: true,
    instructions: `# Voice Messages (Whisper)
You can receive and transcribe voice messages. When the user sends a voice note, it is automatically transcribed and delivered to you as text.
You should respond naturally to the transcribed content. If the transcription seems unclear, ask the user to clarify.
You can also discuss audio transcription, dictation workflows, and speech-to-text best practices.`,
  },
  {
    id: 'global-search',
    name: 'Global Search',
    emoji: '🔍',
    description: '17 search engines, no API key',
    order: 2,
    runtime: false,
    instructions: `# Multi Search Engine v2.0

You have access to 17 search engines for web research.

## Engines
**International:** Google, DuckDuckGo, Yahoo, Startpage, Brave, Ecosia, Qwant, WolframAlpha
**Chinese:** Baidu, Bing CN, 360, Sogou, WeChat Search, Toutiao, Jisilu

## URL Templates
- Google: https://www.google.com/search?q={keyword}
- DuckDuckGo: https://duckduckgo.com/html/?q={keyword}
- Brave: https://search.brave.com/search?q={keyword}
- WolframAlpha: https://www.wolframalpha.com/input?i={keyword}

## Advanced Operators
- site:github.com python — search within site
- filetype:pdf report — specific file type
- "machine learning" — exact match
- tbs=qdr:d (Google) — past day; tbs=qdr:w — past week

## DuckDuckGo Bangs
!g → Google, !gh → GitHub, !so → Stack Overflow, !w → Wikipedia, !yt → YouTube

When the user asks to search, construct the appropriate URL and share results or guide them.`,
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    emoji: '📧',
    description: 'Gmail, Calendar, Drive, Sheets',
    order: 3,
    runtime: false,
    instructions: `# Google Workspace
You can help the user with Gmail, Calendar, Drive, Sheets, and Docs via Google APIs.
Requires: user must provide a Google API key or OAuth credentials.
If the user hasn't set up Google access yet, guide them to create credentials at console.cloud.google.com.
You can compose emails, search messages, manage calendar events, work with spreadsheets, and more — just ask the user what they need.`,
  },
  {
    id: 'summarize',
    name: 'Summarize',
    emoji: '🧾',
    description: 'URLs, files & YouTube summaries',
    order: 4,
    runtime: false,
    instructions: `# Summarize
You can summarize URLs, articles, and YouTube videos. When the user sends a link, extract the key points and provide a concise summary. Adjust length based on user preference (short/medium/long). For YouTube videos, summarize the content based on the video title and description if transcript is unavailable.`,
  },
  {
    id: 'self-improving',
    name: 'Self-Improving',
    emoji: '🧠',
    description: 'Learn from errors & corrections',
    order: 5,
    runtime: false,
    instructions: `# Self-Improvement Skill

Capture learnings, errors, and corrections for continuous improvement.

## When to Log
- Command/operation fails → log to .learnings/ERRORS.md
- User corrects you → log to .learnings/LEARNINGS.md (category: correction)
- User requests missing feature → log to .learnings/FEATURE_REQUESTS.md
- Knowledge was outdated → category: knowledge_gap
- Found better approach → category: best_practice

## Entry Format
\`\`\`
### [Category] Title
**Date:** YYYY-MM-DD
**Context:** What was happening
**Learning:** The key takeaway
**Action:** What to do differently
**Priority:** P1-P4
\`\`\`

Broadly applicable learnings should be promoted to CLAUDE.md or project memory.`,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    emoji: '📺',
    description: 'Video transcript extraction',
    order: 6,
    runtime: false,
    instructions: `# YouTube
You can help with YouTube video content — summarization, Q&A, and key points extraction. When the user shares a YouTube link, analyze the video based on its title, description, and available context. Provide timestamps if possible.`,
  },
  {
    id: 'x-search',
    name: 'X (Twitter)',
    emoji: '𝕏',
    description: 'Search & analyze X posts',
    order: 7,
    runtime: false,
    instructions: `# X (Twitter) Search
You can search and analyze X/Twitter posts. Help the user find tweets by keyword, user handle, or date range. Requires: xAI API key (XAI_API_KEY). If the user hasn't provided one, ask them to get it from console.x.ai.`,
  },
  {
    id: 'trello',
    name: 'Trello',
    emoji: '📋',
    description: 'Manage boards & cards',
    order: 8,
    runtime: false,
    instructions: `# Trello
You can help manage Trello boards, lists, and cards. Create tasks, move cards, add comments, and organize workflows. Requires: Trello API key and token. If the user hasn't provided them, guide them to trello.com/power-ups/admin to get credentials.`,
  },
  {
    id: 'notion',
    name: 'Notion',
    emoji: '📝',
    description: 'Pages & databases',
    order: 9,
    runtime: false,
    instructions: `# Notion
You can help manage Notion pages, databases, and content. Create pages, query databases, update properties, and organize knowledge. Requires: Notion integration token (ntn_...). If the user hasn't provided one, guide them to notion.so/my-integrations to create an integration.`,
  },
  {
    id: 'slack',
    name: 'Slack',
    emoji: '💬',
    description: 'Messages, reactions & pins',
    order: 10,
    runtime: false,
    instructions: `# Slack
You can help with Slack messaging — send messages, react, pin, read channels, and manage conversations. Requires: Slack Bot token (xoxb-...). If the user hasn't provided one, guide them to api.slack.com/apps to create a bot and get a token.`,
  },
  {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Issues, PRs & CI',
    order: 11,
    runtime: false,
    instructions: `# GitHub
You can help with GitHub — issues, PRs, CI status, and code review. Requires: GitHub personal access token. If the user hasn't provided one, guide them to github.com/settings/tokens to create one.`,
  },
  {
    id: 'nano-banana',
    name: 'Nano Banana',
    emoji: '🎨',
    description: 'AI image gen & editing',
    order: 12,
    runtime: false,
    instructions: `# Nano Banana Pro (AI Image Generation)

You can generate images directly in the chat using the <image> tag.

## Usage
Include in your response: <image prompt="detailed description of the image"/>

## Tips for great prompts
- Write prompts in English for best results
- Be specific: style, lighting, composition, colors, mood
- Include art style: "photorealistic", "watercolor", "digital art", "oil painting", "anime", "3D render"
- Include camera details for photos: "wide angle", "macro", "portrait lens", "bokeh"

## Examples
- <image prompt="a cozy coffee shop interior, warm lighting, wooden tables, rain outside the window, photorealistic"/>
- <image prompt="cute orange cat wearing a tiny top hat, digital art, detailed fur, studio lighting"/>
- <image prompt="futuristic cityscape at sunset, neon lights, flying cars, cyberpunk style, wide angle"/>

## Multiple images
You can include multiple <image> tags in one response to generate several images.

## Important
- Always describe what you're generating in your text response
- Translate user requests to detailed English prompts for optimal quality
- You cannot edit existing images — only generate new ones from text prompts`,
  },
  {
    id: 'nano-pdf',
    name: 'Nano PDF',
    emoji: '📄',
    description: 'Edit PDFs with natural language',
    order: 13,
    runtime: false,
    instructions: `# Nano PDF
You can help the user with PDF files — reading, summarizing, and discussing PDF content. When the user sends a PDF or asks about one, help them extract information, answer questions about the content, or summarize it.`,
  },
  {
    id: 'clawhub',
    name: 'ClawHub',
    emoji: '🔧',
    description: 'Install & manage skills',
    order: 14,
    runtime: false,
    instructions: `# ClawHub
You know about ClawHub — the skill marketplace for AI agents. You can recommend skills from the ClawHub registry, explain what each skill does, and help the user decide which skills to install for their needs. Browse at clawdhub.com.`,
  },
];

// Quick lookup maps
const SKILLS_BY_ID = {};
const SKILLS_ORDERED = SKILLS.sort((a, b) => a.order - b.order);
for (const s of SKILLS) SKILLS_BY_ID[s.id] = s;

/**
 * Get instructions text for a set of skill IDs (for system prompt injection)
 */
function getSkillInstructions(skillIds) {
  if (!skillIds || skillIds.length === 0) return '';
  const parts = [];
  for (const id of skillIds) {
    const skill = SKILLS_BY_ID[id];
    if (skill) parts.push(skill.instructions);
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Get skill list for API/frontend (without full instructions)
 */
function getSkillList() {
  return SKILLS_ORDERED.map(s => ({
    id: s.id,
    name: s.name,
    emoji: s.emoji,
    description: s.description,
    order: s.order,
  }));
}

module.exports = { SKILLS, SKILLS_BY_ID, SKILLS_ORDERED, getSkillInstructions, getSkillList };
