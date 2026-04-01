/**
 * Operent — Backend API Server (Multi-tenant)
 *
 * Endpoints:
 *   POST /api/deploy          — Create & deploy a new agent
 *   GET  /api/status/:id      — Get agent deploy status
 *   GET  /api/health/:id      — Check agent health
 *   GET  /api/agents          — List user's agents
 *   POST /api/agents/:id/stop — Stop an agent
 *   GET  /api/agents/:id/logs — Get agent logs
 *   GET  /api/billing         — Get user balance + payment history
 *   POST /api/payments/create — Create payment intent (crypto)
 *   POST /api/payments/tg-stars  — Create Telegram Stars invoice
 *   POST /api/payments/cryptobot — Create CryptoBot invoice
 *   GET  /api/payments/status/:id — Poll payment status
 *   POST /api/webhook         — Telegram bot webhook (Stars payments)
 *   POST /api/webhook/cryptobot  — CryptoBot payment webhook
 *   POST /v1/:agentId/*       — LLM proxy (for agents)
 *
 * Admin:
 *   POST /admin/server        — Add a server
 *   GET  /admin/servers       — List servers with stats
 *   GET  /admin/agents        — List all agents
 *   POST /admin/export/:tgId  — Export user data
 */

// Load .env — try backend dir, repo root, then /root (CWD-independent)
const _path = require('path');
require('dotenv').config({ path: _path.join(__dirname, '.env') });
require('dotenv').config({ path: _path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: '/root/.env' });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const { db, queries } = require('./lib/db');
const { generateConfig } = require('./lib/config-gen');
const { getSkillList } = require('./lib/skills-registry');
const { deployAgent, stopAgent, checkHealth, getAgentLogs, exportUserData, getServerStats, redeployAgent } = require('./lib/deployer');
const { validateInitData, extractUser, sendMessage } = require('./lib/telegram');
const { createProxyRouter } = require('./lib/llm-proxy');
const { startScanner, triggerImmediateScan } = require('./lib/crypto-scanner');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN || '';
const IS_DEV = process.env.NODE_ENV !== 'production';

// In-memory deploy status tracker
const deployStatus = new Map();

// === Middleware ===
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests' },
});
app.use('/api', apiLimiter);

// === Auth ===
function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];

  if (!initData) {
    if (IS_DEV && req.headers['x-dev-user-id']) {
      req.tgUser = {
        id: parseInt(req.headers['x-dev-user-id']),
        username: 'dev_user',
      };
      return next();
    }
    return res.status(401).json({ error: 'Missing Telegram auth' });
  }

  // If TG_BOT_TOKEN is not configured, skip signature check (extractUser only)
  const user = (IS_DEV || !TG_BOT_TOKEN)
    ? extractUser(initData)
    : validateInitData(initData, TG_BOT_TOKEN);

  if (!user) {
    return res.status(401).json({ error: 'Invalid Telegram auth' });
  }

  req.tgUser = user;
  next();
}

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// === Health ===
app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: IS_DEV ? 'dev' : 'prod' });
});

// === Deploy ===
app.post('/api/deploy', authMiddleware, async (req, res) => {
  try {
    const { name, botToken, description, goal, skills, capabilities, model, proactivity, routing, language } = req.body;

    if (!name || !botToken) {
      return res.status(400).json({ error: 'Name and botToken are required' });
    }
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
      return res.status(400).json({ error: 'Invalid bot token format' });
    }

    // Upsert user
    const user = queries.upsertUser.get(req.tgUser.id, req.tgUser.username || '');

    // Find server with capacity
    const server = queries.getAvailableServer.get();
    if (!server) {
      return res.status(503).json({ error: 'No available servers. Please try again later.' });
    }

    const agentId = crypto.randomUUID();

    // Generate config
    const proxyBaseUrl = process.env.PROXY_BASE_URL || `http://host.docker.internal:${PORT}`;
    // Accept both new 'skills' field and legacy 'capabilities' field
    const agentSkills = skills || capabilities || [];

    const config = generateConfig({
      agentId,
      name,
      botToken,
      telegramUserId: req.tgUser.id,
      description,
      goal,
      skills: agentSkills,
      model: model || 'sonnet',
      proactivity: proactivity || 'smart',
      routing,
      language: language || 'english',
    }, proxyBaseUrl);

    // Create agent in DB
    queries.createAgent.run(
      agentId, user.id, name, botToken,
      JSON.stringify(config),
      description || '', goal || 'personal',
      JSON.stringify(agentSkills),
      model || 'sonnet', proactivity || 'smart'
    );
    queries.updateAgentServer.run(server.id, agentId);
    queries.updateAgentStatus.run('deploying', agentId);

    // Start deployment in background
    deployStatus.set(agentId, { step: 0, total: 7, message: 'Queued...' });

    deployAgent(
      server,
      {
        id: agentId,
        name,
        bot_token: botToken,
        config,
        telegramId: req.tgUser.id,
        telegramUsername: req.tgUser.username || '',
        goal: goal || 'personal',
        description: description || '',
        personalities: [],
      },
      (progress) => deployStatus.set(agentId, progress)
    ).then(async (result) => {
      if (result.success) {
        queries.updateAgentDeploy.run(result.containerId, agentId);
        deployStatus.set(agentId, { step: 7, total: 7, message: 'Agent is live!', done: true });

        if (TG_BOT_TOKEN) {
          await sendMessage(TG_BOT_TOKEN, req.tgUser.id,
            `🦞 <b>${name}</b> is now live!\n\nYour agent is deployed and ready.`
          );
        }
      } else {
        queries.updateAgentStatus.run('error', agentId);
        deployStatus.set(agentId, { step: 0, total: 7, message: result.error, done: true, error: true });
      }
    }).catch((err) => {
      queries.updateAgentStatus.run('error', agentId);
      deployStatus.set(agentId, { step: 0, total: 7, message: err.message, done: true, error: true });
    });

    res.json({ agentId, status: 'deploying' });
  } catch (error) {
    console.error('Deploy error:', error);
    res.status(500).json({ error: 'Deployment failed: ' + error.message });
  }
});

// === Ping / version check ===
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, v: 'debug-1', t: Date.now() });
});

// === Temporary debug endpoint (no auth) ===
app.get('/api/debug', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
    const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get();
    const serverCount = db.prepare("SELECT COUNT(*) as c FROM servers WHERE status = 'active'").get();
    const recentUsage = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(input_tokens+output_tokens),0) as t FROM usage_log').get();
    res.json({
      mode: IS_DEV ? 'dev' : 'prod',
      has_tg_token: !!TG_BOT_TOKEN,
      has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
      has_groq_key: !!process.env.GROQ_API_KEY,
      has_openai_key: !!process.env.OPENAI_API_KEY,
      voice_transcription_ready: !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY),
      total_llm_calls: recentUsage.c,
      total_tokens_used: recentUsage.t,
      cwd: process.cwd(),
      db_path: db.name,
      users: userCount.c,
      agents: agentCount.c,
      servers: serverCount.c,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Skills catalog ===
app.get('/api/skills', (req, res) => {
  res.json(getSkillList());
});

// === Status ===
app.get('/api/status/:id', (req, res) => {
  const progress = deployStatus.get(req.params.id);
  if (!progress) {
    const agent = queries.getAgent.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    return res.json({ step: 7, total: 7, message: agent.status, done: true });
  }
  res.json(progress);
});

// === Agent health ===
app.get('/api/health/:id', authMiddleware, async (req, res) => {
  try {
    const agent = queries.getAgent.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const server = queries.getServer.get(agent.server_id);
    if (!server) return res.json({ alive: false, error: 'No server assigned' });

    const health = await checkHealth(server, agent.id);
    if (health.alive) {
      queries.updateAgentHealth.run(agent.id);
      queries.updateAgentStatus.run('active', agent.id);
    }
    res.json(health);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === User profile (language sync) ===
app.get('/api/me', authMiddleware, (req, res) => {
  const user = queries.getUser.get(req.tgUser.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ language: user.language || null });
});

app.post('/api/me/language', authMiddleware, (req, res) => {
  const { language } = req.body;
  if (language !== 'en' && language !== 'ru') return res.status(400).json({ error: 'invalid language' });
  const user = queries.getUser.get(req.tgUser.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, user.id);
  res.json({ ok: true });
});

// === List agents ===
app.get('/api/agents', authMiddleware, (req, res) => {
  const user = queries.getUser.get(req.tgUser.id);
  if (!user) return res.json([]);
  const agents = queries.getUserAgents.all(user.id);
  const safe = agents.map(({ bot_token, config, ...a }) => a);
  res.json(safe);
});

// === Usage ===
app.get('/api/usage', authMiddleware, (req, res) => {
  const user = queries.getUser.get(req.tgUser.id);
  if (!user) return res.json({ total: { total_in: 0, total_out: 0, total_cost: 0, total_requests: 0 }, daily: { total_tokens: 0 }, monthly: { total_tokens: 0 }, chart: [], models: [] });

  const total = queries.getUserTotalUsage.get(user.id);
  const daily = queries.getUserDailyUsage.get(user.id);
  const monthly = queries.getUserMonthlyUsage.get(user.id);
  const chart = queries.getUserUsageByDay.all(user.id);
  const models = queries.getUserUsageByModel.all(user.id);
  const agentUsage = queries.getUserUsageByAgent.all(user.id);
  const activeAgents = agentUsage.filter(a => a.status === 'active');

  res.json({
    total,
    daily,
    monthly,
    chart,
    models,
    agents: agentUsage,
    balance_cents: user.balance_cents || 0,
    agentCount: activeAgents.length,
  });
});

// === Stop agent ===
app.post('/api/agents/:id/stop', authMiddleware, async (req, res) => {
  try {
    const agent = queries.getAgent.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const server = queries.getServer.get(agent.server_id);
    if (!server) return res.status(404).json({ error: 'No server assigned' });

    const result = await stopAgent(server, agent.id);
    if (result.success) {
      queries.updateAgentStatus.run('stopped', agent.id);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Agent logs ===
app.get('/api/agents/:id/logs', authMiddleware, async (req, res) => {
  try {
    const agent = queries.getAgent.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const server = queries.getServer.get(agent.server_id);
    if (!server) return res.status(404).json({ error: 'No server assigned' });

    const result = await getAgentLogs(server, agent.id, parseInt(req.query.lines) || 50);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Billing — balance + payment history + usage charges ===
app.get('/api/billing', authMiddleware, (req, res) => {
  const user = queries.getUser.get(req.tgUser.id);
  if (!user) return res.json({ balance_cents: 0, payments: [], charges: [] });

  const payments = queries.getUserCryptoPayments.all(user.id);
  const charges = queries.getUserUsageCharges.all(user.id);
  res.json({
    balance_cents: user.balance_cents || 0,
    payments,
    charges,
  });
});

// === Create payment intent (crypto / manual) ===
app.post('/api/payments/create', authMiddleware, (req, res) => {
  const { amount_usd, network, token } = req.body;
  if (!amount_usd || amount_usd <= 0 || amount_usd > 10000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const user = queries.upsertUser.get(req.tgUser.id, req.tgUser.username || '');
  const paymentId = crypto.randomUUID();
  const comment = `payment:${user.id}:${paymentId}`;

  queries.createCryptoPayment.run(paymentId, user.id, amount_usd, network || 'unknown', token || 'unknown', comment);

  // Trigger immediate scan so the backend starts checking right away
  // (even if the user closes the page immediately after sending)
  const net = network || 'unknown';
  if (['ton', 'eth', 'bsc', 'tron', 'arbitrum'].includes(net)) {
    triggerImmediateScan(net).catch(() => {});
  }

  res.json({ payment_id: paymentId, comment, user_id: user.id });
});

// === Telegram Stars invoice ===
app.post('/api/payments/tg-stars', authMiddleware, async (req, res) => {
  const { amount_usd } = req.body;
  if (!amount_usd || amount_usd <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (!TG_BOT_TOKEN) {
    return res.status(503).json({ error: 'Bot not configured' });
  }

  const user = queries.upsertUser.get(req.tgUser.id, req.tgUser.username || '');
  const paymentId = crypto.randomUUID();
  const stars = Math.max(1, Math.round(amount_usd / 0.015));

  queries.createCryptoPayment.run(
    paymentId, user.id, amount_usd, 'stars', 'xtr',
    `payment:${user.id}:${paymentId}`
  );

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Operent Credits',
        description: `Top up $${parseFloat(amount_usd).toFixed(2)} to your balance`,
        payload: paymentId,
        provider_token: '',  // Must be empty for Telegram Stars (XTR)
        currency: 'XTR',
        prices: [{ label: 'Credits', amount: stars }],
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.description || 'Telegram API error');

    res.json({ invoice_url: data.result, payment_id: paymentId, stars });
  } catch (e) {
    console.error('TG Stars error:', e.message);
    // Clean up failed payment
    db.prepare("UPDATE crypto_payments SET status = 'failed' WHERE id = ?").run(paymentId);
    res.status(500).json({ error: e.message });
  }
});

// === CryptoBot invoice ===
app.post('/api/payments/cryptobot', authMiddleware, async (req, res) => {
  const { amount_usd } = req.body;
  if (!amount_usd || amount_usd <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (!CRYPTOBOT_TOKEN) {
    return res.status(503).json({ error: 'CryptoBot not configured' });
  }

  const user = queries.upsertUser.get(req.tgUser.id, req.tgUser.username || '');
  const paymentId = crypto.randomUUID();
  // Add 3% commission
  const chargeAmount = (Math.round(amount_usd * 1.03 * 100) / 100).toFixed(2);

  queries.createCryptoPayment.run(
    paymentId, user.id, amount_usd, 'cryptobot', 'usdt',
    `payment:${user.id}:${paymentId}`
  );

  try {
    const resp = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN,
      },
      body: JSON.stringify({
        asset: 'USDT',
        amount: chargeAmount,
        description: `Operent Credits — $${parseFloat(amount_usd).toFixed(2)}`,
        payload: paymentId,
        paid_btn_name: 'callback',
        paid_btn_url: 'https://operent.vercel.app',
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(JSON.stringify(data.error) || 'CryptoBot API error');

    const payUrl = data.result.bot_invoice_url || data.result.pay_url || data.result.mini_app_invoice_url;
    res.json({ pay_url: payUrl, payment_id: paymentId });
  } catch (e) {
    console.error('CryptoBot error:', e.message);
    db.prepare("UPDATE crypto_payments SET status = 'failed' WHERE id = ?").run(paymentId);
    res.status(500).json({ error: e.message });
  }
});

// === Payment status poll ===
app.get('/api/payments/status/:id', authMiddleware, (req, res) => {
  const payment = queries.getCryptoPayment.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  // Verify belongs to this user
  const user = queries.getUser.get(req.tgUser.id);
  if (!user || payment.user_id !== user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({
    id: payment.id,
    status: payment.status,
    amount_usd: payment.amount_usd,
    network: payment.network,
    confirmed_at: payment.confirmed_at,
  });
});

// === Submit WalletConnect tx hash for fast verification ===
app.post('/api/payments/submit-tx', authMiddleware, (req, res) => {
  const { payment_id, tx_hash, sender_address } = req.body;
  if (!payment_id || !tx_hash) {
    return res.status(400).json({ error: 'Missing payment_id or tx_hash' });
  }

  const user = queries.getUser.get(req.tgUser.id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const payment = queries.getCryptoPayment.get(payment_id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
  if (payment.status !== 'pending') return res.status(409).json({ error: 'Payment not pending' });

  // Store tx hash and sender address
  const result = queries.submitWcTxHash.run(tx_hash, sender_address || null, payment_id);
  if (result.changes === 0) {
    return res.status(409).json({ error: 'Already has tx hash' });
  }

  // Trigger immediate scan for this network
  const net = payment.network;
  if (['ton', 'eth', 'bsc', 'tron', 'arbitrum'].includes(net)) {
    triggerImmediateScan(net).catch(() => {});
  }

  res.json({ ok: true, status: 'pending_confirmation' });
});

// === WalletConnect — create backend session ===
app.post('/api/payments/wc-session', authMiddleware, async (req, res) => {
  const { network } = req.body;
  if (!network) return res.status(400).json({ error: 'network required' });
  try {
    const { createSession } = require('./lib/wc-manager');
    const result = await createSession(network);
    res.json({ session_id: result.sessionId, uri: result.uri });
  } catch(e) {
    console.error('[WC] createSession error:', e.message);
    res.status(500).json({ error: e.message || 'Failed to create WC session' });
  }
});

// === WalletConnect — poll session status ===
app.get('/api/payments/wc-session/:id', authMiddleware, (req, res) => {
  try {
    const { getSession } = require('./lib/wc-manager');
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
      status: session.status,
      accounts: session.accounts,
      chain_id: session.chainId,
      error: session.error || null,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// === WalletConnect — send ERC-20 transaction ===
app.post('/api/payments/wc-tx', authMiddleware, async (req, res) => {
  const { session_id, amount_usd, payment_id } = req.body;
  if (!session_id || !amount_usd) return res.status(400).json({ error: 'session_id and amount_usd required' });
  try {
    const { sendTransaction } = require('./lib/wc-manager');
    const result = await sendTransaction(session_id, amount_usd);
    // Store tx hash in payment record so blockchain scanner can confirm it
    if (payment_id) {
      try {
        queries.submitWcTxHash.run(result.txHash, result.fromAddr, payment_id);
        console.log(`[WC] tx hash stored for payment ${payment_id}: ${result.txHash}`);
      } catch(dbErr) {
        console.warn('[WC] Failed to store tx hash in db:', dbErr.message);
      }
    }
    res.json({ ok: true, tx_hash: result.txHash, from_addr: result.fromAddr });
  } catch(e) {
    console.error('[WC] sendTransaction error:', e.message);
    res.status(500).json({ error: e.message || 'Transaction failed' });
  }
});

// === CryptoBot webhook ===
app.post('/api/webhook/cryptobot', (req, res) => {
  // CryptoBot sends the API token in the crypto-pay-api-token header for verification
  const headerToken = req.headers['crypto-pay-api-token'];
  if (CRYPTOBOT_TOKEN && headerToken !== CRYPTOBOT_TOKEN) {
    console.warn('[CryptoBot] Webhook rejected: invalid token header');
    return res.status(401).json({ error: 'Invalid token' });
  }

  const update = req.body;
  if (update.update_type === 'invoice_paid') {
    const invoice = update.payload;
    const paymentId = invoice.payload;

    if (paymentId) {
      const payment = queries.getCryptoPayment.get(paymentId);
      if (payment && payment.status === 'pending') {
        const txHash = invoice.hash || String(invoice.invoice_id);
        const changed = queries.confirmCryptoPayment.run(txHash, paymentId);
        if (changed.changes > 0) {
          const creditCents = Math.round(payment.amount_usd * 100);
          queries.addUserBalance.run(creditCents, payment.user_id);
          console.log(`CryptoBot: credited $${payment.amount_usd} to user ${payment.user_id}`);
        }
      }
    }
  }

  res.json({ ok: true });
});

// === Telegram bot webhook (Stars + pre-checkout) ===
app.post('/api/webhook', async (req, res) => {
  const update = req.body;

  if (update.pre_checkout_query) {
    // Must answer within 10 seconds — respond to webhook immediately, then answer
    res.json({ ok: true });
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
      });
      const rd = await r.json();
      if (!rd.ok) console.error('[Stars] answerPreCheckoutQuery failed:', rd.description);
      else console.log('[Stars] pre_checkout_query answered OK:', update.pre_checkout_query.id);
    } catch (e) {
      console.error('[Stars] answerPreCheckoutQuery error:', e.message);
    }
    return;
  }

  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const telegramUserId = update.message.from.id;
    const paymentId = payment.invoice_payload;

    console.log(`Stars payment from ${telegramUserId}: ${payment.total_amount} XTR, payload=${paymentId}`);

    const user = queries.getUser.get(telegramUserId);
    if (user) {
      // Legacy log
      queries.createPayment.run(user.id, null, payment.total_amount, 'credit', payment.telegram_payment_charge_id, 'completed');

      // Find and confirm the crypto_payment
      if (paymentId) {
        const cryptoPay = queries.getCryptoPayment.get(paymentId);
        if (cryptoPay && cryptoPay.status === 'pending' && cryptoPay.user_id === user.id) {
          const changed = queries.confirmCryptoPayment.run(payment.telegram_payment_charge_id, paymentId);
          if (changed.changes > 0) {
            const creditCents = Math.round(cryptoPay.amount_usd * 100);
            queries.addUserBalance.run(creditCents, user.id);
            console.log(`Stars: credited $${cryptoPay.amount_usd} to user ${user.id}`);
          }
        }
      }
    }
  }

  res.json({ ok: true });
});

// === Agent settings ===
app.get('/api/agents/:id/settings', authMiddleware, (req, res) => {
  const agent = queries.getAgent.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const user = queries.getUser.get(req.tgUser.id);
  if (!user || agent.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    id: agent.id,
    name: agent.name,
    description: agent.description || '',
    goal: agent.goal || 'personal',
    model: agent.model || 'sonnet',
    proactivity: agent.proactivity || 'smart',
    capabilities: JSON.parse(agent.capabilities || '[]'),
    personalities: JSON.parse(agent.personalities || '[]'),
    status: agent.status,
  });
});

app.put('/api/agents/:id/settings', authMiddleware, (req, res) => {
  const agent = queries.getAgent.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const user = queries.getUser.get(req.tgUser.id);
  if (!user || agent.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

  const { description, goal, capabilities, personalities, model, proactivity } = req.body;
  queries.updateAgentSettings.run(
    description ?? (agent.description || ''),
    goal ?? (agent.goal || 'personal'),
    JSON.stringify(capabilities ?? JSON.parse(agent.capabilities || '[]')),
    JSON.stringify(personalities ?? JSON.parse(agent.personalities || '[]')),
    model ?? (agent.model || 'sonnet'),
    proactivity ?? (agent.proactivity || 'smart'),
    agent.id
  );
  res.json({ ok: true });
});

app.post('/api/agents/:id/redeploy', authMiddleware, async (req, res) => {
  const agent = queries.getAgent.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const user = queries.getUser.get(req.tgUser.id);
  if (!user || agent.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

  if (agent.status === 'deploying') {
    return res.status(409).json({ error: 'Agent is already being updated' });
  }

  let server = queries.getServer.get(agent.server_id);
  if (!server) {
    // Old agent without server_id — assign to available server
    server = queries.getAvailableServer.get();
    if (!server) return res.status(400).json({ error: 'No server available for redeploy' });
    db.prepare('UPDATE agents SET server_id = ? WHERE id = ?').run(server.id, agent.id);
  }

  const personalities = JSON.parse(agent.personalities || '[]');
  const capabilities = JSON.parse(agent.capabilities || '[]');

  const newConfig = generateConfig({
    agentId: agent.id,
    name: agent.name,
    botToken: agent.bot_token,
    telegramUserId: user.telegram_id,
    description: agent.description,
    goal: agent.goal,
    skills: capabilities,
    model: agent.model,
    proactivity: agent.proactivity,
  }, process.env.PROXY_BASE_URL || `http://host.docker.internal:${process.env.PORT || 3000}`);

  const agentData = {
    id: agent.id,
    name: agent.name,
    bot_token: agent.bot_token,
    config: newConfig,
    telegramId: user.telegram_id,
    telegramUsername: user.telegram_username || '',
    goal: agent.goal || 'personal',
    description: agent.description || '',
    personalities,
    capabilities,
  };

  queries.updateAgentStatus.run('deploying', agent.id);
  deployStatus.set(agent.id, { step: 0, total: 5, message: 'Starting update...', done: false });

  redeployAgent(server, agentData, (progress) => {
    deployStatus.set(agent.id, progress);
  }).then((result) => {
    if (result.success) {
      queries.updateAgentStatus.run('active', agent.id);
    } else {
      queries.updateAgentStatus.run('active', agent.id); // restore even on error
      deployStatus.set(agent.id, { step: 0, total: 5, message: result.error, done: true, error: true });
    }
  }).catch((err) => {
    queries.updateAgentStatus.run('active', agent.id);
    deployStatus.set(agent.id, { step: 0, total: 5, message: err.message, done: true, error: true });
  });

  res.json({ ok: true, redeployId: agent.id });
});

// === LLM Proxy ===
app.use('/v1', createProxyRouter(express));

// === Admin routes ===

// Add server
app.post('/admin/server', adminAuth, (req, res) => {
  const { label, ip, port, user, password, maxAgents } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  queries.addServer.run(label || ip, ip, port || 22, user || 'root', password || '', maxAgents || 30);
  res.json({ ok: true });
});

// List servers with load
app.get('/admin/servers', adminAuth, async (req, res) => {
  const servers = queries.getAllServers.all();
  if (req.query.live === 'true') {
    for (const s of servers) {
      const stats = await getServerStats(s);
      Object.assign(s, stats);
    }
  }
  res.json(servers);
});

// List all agents
app.get('/admin/agents', adminAuth, (req, res) => {
  const all = db.prepare(`
    SELECT a.id, a.name, a.status, a.model, a.server_id, s.ip as server_ip,
           a.created_at, a.deployed_at, a.last_health
    FROM agents a LEFT JOIN servers s ON s.id = a.server_id
    ORDER BY a.created_at DESC
  `).all();
  res.json(all);
});

// Export user data
app.post('/admin/export/:telegramId', adminAuth, async (req, res) => {
  try {
    const telegramId = req.params.telegramId;
    const servers = queries.getAllServers.all();

    const results = [];
    for (const server of servers) {
      const result = await exportUserData(server, telegramId);
      if (result.success) results.push({ server: server.ip, path: result.path });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'No data found for this user' });
    }
    res.json({ exports: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Serve frontend (public/) ===
const PUBLIC_DIR = path.join(__dirname, '../public');
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// === Start ===
app.listen(PORT, HOST, () => {
  console.log(`\n  🤖 Operent Backend (Multi-tenant)`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  API:    http://${HOST}:${PORT}`);
  console.log(`  Proxy:  http://${HOST}:${PORT}/v1/{agentId}/messages`);
  console.log(`  Mode:   ${IS_DEV ? 'development' : 'production'}\n`);

  // Start blockchain scanner
  startScanner();
});
