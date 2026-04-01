/**
 * Multi-tenant agent deployer
 *
 * Directory layout on each server:
 *   /srv/rentyourclaw/users/u_{telegramId}/
 *     agents/
 *       {agentId}/
 *         config/openclaw.json
 *         memory/
 *         workspace/
 *         data/
 *         skills/
 *         .env
 */

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'rentyourclaw/agent:latest';
const BASE_DIR = '/srv/rentyourclaw';

// SSH key for key-based auth
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(process.env.HOME || '/root', '.ssh', 'id_ed25519');
let SSH_PRIVATE_KEY = null;
try { SSH_PRIVATE_KEY = fs.readFileSync(SSH_KEY_PATH); } catch { /* password fallback */ }

// === Workspace templates ===

const TEMPLATES_DIR = path.join(__dirname, '../templates/agent-workspace');

function loadTemplate(filename) {
  try {
    return fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf-8');
  } catch {
    return null;
  }
}

function loadSoulForGoal(goal) {
  // Try goal-specific SOUL first, fall back to base SOUL.md
  return loadTemplate(`goals/${goal}.md`) || loadTemplate('SOUL.md');
}

const SKILL_NAMES = {
  'voice-messages':    '🎙 Voice Messages — Transcribe voice messages to text',
  'global-search':     '🔍 Global Search — Search across 17 search engines',
  'google-workspace':  '📧 Google Workspace — Gmail, Calendar, Drive, Sheets',
  'summarize':         '🧾 Summarize — Summarize URLs, files, and YouTube videos',
  'self-improving':    '🧠 Self-Improving — Learn from corrections and improve over time',
  'youtube':           '📺 YouTube — Extract and analyze video transcripts',
  'x-search':          '𝕏 X / Twitter — Search and analyze posts',
  'trello':            '📋 Trello — Manage boards, lists, and cards',
  'notion':            '📝 Notion — Work with pages and databases',
  'slack':             '💬 Slack — Send messages, reactions, manage channels',
  'github':            '🐙 GitHub — Manage issues, PRs, and CI pipelines',
  'nano-banana':       '🎨 Nano Banana — Generate and edit images with AI',
  'nano-pdf':          '📄 Nano PDF — Edit PDFs using natural language',
  'clawhub':           '🔧 ClawHub — Install and manage additional skills',
};

const GOAL_LABELS = {
  'business':   'Business Automation',
  'social':     'Social Media Management',
  'development':'Development Assistant',
  'research':   'Research & Analysis',
  'personal':   'Personal Assistant',
};

function generateUserMd(agent) {
  const goalLabel = GOAL_LABELS[agent.goal] || agent.goal || 'General Assistant';
  const userName = agent.telegramUsername ? `@${agent.telegramUsername}` : `User #${agent.telegramId}`;
  const description = agent.description || 'No additional context provided.';

  return `# USER.md — About Your User

- **Name:** ${userName}
- **Language:** Russian
- **Goal:** ${goalLabel}
- **Timezone:** UTC+3

## Context

${description}

## Preferences

Use defaults from SOUL.md. Update this file as you learn more about the user.
`;
}

function generateToolsMd(enabledSkills = []) {
  let content = '# TOOLS.md — Your Active Skills\n\n';

  if (enabledSkills.length === 0) {
    content += 'No skills enabled. The user can add skills by redeploying the agent.\n';
    return content;
  }

  content += '## Enabled Skills\n\n';
  for (const skillId of enabledSkills) {
    const desc = SKILL_NAMES[skillId] || `✅ ${skillId}`;
    content += `🔹 ${desc}\n`;
  }
  content += '\n## Notes\n\nAdd skill-specific API keys and configurations here as needed.\n';
  return content;
}

// === SSH helpers ===

function sshExec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Exit ${code}: ${stderr || stdout}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  });
}

function sshGetSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

function sftpWriteFile(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    stream.on('close', () => resolve());
    stream.on('error', (e) => reject(e));
    stream.write(content);
    stream.end();
  });
}

function sshConnect(server) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(err));

    const opts = {
      host: server.ip,
      port: server.ssh_port || 22,
      username: server.ssh_user || 'root',
      readyTimeout: 15000,
    };

    if (SSH_PRIVATE_KEY) opts.privateKey = SSH_PRIVATE_KEY;
    if (server.ssh_password) opts.password = server.ssh_password;

    conn.connect(opts);
  });
}

// === Agent paths ===

function userDir(telegramId) {
  return `${BASE_DIR}/users/u_${telegramId}`;
}

function agentDir(telegramId, agentId) {
  return `${userDir(telegramId)}/agents/${agentId}`;
}

function containerName(agentId) {
  return `claw-${agentId.slice(0, 12)}`;
}

// === Deploy ===

/**
 * Deploy an agent on a shared server (multi-tenant)
 * @param {Object} server - { ip, ssh_port, ssh_user, ssh_password }
 * @param {Object} agent  - { id, name, bot_token, config, telegramId }
 * @param {Function} onProgress
 */
async function deployAgent(server, agent, onProgress = () => {}) {
  const TOTAL = 7;
  let conn;

  try {
    // Step 1: Connect
    onProgress({ step: 1, total: TOTAL, message: 'Connecting to server...' });
    conn = await sshConnect(server);

    // Step 2: Ensure Docker + network
    onProgress({ step: 2, total: TOTAL, message: 'Checking Docker...' });
    try {
      await sshExec(conn, 'docker --version');
    } catch {
      onProgress({ step: 2, total: TOTAL, message: 'Installing Docker...' });
      await sshExec(conn, 'curl -fsSL https://get.docker.com | sh');
      await sshExec(conn, 'systemctl enable docker && systemctl start docker');
    }
    // Ensure agent network exists
    await sshExec(conn, 'docker network inspect agent-net >/dev/null 2>&1 || docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false --subnet 172.30.0.0/16 agent-net');

    // Step 3: Create user/agent directory structure
    onProgress({ step: 3, total: TOTAL, message: 'Preparing workspace...' });
    const dir = agentDir(agent.telegramId, agent.id);
    await sshExec(conn, `mkdir -p ${dir}/config ${dir}/memory ${dir}/workspace ${dir}/data ${dir}/skills`);
    // Lock permissions: only this agent's UID can access
    await sshExec(conn, `chmod 700 ${dir}`);

    // Step 4: Write config + env
    onProgress({ step: 4, total: TOTAL, message: 'Writing configuration...' });
    // Open a single SFTP session for all file writes (avoids MaxSessions exhaustion)
    const sftp = await sshGetSftp(conn);

    await sftpWriteFile(sftp, `${dir}/config/openclaw.json`, JSON.stringify(agent.config, null, 2));

    const envContent = [
      `TELEGRAM_BOT_TOKEN=${agent.bot_token}`,
      `AGENT_ID=${agent.id}`,
      `AGENT_NAME=${agent.name}`,
      `AGENT_DESCRIPTION=${(agent.description || '').replace(/\n/g, ' ')}`,
    ].join('\n');
    await sftpWriteFile(sftp, `${dir}/.env`, envContent);
    await sshExec(conn, `chmod 600 ${dir}/.env`);

    // Step 5: Install skills
    const enabledSkills = agent.config?.skills?.enabled || [];
    const skillInstructions = agent.config?.skills?.instructions || {};
    if (enabledSkills.length > 0) {
      onProgress({ step: 5, total: TOTAL, message: `Installing ${enabledSkills.length} skill(s)...` });
      for (const skillId of enabledSkills) {
        const content = skillInstructions[skillId];
        if (content) {
          await sshExec(conn, `mkdir -p ${dir}/skills/${skillId}`);
          await sftpWriteFile(sftp, `${dir}/skills/${skillId}/SKILL.md`, content);
        }
      }
    } else {
      onProgress({ step: 5, total: TOTAL, message: 'No skills to install' });
    }

    // Step 5b: Write workspace templates
    const soulMd = loadSoulForGoal(agent.goal || 'personal');
    const agentsMd = loadTemplate('AGENTS.md');
    const userMd = generateUserMd(agent);
    const toolsMd = generateToolsMd(enabledSkills);

    const formatMd = loadTemplate('TELEGRAM_FORMAT.md');

    if (soulMd)   await sftpWriteFile(sftp, `${dir}/workspace/SOUL.md`, soulMd);
    if (agentsMd) await sftpWriteFile(sftp, `${dir}/workspace/AGENTS.md`, agentsMd);
    if (formatMd) await sftpWriteFile(sftp, `${dir}/workspace/TELEGRAM_FORMAT.md`, formatMd);
    await sftpWriteFile(sftp, `${dir}/workspace/USER.md`, userMd);
    await sftpWriteFile(sftp, `${dir}/workspace/TOOLS.md`, toolsMd);

    // Close SFTP session
    sftp.end();

    // Step 6: Run container
    onProgress({ step: 6, total: TOTAL, message: 'Deploying agent...' });

    const cName = containerName(agent.id);
    await sshExec(conn, `docker rm -f ${cName} 2>/dev/null || true`);

    // Ensure image exists
    try {
      await sshExec(conn, `docker image inspect ${OPENCLAW_IMAGE} >/dev/null 2>&1 || docker pull ${OPENCLAW_IMAGE}`);
    } catch {
      throw new Error(`Docker image not found: ${OPENCLAW_IMAGE}`);
    }

    const runCmd = [
      'docker run -d',
      `--name ${cName}`,
      '--restart unless-stopped',
      `--network agent-net`,
      '--add-host=host.docker.internal:host-gateway',
      `--env-file ${dir}/.env`,
      `-v ${dir}/config:/root/.openclaw:ro`,
      `-v ${dir}/memory:/root/memory`,
      `-v ${dir}/workspace:/root/workspace`,
      `-v ${dir}/data:/root/data`,
      `-v ${dir}/skills:/root/skills:ro`,
      '--memory=512m',
      '--cpus=0.5',
      '--pids-limit=100',
      '--read-only',
      '--tmpfs /tmp:rw,noexec,nosuid,size=64m',
      OPENCLAW_IMAGE,
    ].join(' ');

    const containerId = await sshExec(conn, runCmd);

    // Step 7: Health check
    onProgress({ step: 7, total: TOTAL, message: 'Verifying...' });
    await new Promise(r => setTimeout(r, 4000));

    const status = await sshExec(conn, `docker inspect -f '{{.State.Status}}' ${cName}`);
    if (status !== 'running') {
      const logs = await sshExec(conn, `docker logs --tail 30 ${cName} 2>&1`);
      throw new Error(`Container not running (${status}). Logs: ${logs}`);
    }

    onProgress({ step: 7, total: TOTAL, message: 'Agent is live!' });

    return {
      success: true,
      containerId: containerId.slice(0, 12),
      containerName: cName,
    };

  } catch (error) {
    onProgress({ step: 0, total: TOTAL, message: `Error: ${error.message}` });
    return { success: false, error: error.message };
  } finally {
    if (conn) conn.end();
  }
}

// === Stop ===

async function stopAgent(server, agentId) {
  const conn = await sshConnect(server);
  try {
    await sshExec(conn, `docker stop ${containerName(agentId)}`);
    await sshExec(conn, `docker rm ${containerName(agentId)} 2>/dev/null || true`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    conn.end();
  }
}

// === Health ===

async function checkHealth(server, agentId) {
  const conn = await sshConnect(server);
  try {
    const cName = containerName(agentId);
    const status = await sshExec(conn, `docker inspect -f '{{.State.Status}}' ${cName}`);
    const uptime = await sshExec(conn, `docker inspect -f '{{.State.StartedAt}}' ${cName}`);
    return { alive: status === 'running', status, uptime };
  } catch (error) {
    return { alive: false, error: error.message };
  } finally {
    conn.end();
  }
}

// === Logs ===

async function getAgentLogs(server, agentId, lines = 50) {
  const conn = await sshConnect(server);
  try {
    const logs = await sshExec(conn, `docker logs --tail ${lines} ${containerName(agentId)} 2>&1`);
    return { success: true, logs };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    conn.end();
  }
}

// === Export user data ===

async function exportUserData(server, telegramId) {
  const conn = await sshConnect(server);
  try {
    const uDir = userDir(telegramId);
    const exportPath = `/tmp/export_u_${telegramId}.tar.gz`;
    await sshExec(conn, `tar -czf ${exportPath} -C ${uDir} .`);
    return { success: true, path: exportPath };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    conn.end();
  }
}

// === Server stats ===

async function getServerStats(server) {
  const conn = await sshConnect(server);
  try {
    const containers = await sshExec(conn, 'docker ps --filter "name=claw-" --format "{{.Names}}" | wc -l');
    const memory = await sshExec(conn, "free -m | awk '/Mem:/ {printf \"%d/%d\", $3, $2}'");
    const disk = await sshExec(conn, "df -h /srv | awk 'NR==2 {printf \"%s/%s\", $3, $2}'");
    const cpu = await sshExec(conn, "nproc");
    return {
      success: true,
      activeContainers: parseInt(containers) || 0,
      memory,
      disk,
      cpuCores: parseInt(cpu) || 1,
    };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    conn.end();
  }
}

// === Soul Merging ===

const PERSONALITY_META = {
  research:    { name: 'Research & Analytics', expertise: 'deep research, data analysis, market insights, academic literature' },
  development: { name: 'Development Assistant', expertise: 'code writing, debugging, technical architecture, software engineering' },
  social:      { name: 'Social Media Manager', expertise: 'content creation, audience engagement, platform strategy, copywriting' },
  personal:    { name: 'Personal Assistant', expertise: 'task planning, reminders, travel, daily productivity' },
  business:    { name: 'Business Automation', expertise: 'workflows, reporting, CRM, operations, business strategy' },
};

function mergeSouls(primaryGoal, personalities = []) {
  // Load primary SOUL
  const baseSoul = loadSoulForGoal(primaryGoal);
  if (!personalities || personalities.length === 0) return baseSoul;

  // Collect additional personality templates
  const extras = personalities
    .map(p => {
      const tpl = loadTemplate(`goals/${p.key}.md`);
      return { ...p, template: tpl, meta: PERSONALITY_META[p.key] };
    })
    .filter(p => p.template);

  if (extras.length === 0) return baseSoul;

  const primaryMeta = PERSONALITY_META[primaryGoal] || { name: primaryGoal, expertise: primaryGoal };
  const allExpertise = [primaryMeta, ...extras.map(p => p.meta)].filter(Boolean);

  // Build multi-expertise preamble
  let preamble = `# MULTI-EXPERT AGENT\n\n`;
  preamble += `## Your Expertise Areas\n\n`;
  allExpertise.forEach(m => {
    preamble += `- **${m.name}**: ${m.expertise}\n`;
  });

  preamble += `\n## Context Switching\n\n`;
  preamble += `You automatically select the most relevant expertise for each request:\n`;
  extras.forEach(p => {
    const m = p.meta;
    if (m) preamble += `- For questions about ${m.expertise.split(',')[0]}: use **${m.name}** mode\n`;
  });
  preamble += `- When multiple areas overlap: combine them seamlessly\n`;
  preamble += `- Your memory is **unified** across all roles — you remember all past conversations regardless of which mode you're in\n\n`;

  // Add special instructions per personality
  extras.forEach(p => {
    if (p.instructions && p.instructions.trim()) {
      preamble += `### Special Instructions for ${p.meta?.name || p.key}\n${p.instructions.trim()}\n\n`;
    }
  });

  preamble += `---\n\n## Primary Identity\n\n`;

  // Extract key expertise sections from extra templates (first 60 lines)
  let extraSections = '';
  extras.forEach(p => {
    if (!p.template) return;
    const lines = p.template.split('\n').slice(0, 60).join('\n');
    extraSections += `\n---\n## Additional Expertise: ${p.meta?.name || p.key}\n\n${lines}\n`;
  });

  return preamble + baseSoul + extraSections;
}

function generateUserMdFull(agent) {
  const goalLabel = GOAL_LABELS[agent.goal] || agent.goal || 'General Assistant';
  const userName = agent.telegramUsername ? `@${agent.telegramUsername}` : `User #${agent.telegramId}`;
  const description = agent.description || 'No additional context provided.';
  const personalities = agent.personalities || [];

  let content = `# USER.md — About Your User\n\n`;
  content += `- **Name:** ${userName}\n`;
  content += `- **Language:** Russian\n`;
  content += `- **Goal:** ${goalLabel}\n`;
  content += `- **Timezone:** UTC+3\n\n`;
  content += `## Context\n\n${description}\n\n`;

  if (personalities.length > 0) {
    content += `## Additional Personalities\n\n`;
    personalities.forEach(p => {
      const meta = PERSONALITY_META[p.key];
      content += `- **${meta?.name || p.key}**`;
      if (p.instructions) content += ` — ${p.instructions}`;
      content += '\n';
    });
    content += '\n';
  }

  content += `## Preferences\n\nUse defaults from SOUL.md. Update this file as you learn more about the user.\n`;
  return content;
}

// === Redeploy ===

async function redeployAgent(server, agent, onProgress = () => {}) {
  const TOTAL = 5;
  let conn;
  try {
    onProgress({ step: 1, total: TOTAL, message: 'Connecting to server...' });
    conn = await sshConnect(server);

    const dir = agentDir(agent.telegramId, agent.id);
    const sftp = await sshGetSftp(conn);

    onProgress({ step: 2, total: TOTAL, message: 'Updating workspace files...' });

    // SOUL.md — merge personalities
    const personalities = agent.personalities || [];
    const soulMd = mergeSouls(agent.goal || 'personal', personalities);
    if (soulMd) await sftpWriteFile(sftp, `${dir}/workspace/SOUL.md`, soulMd);

    // USER.md — updated description + personalities
    const userMd = generateUserMdFull(agent);
    await sftpWriteFile(sftp, `${dir}/workspace/USER.md`, userMd);

    // TOOLS.md — updated skills
    const enabledSkills = agent.capabilities || [];
    const toolsMd = generateToolsMd(enabledSkills);
    await sftpWriteFile(sftp, `${dir}/workspace/TOOLS.md`, toolsMd);

    // Update config/openclaw.json
    if (agent.config) {
      await sftpWriteFile(sftp, `${dir}/config/openclaw.json`, JSON.stringify(agent.config, null, 2));
    }

    // Update skill instructions
    const skillInstructions = agent.config?.skills?.instructions || {};
    for (const skillId of enabledSkills) {
      const content = skillInstructions[skillId];
      if (content) {
        await sshExec(conn, `mkdir -p ${dir}/skills/${skillId}`);
        await sftpWriteFile(sftp, `${dir}/skills/${skillId}/SKILL.md`, content);
      }
    }

    sftp.end();

    onProgress({ step: 3, total: TOTAL, message: 'Restarting agent...' });
    const cName = containerName(agent.id);

    // Recreate container so new flags (--add-host) take effect.
    // If old container doesn't exist, docker rm just prints a warning — harmless.
    await sshExec(conn, `docker rm -f ${cName} 2>/dev/null || true`);
    const rerunCmd = [
      'docker run -d',
      `--name ${cName}`,
      '--restart unless-stopped',
      '--network agent-net',
      '--add-host=host.docker.internal:host-gateway',
      `--env-file ${dir}/.env`,
      `-v ${dir}/config:/root/.openclaw:ro`,
      `-v ${dir}/memory:/root/memory`,
      `-v ${dir}/workspace:/root/workspace`,
      `-v ${dir}/data:/root/data`,
      `-v ${dir}/skills:/root/skills:ro`,
      '--memory=512m',
      '--cpus=0.5',
      '--pids-limit=100',
      '--read-only',
      '--tmpfs /tmp:rw,noexec,nosuid,size=64m',
      OPENCLAW_IMAGE,
    ].join(' ');
    await sshExec(conn, rerunCmd);

    onProgress({ step: 4, total: TOTAL, message: 'Waiting for agent to start...' });
    await new Promise(r => setTimeout(r, 5000));

    onProgress({ step: 5, total: TOTAL, message: 'Verifying...' });
    const status = await sshExec(conn, `docker inspect -f '{{.State.Status}}' ${cName}`);
    if (status !== 'running') {
      const logs = await sshExec(conn, `docker logs --tail 20 ${cName} 2>&1`);
      throw new Error(`Container not running after restart (${status}). Logs: ${logs}`);
    }

    onProgress({ step: 5, total: TOTAL, message: 'Agent updated successfully!', done: true });
    return { success: true };

  } catch (error) {
    onProgress({ step: 0, total: TOTAL, message: `Error: ${error.message}`, done: true, error: true });
    return { success: false, error: error.message };
  } finally {
    if (conn) conn.end();
  }
}

module.exports = {
  deployAgent,
  stopAgent,
  checkHealth,
  getAgentLogs,
  exportUserData,
  getServerStats,
  redeployAgent,
};
