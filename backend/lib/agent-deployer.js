/**
 * Shared agent deployment runner — used by both the /api/deploy endpoint
 * (server.js) and the managed_bot update handler (bot.js).
 *
 * Lives in its own module so bot.js can require it without side-effects
 * (i.e. without booting server.js's express app.listen).
 */

const { queries } = require('./db');
const { deployAgent } = require('./deployer');
const { sendMessage } = require('./telegram');

// In-process deploy progress map. server.js mutates this from the request
// path; the /api/status/:id endpoint reads it.
const deployStatus = new Map();

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

function startAgentDeployment(agentId, server, name, botToken, config, tgUser, goal, description, skills) {
  deployStatus.set(agentId, { step: 1, total: 8, message: 'Starting deployment...' });

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
      deployStatus.set(agentId, { ...progress, step: progress.step + 1, total: 8 });
    }
  ).then(async (result) => {
    if (result.success) {
      queries.updateAgentDeploy.run(result.containerId, agentId);
      deployStatus.set(agentId, { step: 8, total: 8, message: 'Agent is live!', done: true });

      if (TG_BOT_TOKEN) {
        try {
          await sendMessage(TG_BOT_TOKEN, tgUser.id,
            `🦞 <b>${name}</b> is now live!\n\nYour agent is deployed and ready.`
          );
        } catch (e) { /* notification best-effort */ }
      }
    } else {
      queries.updateAgentStatus.run('error', agentId);
      deployStatus.set(agentId, { step: 0, total: 8, message: result.error, done: true, error: true });
    }
  }).catch((err) => {
    queries.updateAgentStatus.run('error', agentId);
    deployStatus.set(agentId, { step: 0, total: 8, message: err.message, done: true, error: true });
  });
}

module.exports = { startAgentDeployment, deployStatus };
