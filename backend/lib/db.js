const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rentyourclaw.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// === Schema ===
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id INTEGER UNIQUE NOT NULL,
    telegram_username TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,                              -- friendly name: "de-01", "us-01"
    ip TEXT UNIQUE NOT NULL,
    ssh_port INTEGER DEFAULT 22,
    ssh_user TEXT DEFAULT 'root',
    ssh_password TEXT,
    max_agents INTEGER DEFAULT 30,           -- capacity limit
    status TEXT DEFAULT 'active',            -- active | maintenance | offline
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,                     -- uuid
    user_id INTEGER NOT NULL REFERENCES users(id),
    server_id INTEGER REFERENCES servers(id),
    name TEXT NOT NULL,
    status TEXT DEFAULT 'pending',           -- pending | deploying | active | stopped | error
    bot_token TEXT NOT NULL,
    container_id TEXT,
    config JSON NOT NULL,
    -- form data
    description TEXT,
    goal TEXT,
    capabilities JSON,
    model TEXT DEFAULT 'sonnet',
    proactivity TEXT DEFAULT 'smart',
    -- timestamps
    created_at TEXT DEFAULT (datetime('now')),
    deployed_at TEXT,
    last_health TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    agent_id TEXT REFERENCES agents(id),
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'USD',
    type TEXT NOT NULL,                      -- deploy | subscription | credit
    tg_payment_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS crypto_payments (
    id TEXT PRIMARY KEY,                     -- UUID (payment_id)
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount_usd REAL NOT NULL,
    network TEXT NOT NULL,                   -- ton | eth | bsc | tron | arbitrum | stars | cryptobot
    token TEXT NOT NULL,                     -- usdt | usdc | xtr
    comment TEXT NOT NULL,                   -- payment:{internal_user_id}:{payment_id}
    status TEXT DEFAULT 'pending',           -- pending | confirmed | expired | failed
    blockchain_tx_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    confirmed_at TEXT
  );

`);

// Migrations — each runs safely inside try/catch
const migrations = [
  'ALTER TABLE users ADD COLUMN balance_cents INTEGER DEFAULT 0',
  // agents table: older DB had vps_ip/vps_port; new schema uses server_id
  'ALTER TABLE agents ADD COLUMN server_id INTEGER REFERENCES servers(id)',
  'CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)',
  'CREATE INDEX IF NOT EXISTS idx_agents_server ON agents(server_id)',
  'CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_log(agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_log(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_cpay_user ON crypto_payments(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_cpay_status ON crypto_payments(status)',
  'CREATE INDEX IF NOT EXISTS idx_cpay_comment ON crypto_payments(comment)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_cpay_tx ON crypto_payments(blockchain_tx_hash) WHERE blockchain_tx_hash IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_cpay_net_status ON crypto_payments(network, status, created_at)',
  'ALTER TABLE crypto_payments ADD COLUMN sender_address TEXT',
  "ALTER TABLE crypto_payments ADD COLUMN payment_type TEXT DEFAULT 'manual'",
  "ALTER TABLE agents ADD COLUMN personalities JSON DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN description TEXT DEFAULT ''",
  "ALTER TABLE agents ADD COLUMN goal TEXT DEFAULT 'personal'",
  "ALTER TABLE agents ADD COLUMN capabilities JSON DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN model TEXT DEFAULT 'sonnet'",
  "ALTER TABLE agents ADD COLUMN proactivity TEXT DEFAULT 'smart'",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column/index already exists */ }
}

// === Queries ===

const queries = {
  // Users
  upsertUser: db.prepare(`
    INSERT INTO users (telegram_id, telegram_username, balance_cents)
    VALUES (?, ?, 500)
    ON CONFLICT(telegram_id) DO UPDATE SET telegram_username = excluded.telegram_username
    RETURNING *
  `),

  getUser: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),

  getUserBalance: db.prepare('SELECT balance_cents FROM users WHERE telegram_id = ?'),

  addUserBalance: db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?'),

  deductUserBalance: db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?'),

  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),

  // Servers
  addServer: db.prepare(`
    INSERT OR IGNORE INTO servers (label, ip, ssh_port, ssh_user, ssh_password, max_agents)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  getAvailableServer: db.prepare(`
    SELECT s.*, COUNT(a.id) as agent_count
    FROM servers s
    LEFT JOIN agents a ON a.server_id = s.id AND a.status IN ('active', 'deploying')
    WHERE s.status = 'active'
    GROUP BY s.id
    HAVING agent_count < s.max_agents
    ORDER BY agent_count ASC
    LIMIT 1
  `),

  getServer: db.prepare('SELECT * FROM servers WHERE id = ?'),
  getAllServers: db.prepare(`
    SELECT s.*, COUNT(a.id) as agent_count
    FROM servers s
    LEFT JOIN agents a ON a.server_id = s.id AND a.status IN ('active', 'deploying')
    GROUP BY s.id
  `),

  // Agents
  createAgent: db.prepare(`
    INSERT INTO agents (id, user_id, name, bot_token, config, description, goal, capabilities, model, proactivity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
  getUserAgents: db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC'),

  updateAgentStatus: db.prepare('UPDATE agents SET status = ? WHERE id = ?'),
  updateAgentServer: db.prepare('UPDATE agents SET server_id = ? WHERE id = ?'),
  updateAgentDeploy: db.prepare(`
    UPDATE agents SET status = 'active', container_id = ?, deployed_at = datetime('now') WHERE id = ?
  `),
  updateAgentHealth: db.prepare(`UPDATE agents SET last_health = datetime('now') WHERE id = ?`),

  getAgentsByServer: db.prepare(`SELECT * FROM agents WHERE server_id = ? AND status IN ('active', 'deploying')`),

  updateAgentSettings: db.prepare(`
    UPDATE agents SET description = ?, goal = ?, capabilities = ?, personalities = ?, model = ?, proactivity = ?
    WHERE id = ?
  `),
  getAgentsByUser: db.prepare(`
    SELECT a.*, s.ip as server_ip FROM agents a
    LEFT JOIN servers s ON s.id = a.server_id
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
  `),

  // Usage
  logUsage: db.prepare(`
    INSERT INTO usage_log (agent_id, model, input_tokens, output_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?)
  `),

  getDailyUsage: db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
           COALESCE(SUM(cost_usd), 0) as total_cost
    FROM usage_log
    WHERE agent_id = ? AND created_at >= datetime('now', '-1 day')
  `),

  getMonthlyUsage: db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
           COALESCE(SUM(cost_usd), 0) as total_cost
    FROM usage_log
    WHERE agent_id = ? AND created_at >= datetime('now', '-30 day')
  `),

  // User-wide usage (aggregated across all agents)
  getUserTotalUsage: db.prepare(`
    SELECT COALESCE(SUM(u.input_tokens), 0) as total_in,
           COALESCE(SUM(u.output_tokens), 0) as total_out,
           COALESCE(SUM(u.cost_usd), 0) as total_cost,
           COUNT(*) as total_requests
    FROM usage_log u
    INNER JOIN agents a ON a.id = u.agent_id
    WHERE a.user_id = ?
  `),

  getUserDailyUsage: db.prepare(`
    SELECT COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as total_tokens,
           COALESCE(SUM(u.cost_usd), 0) as total_cost
    FROM usage_log u
    INNER JOIN agents a ON a.id = u.agent_id
    WHERE a.user_id = ? AND u.created_at >= datetime('now', '-1 day')
  `),

  getUserMonthlyUsage: db.prepare(`
    SELECT COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as total_tokens,
           COALESCE(SUM(u.cost_usd), 0) as total_cost
    FROM usage_log u
    INNER JOIN agents a ON a.id = u.agent_id
    WHERE a.user_id = ? AND u.created_at >= datetime('now', '-30 day')
  `),

  getUserUsageByDay: db.prepare(`
    SELECT date(u.created_at) as day,
           u.model,
           SUM(u.input_tokens) as input_tokens,
           SUM(u.output_tokens) as output_tokens,
           SUM(u.cost_usd) as cost
    FROM usage_log u
    INNER JOIN agents a ON a.id = u.agent_id
    WHERE a.user_id = ? AND u.created_at >= datetime('now', '-30 day')
    GROUP BY date(u.created_at), u.model
    ORDER BY day ASC
  `),

  getUserUsageByModel: db.prepare(`
    SELECT u.model,
           SUM(u.input_tokens) as input_tokens,
           SUM(u.output_tokens) as output_tokens,
           SUM(u.cost_usd) as cost,
           COUNT(*) as requests
    FROM usage_log u
    INNER JOIN agents a ON a.id = u.agent_id
    WHERE a.user_id = ?
    GROUP BY u.model
  `),

  getUserUsageByAgent: db.prepare(`
    SELECT a.id as agent_id, a.name as agent_name, a.model as default_model, a.status,
           COALESCE(SUM(u.input_tokens), 0) as input_tokens,
           COALESCE(SUM(u.output_tokens), 0) as output_tokens,
           COALESCE(SUM(u.cost_usd), 0) as cost,
           COUNT(u.id) as requests
    FROM agents a
    LEFT JOIN usage_log u ON u.agent_id = a.id
    WHERE a.user_id = ?
    GROUP BY a.id
    ORDER BY cost DESC
  `),

  // Legacy payments (deploy fees etc.)
  createPayment: db.prepare(`
    INSERT INTO payments (user_id, agent_id, amount_cents, type, tg_payment_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  // Crypto payments
  createCryptoPayment: db.prepare(`
    INSERT INTO crypto_payments (id, user_id, amount_usd, network, token, comment)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  getCryptoPayment: db.prepare('SELECT * FROM crypto_payments WHERE id = ?'),

  getPendingCryptoPayments: db.prepare(`
    SELECT cp.*, u.telegram_id, u.id as internal_user_id
    FROM crypto_payments cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.status = 'pending'
      AND cp.created_at >= datetime('now', '-48 hours')
  `),

  getPendingByNetwork: db.prepare(`
    SELECT cp.*, u.telegram_id, u.id as internal_user_id
    FROM crypto_payments cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.status = 'pending'
      AND cp.network = ?
      AND cp.created_at >= datetime('now', '-48 hours')
  `),

  confirmCryptoPayment: db.prepare(`
    UPDATE crypto_payments
    SET status = 'confirmed', blockchain_tx_hash = ?, confirmed_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `),

  expireOldPayments: db.prepare(`
    UPDATE crypto_payments SET status = 'expired'
    WHERE status = 'pending' AND created_at < datetime('now', '-48 hours')
  `),

  isTxHashProcessed: db.prepare(
    `SELECT id FROM crypto_payments WHERE blockchain_tx_hash = ? AND status = 'confirmed' LIMIT 1`
  ),

  // WC payments: pending with tx_hash stored but not yet confirmed
  getPendingWcWithTxHash: db.prepare(`
    SELECT id, user_id, amount_usd FROM crypto_payments
    WHERE payment_type = 'walletconnect'
      AND status = 'pending'
      AND blockchain_tx_hash IS NOT NULL
      AND created_at >= datetime('now', '-48 hours')
  `),

  submitWcTxHash: db.prepare(`
    UPDATE crypto_payments
    SET blockchain_tx_hash = ?, sender_address = ?, payment_type = 'walletconnect'
    WHERE id = ? AND status = 'pending' AND blockchain_tx_hash IS NULL
  `),

  getUserCryptoPayments: db.prepare(`
    SELECT id, amount_usd, network, token, status, created_at, confirmed_at
    FROM crypto_payments
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `),

  getUserUsageCharges: db.prepare(`
    SELECT u.model, u.cost_usd, u.input_tokens, u.output_tokens, u.created_at, a.name as agent_name
    FROM usage_log u
    INNER JOIN agents a ON a.id = u.agent_id
    WHERE a.user_id = ?
    ORDER BY u.created_at DESC
    LIMIT 100
  `),
};

module.exports = { db, queries };
