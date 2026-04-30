/**
 * Shared agent deployment runner — used by both the /api/deploy endpoint
 * (server.js) and the managed_bot update handler (bot.js).
 *
 * Progress is persisted to agents.deploy_progress (JSON) so it can be read
 * from a different pm2 process. The /api/status/:id endpoint reads from
 * the same column, which keeps cross-process tracking simple.
 */

const { queries } = require('./db');
const { deployAgent } = require('./deployer');
const { sendMessage } = require('./telegram');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

function setProgress(agentId, progress) {
  try {
    queries.setDeployProgress.run(JSON.stringify(progress), agentId);
  } catch (e) {
    console.error('[deploy] setDeployProgress failed:', e.message);
  }
}

function getProgress(agentId) {
  const row = queries.getDeployProgress.get(agentId);
  if (!row) return null;
  if (row.deploy_progress) {
    try { return JSON.parse(row.deploy_progress); } catch { /* fall through */ }
  }
  return null;
}

// Send a non-blocking Telegram notification — keeps the user informed even
// if the Mini App is closed. Wraps sendMessage to swallow any error.
function notifyUser(tgUserId, text) {
  if (!TG_BOT_TOKEN || !tgUserId) return;
  sendMessage(TG_BOT_TOKEN, tgUserId, text).catch(() => {});
}

function startAgentDeployment(agentId, server, name, botToken, config, tgUser, goal, description, skills) {
  setProgress(agentId, { step: 1, total: 8, message: 'Starting deployment...' });
  notifyUser(tgUser.id, `🦞 <b>${name}</b> — starting deployment...`);

  // Throttle Telegram notifications: send one per real progress phase, not per ms
  let lastNotifiedStep = 0;

  deployAgent(
    server,
    {
      id: agentId,
      name,
      bot_token: botToken,
      config,
      telegramId: tgUser.id,
      telegramUsername: tgUser.username || '',
      goal: goal || 'personal',
      description: description || '',
      personalities: [],
    },
    (progress) => {
      // deployer.js emits 7 steps; we shift by 1 because step 1 was "creating bot"
      const shifted = { ...progress, step: progress.step + 1, total: 8 };
      setProgress(agentId, shifted);

      // Notify on each new step boundary (step 2, 3, …, 7)
      if (shifted.step > lastNotifiedStep && !shifted.done) {
        lastNotifiedStep = shifted.step;
        notifyUser(tgUser.id, `⚙️ <b>${name}</b> · ${shifted.step}/8 — ${escapeHtml(shifted.message || '')}`);
      }
    }
  ).then(async (result) => {
    if (result.success) {
      queries.updateAgentDeploy.run(result.containerId, agentId);
      setProgress(agentId, { step: 8, total: 8, message: 'Agent is live!', done: true });
      console.log(`[deploy] agent=${agentId} live (container=${result.containerId})`);

      // Resolve the managed bot's username for a clickable link
      const row = queries.getAgent.get(agentId);
      const botUsername = row && row.bot_username ? row.bot_username : null;
      const link = botUsername ? `\n\nOpen: @${botUsername}` : '';
      notifyUser(tgUser.id, `✅ <b>${name}</b> is live!${link}`);
    } else {
      console.error(`[deploy] agent=${agentId} FAILED: ${result.error}`);
      queries.updateAgentStatus.run('error', agentId);
      setProgress(agentId, { step: 0, total: 8, message: result.error, done: true, error: true });
      notifyUser(tgUser.id, `❌ <b>${name}</b> deploy failed: ${escapeHtml(result.error || '')}`);
    }
  }).catch((err) => {
    console.error(`[deploy] agent=${agentId} threw:`, err && err.stack || err);
    queries.updateAgentStatus.run('error', agentId);
    setProgress(agentId, { step: 0, total: 8, message: err.message, done: true, error: true });
    notifyUser(tgUser.id, `❌ <b>${name}</b> deploy crashed: ${escapeHtml(err.message || 'unknown')}`);
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { startAgentDeployment, setProgress, getProgress };
