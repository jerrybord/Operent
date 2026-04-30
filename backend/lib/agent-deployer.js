/**
 * Shared agent deployment runner — used by both the /api/deploy endpoint
 * (server.js) and the managed_bot update handler (bot.js).
 *
 * Cross-process state: progress is persisted to agents.deploy_progress
 * (JSON) so /api/status/:id can read it from any pm2 process.
 *
 * User-facing tracking: a single Telegram message in the @OperentBot chat
 * gets edited on every step instead of spamming new messages. Its
 * message_id is stored in deploy_progress so we can survive restarts.
 */

const { queries } = require('./db');
const { deployAgent } = require('./deployer');
const { sendMessage, editMessageText } = require('./telegram');

// Read lazily — bot.js loads dotenv just-in-time, so capturing
// process.env at module-load would race the env file.
function getBotToken() {
  return process.env.TG_BOT_TOKEN || '8713361004:AAG-X5ogHHbZtqCw7HdCHWa7iA-sBbJk98k';
}

const TOTAL_STEPS = 8;

const STEP_LABELS = {
  1: '🦞 Starting deployment',
  2: '🌐 Connecting to server',
  3: '🐳 Checking Docker',
  4: '📁 Preparing workspace',
  5: '⚙️ Writing configuration',
  6: '🛠️ Installing skills',
  7: '🚀 Launching agent',
  8: '✨ Verifying',
};

function bar(step, total) {
  const filled = Math.max(0, Math.min(total, step));
  return '▰'.repeat(filled) + '▱'.repeat(total - filled);
}

function buildStatusText(name, progress, botUsername) {
  const { step = 0, total = TOTAL_STEPS, message = '', done = false, error = false } = progress;
  if (error) {
    return `❌ <b>${escapeHtml(name)}</b> — deploy failed\n\n<i>${escapeHtml(message || 'unknown error')}</i>`;
  }
  if (done) {
    const link = botUsername ? `\n\nOpen: @${escapeHtml(botUsername)}` : '';
    return `✅ <b>${escapeHtml(name)}</b> is live!${link}`;
  }
  const label = STEP_LABELS[step] || message || 'Working';
  return `🦞 <b>${escapeHtml(name)}</b>\n\n${bar(step, total)}  <code>${step}/${total}</code>\n\n${escapeHtml(label)}`;
}

function setProgress(agentId, progress) {
  try {
    // Preserve the chat/message_id fields if they were set by initStatusMessage
    const existing = getProgress(agentId) || {};
    const merged = { ...existing, ...progress };
    queries.setDeployProgress.run(JSON.stringify(merged), agentId);
    return merged;
  } catch (e) {
    console.error('[deploy] setDeployProgress failed:', e.message);
    return progress;
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

// Send the initial Telegram status message and remember its id so we can edit
// it on every progress step. Falls back gracefully if Telegram refuses.
async function initStatusMessage(agentId, name, tgUserId) {
  const token = getBotToken();
  if (!token || !tgUserId) return;
  const text = buildStatusText(name, { step: 1, total: TOTAL_STEPS }, null);
  try {
    const res = await sendMessage(token, tgUserId, text, {
      reply_markup: JSON.stringify({ remove_keyboard: true }),
    });
    if (res && res.ok && res.result && res.result.message_id) {
      setProgress(agentId, {
        step: 1, total: TOTAL_STEPS, message: STEP_LABELS[1],
        chatId: tgUserId,
        messageId: res.result.message_id,
      });
    }
  } catch (e) {
    console.error('[deploy] initStatusMessage failed:', e.message);
  }
}

// Edit the saved Telegram status message with the latest progress.
async function syncStatusMessage(agentId, name, progress, botUsername) {
  const token = getBotToken();
  const cur = getProgress(agentId) || progress;
  const chatId = cur.chatId;
  const messageId = cur.messageId;
  if (!token || !chatId || !messageId) return;
  const text = buildStatusText(name, progress, botUsername);
  try {
    await editMessageText(token, chatId, messageId, text);
  } catch (e) {
    // Ignore "message not modified" and similar — those are harmless.
  }
}

function startAgentDeployment(agentId, server, name, botToken, config, tgUser, goal, description, skills) {
  setProgress(agentId, { step: 1, total: TOTAL_STEPS, message: STEP_LABELS[1] });

  // Send the initial chat message; subsequent edits target this message.
  initStatusMessage(agentId, name, tgUser.id).catch(() => {});

  let lastSyncedStep = 1;
  const syncIfNewStep = (progress) => {
    if (progress.step !== lastSyncedStep || progress.done || progress.error) {
      lastSyncedStep = progress.step;
      syncStatusMessage(agentId, name, progress, null).catch(() => {});
    }
  };

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
      const shifted = { ...progress, step: progress.step + 1, total: TOTAL_STEPS };
      const merged = setProgress(agentId, shifted);
      syncIfNewStep(merged);
    }
  ).then(async (result) => {
    if (result.success) {
      queries.updateAgentDeploy.run(result.containerId, agentId);
      const final = setProgress(agentId, {
        step: TOTAL_STEPS, total: TOTAL_STEPS, message: 'Agent is live!', done: true,
      });
      console.log(`[deploy] agent=${agentId} live (container=${result.containerId})`);

      const row = queries.getAgent.get(agentId);
      const botUsername = row && row.bot_username ? row.bot_username : null;
      await syncStatusMessage(agentId, name, final, botUsername);
    } else {
      console.error(`[deploy] agent=${agentId} FAILED: ${result.error}`);
      queries.updateAgentStatus.run('error', agentId);
      const final = setProgress(agentId, {
        step: 0, total: TOTAL_STEPS, message: result.error, done: true, error: true,
      });
      await syncStatusMessage(agentId, name, final, null);
    }
  }).catch(async (err) => {
    console.error(`[deploy] agent=${agentId} threw:`, err && err.stack || err);
    queries.updateAgentStatus.run('error', agentId);
    const final = setProgress(agentId, {
      step: 0, total: TOTAL_STEPS, message: err.message, done: true, error: true,
    });
    await syncStatusMessage(agentId, name, final, null);
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { startAgentDeployment, setProgress, getProgress };
