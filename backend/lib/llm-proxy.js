/**
 * LLM Proxy with per-agent usage tracking & limits
 *
 * Routes: POST /v1/:agentId/messages  (Anthropic format)
 *         POST /v1/:agentId/chat/completions  (OpenAI format)
 *
 * Supported providers:
 *   - Anthropic (Claude Haiku/Sonnet/Opus)
 *   - Moonshot/Kimi (OpenAI-compatible)
 *   - OpenAI (when added later)
 */

const { db, queries } = require('./db');

// Cost per 1K tokens (USD) — 25% markup over official API prices
const COST_PER_1K = {
  // Haiku 4.5: official $1/$5 per 1M → markup $1.25/$6.25 per 1M
  'claude-haiku-4-5-latest':    { input: 0.00125, output: 0.00625 },
  'claude-haiku-4-5-20251001':  { input: 0.00125, output: 0.00625 },
  // Sonnet 4.6: official $3/$15 per 1M → markup $3.75/$18.75 per 1M
  'claude-sonnet-4-6':          { input: 0.00375, output: 0.01875 },
  'claude-sonnet-4-6-latest':   { input: 0.00375, output: 0.01875 },
  'claude-sonnet-4-6-20250514': { input: 0.00375, output: 0.01875 },
  // Opus 4.6: official $5/$25 per 1M → markup $6.25/$31.25 per 1M
  'claude-opus-4-6':            { input: 0.00625, output: 0.03125 },
  'claude-opus-4-6-latest':     { input: 0.00625, output: 0.03125 },
  'claude-opus-4-6-20250514':   { input: 0.00625, output: 0.03125 },
  // Kimi K2.5: markup $0.75/$3.75 per 1M
  'kimi-k2-0711':       { input: 0.00075, output: 0.00375 },
  'moonshot-v1-128k':   { input: 0.00075, output: 0.00375 },
  // OpenAI models (25% markup)
  // GPT-4o: official $2.5/$10 per 1M
  'gpt-4o':             { input: 0.003125, output: 0.0125 },
  // GPT-4o mini: official $0.15/$0.60 per 1M
  'gpt-4o-mini':        { input: 0.0001875, output: 0.00075 },
  // o3: official $10/$40 per 1M
  'o3':                 { input: 0.0125, output: 0.05 },
  'o3-mini':            { input: 0.001375, output: 0.00550 },
  // Legacy model IDs (existing agents may still use these)
  'claude-haiku-4-5-20241022':  { input: 0.00125, output: 0.00625 },
  'claude-sonnet-4-20250514':   { input: 0.00375, output: 0.01875 },
  'claude-sonnet-4-5-20250514': { input: 0.00375, output: 0.01875 },
  'claude-opus-4-20250514':     { input: 0.00625, output: 0.03125 },
};

// Strip invalid date suffixes from model IDs (e.g. claude-sonnet-4-6-20250514 → claude-sonnet-4-6)
function normalizeModel(model) {
  if (!model) return model;
  // Remove date suffixes from claude-*-4-6 models (they don't have dated versions yet)
  return model
    .replace(/^(claude-sonnet-4-6)-\d+$/, '$1')
    .replace(/^(claude-opus-4-6)-\d+$/, '$1')
    .replace(/^(claude-sonnet-4-6)-latest$/, '$1')
    .replace(/^(claude-opus-4-6)-latest$/, '$1');
}

// Detect provider from model name
function detectProvider(model) {
  if (!model) return 'anthropic';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('moonshot') || model.startsWith('kimi')) return 'kimi';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o2') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  return 'anthropic'; // default
}

/**
 * Check if user has sufficient balance for at least one request.
 * Returns { allowed, balanceCents, userId } or { allowed: false, reason }.
 */
function checkBalance(agentId) {
  const agent = queries.getAgent.get(agentId);
  if (!agent) return { allowed: false, reason: 'Agent not found' };

  const user = queries.getUserById.get(agent.user_id);
  if (!user) return { allowed: false, reason: 'User not found' };

  const balanceCents = user.balance_cents || 0;
  if (balanceCents <= 0) {
    return { allowed: false, reason: 'Insufficient balance. Please top up.', balanceCents, userId: user.id };
  }

  return { allowed: true, balanceCents, userId: user.id };
}

/**
 * Check if routing config has ≥2 distinct models
 */
function needsRouting(routingConfig) {
  if (!routingConfig || typeof routingConfig !== 'object') return false;
  const models = Object.values(routingConfig).map(m => m && m.model).filter(Boolean);
  if (models.length < 2) return false;
  return new Set(models).size > 1;
}

/**
 * Extract the last user message text from a messages array
 */
function extractLastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content))
      return msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
  }
  return '';
}

/**
 * Classify a user message into: coding | cron | everyday
 * Uses Kimi K2 as a cheap classifier — cost is logged under the agent.
 */
async function classifyTask(agentId, messages) {
  const text = extractLastUserMessage(messages).slice(0, 600);
  if (!text) return 'everyday';

  const prompt = `Classify this user message into exactly one category:
- coding: code writing, debugging, technical development, programming
- cron: scheduled tasks, reminders, recurring jobs, automation scripts
- everyday: general conversation, questions, information, daily tasks
Reply with ONE word only: coding, cron, or everyday.
Message: "${text}"`;

  const baseUrl = process.env.KIMI_API_BASE || 'https://api.moonshot.cn/v1';
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.KIMI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'moonshot-v1-128k',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10,
        temperature: 0,
      }),
    });
    const data = await response.json();
    if (data.usage) logUsage(agentId, 'moonshot-v1-128k', data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
    const raw = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    if (raw === 'coding' || raw.startsWith('cod')) return 'coding';
    if (raw === 'cron' || raw.includes('cron') || raw.includes('sched')) return 'cron';
    return 'everyday';
  } catch (e) {
    console.error('[routing] classify error:', e.message);
    return 'everyday';
  }
}

/**
 * Convert Anthropic Messages format → OpenAI Chat Completions format
 */
function convertAnthropicToOpenAI(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  for (const msg of (body.messages || [])) {
    const content = Array.isArray(msg.content)
      ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : (msg.content || '');
    messages.push({ role: msg.role, content });
  }
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stream: body.stream,
  };
}

/**
 * Log token usage after a request and deduct cost from user balance.
 */
function logUsage(agentId, model, inputTokens, outputTokens) {
  const costs = COST_PER_1K[model] || { input: 0.00375, output: 0.01875 }; // default to Sonnet pricing
  const costUsd = (inputTokens / 1000 * costs.input) + (outputTokens / 1000 * costs.output);
  const costCents = Math.round(costUsd * 100);

  // Log usage
  queries.logUsage.run(agentId, model, inputTokens, outputTokens, costUsd);

  // Deduct from user balance
  const agent = queries.getAgent.get(agentId);
  if (agent) {
    queries.deductUserBalance.run(costCents, agent.user_id);
  }

  return costUsd;
}

/**
 * Proxy request to Anthropic API
 */
async function proxyAnthropic(agentId, requestBody) {
  const bal = checkBalance(agentId);
  if (!bal.allowed) {
    return {
      status: 402,
      body: { error: { type: 'insufficient_balance', message: bal.reason } },
    };
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...requestBody, model: normalizeModel(requestBody.model) }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`Anthropic API error [${response.status}] model=${requestBody.model} → ${normalizeModel(requestBody.model)}:`, JSON.stringify(data));
  }

  if (data.usage) {
    logUsage(agentId, requestBody.model, data.usage.input_tokens, data.usage.output_tokens);
  }

  return { status: response.status, body: data };
}

/**
 * Proxy request to Kimi/Moonshot API (OpenAI-compatible)
 */
async function proxyKimi(agentId, requestBody) {
  const bal = checkBalance(agentId);
  if (!bal.allowed) {
    return {
      status: 402,
      body: { error: { message: bal.reason, type: 'insufficient_balance' } },
    };
  }

  const baseUrl = process.env.KIMI_API_BASE || 'https://api.moonshot.cn/v1';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.KIMI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();

  if (data.usage) {
    logUsage(agentId, requestBody.model, data.usage.prompt_tokens, data.usage.completion_tokens);
  }

  return { status: response.status, body: data };
}

/**
 * Proxy request to OpenAI API
 */
async function proxyOpenAI(agentId, requestBody) {
  const bal = checkBalance(agentId);
  if (!bal.allowed) {
    return {
      status: 402,
      body: { error: { message: bal.reason, type: 'insufficient_balance' } },
    };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();

  if (data.usage) {
    logUsage(agentId, requestBody.model, data.usage.prompt_tokens, data.usage.completion_tokens);
  }

  return { status: response.status, body: data };
}

/**
 * Smart router — picks the right provider based on model name
 */
async function proxyRequest(agentId, requestBody, format) {
  const model = requestBody.model || '';
  const provider = detectProvider(model);

  // For Anthropic Messages format
  if (format === 'anthropic') {
    return proxyAnthropic(agentId, requestBody);
  }

  // For OpenAI-compatible format — route by provider
  switch (provider) {
    case 'kimi':
      return proxyKimi(agentId, requestBody);
    case 'openai':
      return proxyOpenAI(agentId, requestBody);
    case 'anthropic':
      // Convert OpenAI format to Anthropic if needed, or just use Anthropic
      return proxyAnthropic(agentId, requestBody);
    default:
      return proxyAnthropic(agentId, requestBody);
  }
}

/**
 * Express router for LLM proxy
 */
function createProxyRouter(express) {
  const router = express.Router();

  // Anthropic Messages API
  router.post('/:agentId/messages', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { agentId } = req.params;
      const agent = queries.getAgent.get(agentId);
      if (!agent || agent.status !== 'active') {
        return res.status(404).json({ error: { message: 'Agent not found or inactive' } });
      }

      let requestBody = req.body;

      // Custom routing: classify task and select model
      let agentConfig = {};
      try { agentConfig = JSON.parse(agent.config || '{}'); } catch (e) {}
      const routingConfig = agentConfig?.models?.routing;

      if (needsRouting(routingConfig)) {
        const taskType = await classifyTask(agentId, requestBody.messages || []);
        const routed = routingConfig[taskType] || routingConfig.everyday;
        if (routed && routed.model) {
          console.log(`[routing] agent=${agentId} task=${taskType} → ${routed.provider}/${routed.model}`);
          requestBody = { ...requestBody, model: routed.model };
          const provider = routed.provider || detectProvider(routed.model);
          if (provider === 'kimi') {
            const result = await proxyKimi(agentId, convertAnthropicToOpenAI(requestBody));
            // Convert OpenAI response → Anthropic format for the agent SDK
            const oai = result.body;
            const anthropicBody = oai.choices ? {
              id: oai.id,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: oai.choices[0]?.message?.content || '' }],
              model: routed.model,
              stop_reason: oai.choices[0]?.finish_reason === 'stop' ? 'end_turn' : oai.choices[0]?.finish_reason,
              usage: { input_tokens: oai.usage?.prompt_tokens || 0, output_tokens: oai.usage?.completion_tokens || 0 },
            } : oai;
            return res.status(result.status).json(anthropicBody);
          }
          if (provider === 'openai') {
            const result = await proxyOpenAI(agentId, convertAnthropicToOpenAI(requestBody));
            const oai = result.body;
            const anthropicBody = oai.choices ? {
              id: oai.id,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: oai.choices[0]?.message?.content || '' }],
              model: routed.model,
              stop_reason: oai.choices[0]?.finish_reason === 'stop' ? 'end_turn' : oai.choices[0]?.finish_reason,
              usage: { input_tokens: oai.usage?.prompt_tokens || 0, output_tokens: oai.usage?.completion_tokens || 0 },
            } : oai;
            return res.status(result.status).json(anthropicBody);
          }
          // anthropic provider — just swap the model and continue normally
        }
      }

      const result = await proxyAnthropic(agentId, requestBody);
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error('Proxy error (anthropic):', error.message);
      res.status(500).json({ error: { message: 'Proxy error: ' + error.message } });
    }
  });

  // OpenAI-compatible Chat Completions (auto-routes to Kimi/OpenAI/etc)
  router.post('/:agentId/chat/completions', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { agentId } = req.params;
      const agent = queries.getAgent.get(agentId);
      if (!agent || agent.status !== 'active') {
        return res.status(404).json({ error: { message: 'Agent not found or inactive' } });
      }

      const result = await proxyRequest(agentId, req.body, 'openai');
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error('Proxy error (openai-compat):', error.message);
      res.status(500).json({ error: { message: 'Proxy error: ' + error.message } });
    }
  });

  // Audio transcription endpoint (Whisper)
  router.post('/:agentId/audio/transcriptions', express.json({ limit: '25mb' }), async (req, res) => {
    try {
      const { agentId } = req.params;
      const { audio, format, duration } = req.body;

      if (!audio) return res.status(400).json({ error: { message: 'Missing audio data' } });

      // Check balance
      const bal = checkBalance(agentId);
      if (!bal.allowed) return res.status(402).json({ error: { message: 'Insufficient balance' } });

      // Use Groq Whisper (free) or fall back to OpenAI
      const GROQ_KEY = process.env.GROQ_API_KEY;
      const OPENAI_KEY = process.env.OPENAI_API_KEY;
      const useGroq = !!GROQ_KEY;
      const apiKey = GROQ_KEY || OPENAI_KEY;
      if (!apiKey) return res.status(500).json({ error: { message: 'Transcription not configured (set GROQ_API_KEY or OPENAI_API_KEY)' } });

      const whisperUrl = useGroq
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions';
      const whisperModel = useGroq ? 'whisper-large-v3-turbo' : 'whisper-1';

      // Decode base64 audio
      const audioBuffer = Buffer.from(audio, 'base64');
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const ext = format || 'ogg';
      const mimeType = ext === 'ogg' ? 'audio/ogg' : `audio/${ext}`;

      // Build multipart body manually
      const partHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
      const partFooter = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${whisperModel}\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([partHeader, audioBuffer, partFooter]);

      const whisperRes = await fetch(whisperUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      const result = await whisperRes.json();

      if (result.text) {
        // Groq Whisper is free; OpenAI costs $0.006/min with 25% markup
        const durationMin = Math.max(1, (duration || 10)) / 60;
        const costCents = useGroq ? 0 : Math.max(1, Math.round(durationMin * 0.75));
        logUsage(agentId, whisperModel, 0, 0, costCents);
      }

      res.json(result);
    } catch (error) {
      console.error('[proxy] Transcription error:', error.message);
      res.status(500).json({ error: { message: 'Transcription failed: ' + error.message } });
    }
  });

  // Image generation endpoint (multi-provider: Cloudflare Workers AI, Together AI, Gemini)
  router.post('/:agentId/generate-image', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { agentId } = req.params;
      const { prompt, width, height } = req.body;

      if (!prompt) return res.status(400).json({ error: { message: 'Missing prompt' } });

      const bal = checkBalance(agentId);
      if (!bal.allowed) return res.status(402).json({ error: { message: 'Insufficient balance' } });

      const w = Math.min(width || 1024, 1440);
      const h = Math.min(height || 1024, 1440);
      console.log(`[proxy] Image gen for ${agentId}: "${prompt.slice(0, 60)}..."`);

      let b64 = null;
      let provider = 'none';

      // Provider 1: Cloudflare Workers AI (free, 10K images/day)
      const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
      const CF_TOKEN = process.env.CF_API_TOKEN;
      if (!b64 && CF_ACCOUNT && CF_TOKEN) {
        try {
          const cfRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt, width: Math.min(w, 1024), height: Math.min(h, 1024) }),
            }
          );
          if (cfRes.ok) {
            const imgBuf = Buffer.from(await cfRes.arrayBuffer());
            b64 = imgBuf.toString('base64');
            provider = 'cloudflare-flux';
            console.log(`[proxy] CF image OK (${Math.round(imgBuf.length / 1024)}KB)`);
          } else {
            const err = await cfRes.text().catch(() => '');
            console.warn(`[proxy] CF failed ${cfRes.status}: ${err.slice(0, 100)}`);
          }
        } catch (e) { console.warn('[proxy] CF error:', e.message); }
      }

      // Provider 2: Together AI (free FLUX model with credits)
      const TOGETHER_KEY = process.env.TOGETHER_API_KEY;
      if (!b64 && TOGETHER_KEY) {
        try {
          const tRes = await fetch('https://api.together.xyz/v1/images/generations', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TOGETHER_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'black-forest-labs/FLUX.1-schnell-Free',
              prompt, width: w, height: h, n: 1, response_format: 'b64_json',
            }),
          });
          const tData = await tRes.json();
          if (tData.data?.[0]?.b64_json) {
            b64 = tData.data[0].b64_json;
            provider = 'together-flux';
          } else if (tData.error) {
            console.warn('[proxy] Together error:', tData.error.message?.slice(0, 100));
          }
        } catch (e) { console.warn('[proxy] Together error:', e.message); }
      }

      // Provider 3: Gemini image generation
      const GEMINI_KEY = process.env.GEMINI_API_KEY;
      if (!b64 && GEMINI_KEY) {
        try {
          const gRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
              }),
            }
          );
          const gData = await gRes.json();
          const parts = gData.candidates?.[0]?.content?.parts || [];
          for (const p of parts) {
            if (p.inlineData?.data) { b64 = p.inlineData.data; provider = 'gemini-flash-image'; break; }
          }
          if (!b64 && gData.error) console.warn('[proxy] Gemini error:', gData.error.message?.slice(0, 100));
        } catch (e) { console.warn('[proxy] Gemini error:', e.message); }
      }

      if (!b64) {
        return res.status(502).json({ error: { message: 'Image generation failed: no provider available. Set CF_ACCOUNT_ID+CF_API_TOKEN, TOGETHER_API_KEY, or GEMINI_API_KEY.' } });
      }

      logUsage(agentId, provider, 0, 0, 0);
      res.json({ image: b64 });
    } catch (error) {
      console.error('[proxy] Image gen error:', error.message);
      res.status(500).json({ error: { message: 'Image generation failed: ' + error.message } });
    }
  });

  // Usage stats endpoint
  router.get('/:agentId/usage', async (req, res) => {
    try {
      const { agentId } = req.params;
      const daily = queries.getDailyUsage.get(agentId);
      const monthly = queries.getMonthlyUsage.get(agentId);
      const bal = checkBalance(agentId);
      res.json({
        daily,
        monthly,
        balance_cents: bal.balanceCents || 0,
      });
    } catch (error) {
      res.status(500).json({ error: { message: 'Failed to get usage' } });
    }
  });

  return router;
}

module.exports = { createProxyRouter, checkBalance, logUsage, detectProvider };
