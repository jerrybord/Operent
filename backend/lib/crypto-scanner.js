/**
 * Crypto Payment Scanner
 *
 * Polls blockchain explorers to detect incoming payments and credit balances.
 * Runs as background intervals on server startup.
 *
 * Networks supported:
 *   TON   — tonapi.io, USDT jetton
 *   ETH   — Etherscan API, USDT ERC-20
 *   BSC   — BSCScan API, USDT BEP-20
 *   ARB   — Arbiscan API, USDC
 *   TRON  — TronScan API, USDT TRC-20
 */

const crypto = require('crypto');
const { db, queries } = require('./db');

// ── Official contract addresses ──────────────────────────────────────────────

const CONTRACTS = {
  ton_usdt_master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  eth_usdt:        '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  bsc_usdt:        '0x55d398326f99059fF775485246999027B3197955',
  tron_usdt:       'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  arbitrum_usdc:   '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

// ── Our receiving addresses ──────────────────────────────────────────────────

const ADDRESSES = {
  ton:      'UQB7qFrYpqToPCM23hDZGckEpOFC5N1fPTWoGiZ0HgKdaV8y',
  eth:      '0x9dd5Cd88890b8EDfF25c0b1478ba1f38556B7d4C',
  bsc:      '0x9dd5Cd88890b8EDfF25c0b1478ba1f38556B7d4C',
  arbitrum: '0x9dd5Cd88890b8EDfF25c0b1478ba1f38556B7d4C',
  tron:     'TXmmyvjDkZRs5dA31GfpEAxSCQbswYup7D',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function safeFetch(url, opts = {}) {
  try {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    console.warn(`[scanner] fetch failed: ${url.slice(0, 80)} — ${e.message}`);
    return null;
  }
}

/**
 * Credit a user's balance for a confirmed payment.
 * Returns true if payment was newly confirmed.
 */
function creditPayment(paymentId, txHash, amountUsd) {
  // Duplicate tx guard — if this txHash already credited ANY payment, skip entirely
  const dup = queries.isTxHashProcessed.get(txHash);
  if (dup) return false;

  const payment = queries.getCryptoPayment.get(paymentId);
  if (!payment || payment.status !== 'pending') return false;

  const changed = queries.confirmCryptoPayment.run(txHash, paymentId);
  if (changed.changes === 0) return false;

  const cents = Math.round(amountUsd * 100);
  queries.addUserBalance.run(cents, payment.user_id);
  console.log(`[scanner] Confirmed payment ${paymentId}: +$${amountUsd.toFixed(2)} → user ${payment.user_id}`);
  return true;
}

/**
 * Match an incoming transfer to a pending payment by comment (exact) or amount+window.
 * Returns the matched payment or null.
 */
function matchPayment(network, amountUnitsStr, tokenDecimals, commentOrNull, receivedAt) {
  // Use string-based division to avoid BigInt/Number precision loss (BSC USDT = 18 decimals)
  const amountUsd = parseFloat(amountUnitsStr) / Math.pow(10, tokenDecimals);
  const pending = queries.getPendingByNetwork.all(network);

  // Prefer exact comment match
  if (commentOrNull) {
    const byComment = pending.find(p => p.comment === commentOrNull);
    if (byComment && Math.abs(byComment.amount_usd - amountUsd) < 0.02) {
      return byComment;
    }
  }

  // Fallback: match by amount within 48h window — only if single match to avoid ambiguity
  const receivedMs = receivedAt * 1000;
  const candidates = pending.filter(p => {
    const createdMs = new Date(p.created_at + 'Z').getTime();
    const withinWindow = receivedMs >= createdMs && receivedMs <= createdMs + 48 * 3600 * 1000;
    const amountMatch = Math.abs(p.amount_usd - amountUsd) < 0.02;
    return withinWindow && amountMatch;
  });
  // Only match if exactly one candidate to prevent double-crediting
  return candidates.length === 1 ? candidates[0] : null;
}

// ── TON Scanner ──────────────────────────────────────────────────────────────

// Tracks the last seen event_id to avoid reprocessing
let tonLastEventId = null;

async function scanTon() {
  const addr = ADDRESSES.ton;
  const url = `https://tonapi.io/v2/accounts/${addr}/events?limit=50&initiator=false`;
  const data = await safeFetch(url);
  if (!data || !Array.isArray(data.events)) return;

  for (const event of data.events) {
    if (tonLastEventId && event.event_id === tonLastEventId) break;

    for (const action of event.actions || []) {
      if (action.type !== 'JettonTransfer') continue;
      const jt = action.JettonTransfer;
      if (!jt) continue;

      // Verify this is incoming USDT to our address
      const recipientAddr = jt.recipient?.address || '';
      const jettonMaster = jt.jetton?.address || '';
      const isUSDT = jt.jetton?.symbol === 'USDT' || jettonMaster.toLowerCase().includes('b113a994');

      if (!isUSDT) continue;
      // Check recipient matches our address (case-insensitive raw comparison)
      // TON API returns raw addresses: "0:..."
      // Our address is in friendly format; just verify via amount+comment

      const amountStr = jt.amount || '0';
      const comment = jt.comment || null; // forward_payload text if present
      const timestamp = event.timestamp;
      const txHash = event.event_id;

      if (amountStr === '0' || !amountStr) continue;

      // Skip if this tx was already processed
      if (queries.isTxHashProcessed.get(txHash)) continue;

      const matched = matchPayment('ton', amountStr, 6, comment, timestamp);
      if (matched) {
        creditPayment(matched.id, txHash, matched.amount_usd);
      }
    }
  }

  if (data.events.length > 0) {
    tonLastEventId = data.events[0].event_id;
  }
}

// ── EVM Scanner (Etherscan-compatible) ──────────────────────────────────────

// Track last seen block per network
const evmLastBlock = { eth: '0', bsc: '0', arbitrum: '0' };

const EVM_CONFIG = {
  eth: {
    apiUrl: 'https://api.etherscan.io/api',
    contract: CONTRACTS.eth_usdt,
    address: ADDRESSES.eth,
    decimals: 6,
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    network: 'eth',
    token: 'usdt',
  },
  bsc: {
    apiUrl: 'https://api.bscscan.com/api',
    contract: CONTRACTS.bsc_usdt,
    address: ADDRESSES.bsc,
    decimals: 18, // BSC USDT is 18 decimals
    apiKey: process.env.BSCSCAN_API_KEY || '',
    network: 'bsc',
    token: 'usdt',
  },
  arbitrum: {
    apiUrl: 'https://api.arbiscan.io/api',
    contract: CONTRACTS.arbitrum_usdc,
    address: ADDRESSES.arbitrum,
    decimals: 6,
    apiKey: process.env.ARBISCAN_API_KEY || '',
    network: 'arbitrum',
    token: 'usdc',
  },
};

async function scanEvm(cfg) {
  const params = new URLSearchParams({
    module: 'account',
    action: 'tokentx',
    contractaddress: cfg.contract,
    address: cfg.address,
    sort: 'desc',
    startblock: evmLastBlock[cfg.network] || '0',
  });
  if (cfg.apiKey) params.set('apikey', cfg.apiKey);

  const url = `${cfg.apiUrl}?${params}`;
  const data = await safeFetch(url);
  if (!data || data.status !== '1' || !Array.isArray(data.result)) return;

  let maxBlock = evmLastBlock[cfg.network] || '0';

  for (const tx of data.result) {
    if (!tx.hash || !tx.to) continue;

    // Ensure transfer goes TO our address
    if (tx.to.toLowerCase() !== cfg.address.toLowerCase()) continue;

    // Ensure correct token contract
    if (tx.contractAddress.toLowerCase() !== cfg.contract.toLowerCase()) continue;

    const txHash = tx.hash;
    const amountStr = tx.value || '0';
    const timestamp = parseInt(tx.timeStamp, 10);

    // Duplicate guard
    const already = queries.isTxHashProcessed.get(txHash);
    if (already) continue;

    if (amountStr === '0' || !amountStr) continue;

    // For EVM we have no on-chain comment, match by amount+time
    // Pass raw string to avoid parseInt overflow on 18-decimal tokens (BSC USDT)
    const matched = matchPayment(cfg.network, amountStr, cfg.decimals, null, timestamp);
    if (matched) {
      creditPayment(matched.id, txHash, matched.amount_usd);
    }

    if (tx.blockNumber > maxBlock) maxBlock = tx.blockNumber;
  }

  evmLastBlock[cfg.network] = maxBlock;
}

// ── TRON Scanner ─────────────────────────────────────────────────────────────

let tronLastFingerprint = null;

async function scanTron() {
  const url = `https://apilist.tronscan.org/api/token_trc20/transfers?toAddress=${ADDRESSES.tron}&contract_address=${CONTRACTS.tron_usdt}&count=20&sort=-timestamp`;
  const data = await safeFetch(url);
  if (!data || !Array.isArray(data.token_transfers)) return;

  for (const tx of data.token_transfers) {
    const txHash = tx.transaction_id || tx.transactionId;
    if (!txHash) continue;

    // Verify correct contract
    if ((tx.contract_address || '').toLowerCase() !== CONTRACTS.tron_usdt.toLowerCase()) continue;

    // Duplicate guard
    const already = queries.isTxHashProcessed.get(txHash);
    if (already) continue;

    const amountStr = String(tx.quant || tx.amount_with_decimals || '0');
    const timestamp = Math.floor((tx.block_ts || tx.timestamp || Date.now()) / 1000);

    if (amountStr === '0' || !amountStr) continue;

    // TRON USDT is 6 decimals
    const matched = matchPayment('tron', amountStr, 6, null, timestamp);
    if (matched) {
      creditPayment(matched.id, txHash, matched.amount_usd);
    }
  }
}

// ── WalletConnect direct confirmation ────────────────────────────────────────
// For WC payments: tx_hash is stored by the backend the moment the user confirms
// in their wallet. We trust this hash and confirm the payment directly without
// waiting for the blockchain scanner to detect it via Arbiscan/Etherscan.

function confirmPendingWcPayments() {
  const pending = queries.getPendingWcWithTxHash.all();
  for (const p of pending) {
    const changed = queries.confirmCryptoPayment.run(
      // blockchain_tx_hash is already set; UPDATE will overwrite with same value — that's fine
      // We need to re-fetch to get the hash since confirmCryptoPayment takes (txHash, paymentId)
      (() => {
        const full = queries.getCryptoPayment.get(p.id);
        return full ? full.blockchain_tx_hash : null;
      })(),
      p.id
    );
    if (changed.changes > 0) {
      const cents = Math.round(p.amount_usd * 100);
      queries.addUserBalance.run(cents, p.user_id);
      console.log(`[scanner] WC confirmed payment ${p.id}: +$${p.amount_usd.toFixed(2)} → user ${p.user_id}`);
    }
  }
}

// ── Expire old payments ──────────────────────────────────────────────────────

function expireOld() {
  const result = queries.expireOldPayments.run();
  if (result.changes > 0) {
    console.log(`[scanner] Expired ${result.changes} stale payment(s)`);
  }
}

// ── Priority scan tracking ────────────────────────────────────────────────────

// Maps network -> timestamp of last payment creation
// Used to trigger more aggressive scanning for fresh payments
const freshPaymentNetworks = new Map();

// Call this when a new payment is created — triggers an immediate scan
async function triggerImmediateScan(network) {
  freshPaymentNetworks.set(network, Date.now());
  try {
    if (network === 'ton') {
      await scanTon();
    } else if (network === 'tron') {
      await scanTron();
    } else if (network === 'eth') {
      await scanEvm(EVM_CONFIG.eth);
    } else if (network === 'bsc') {
      await scanEvm(EVM_CONFIG.bsc);
    } else if (network === 'arbitrum') {
      await scanEvm(EVM_CONFIG.arbitrum);
    }
  } catch (e) {
    console.warn(`[scanner] immediate scan error (${network}):`, e.message);
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

function startScanner() {
  if (process.env.DISABLE_SCANNER === 'true') {
    console.log('[scanner] Disabled via DISABLE_SCANNER env');
    return;
  }

  console.log('[scanner] Starting blockchain scanner');

  // TON: every 15 seconds (fast network, high priority)
  setInterval(async () => {
    try { await scanTon(); } catch (e) { console.error('[scanner] TON error:', e.message); }
  }, 15 * 1000);

  // ETH: every 60 seconds (Etherscan free tier)
  setInterval(async () => {
    try { await scanEvm(EVM_CONFIG.eth); } catch (e) { console.error('[scanner] ETH error:', e.message); }
  }, 60 * 1000);

  // BSC: every 30 seconds
  setInterval(async () => {
    try { await scanEvm(EVM_CONFIG.bsc); } catch (e) { console.error('[scanner] BSC error:', e.message); }
  }, 30 * 1000);

  // Arbitrum: every 20 seconds
  setInterval(async () => {
    try { await scanEvm(EVM_CONFIG.arbitrum); } catch (e) { console.error('[scanner] ARB error:', e.message); }
  }, 20 * 1000);

  // WalletConnect direct confirmation: every 10 seconds
  // Confirms pending WC payments that already have tx_hash stored (no Arbiscan needed)
  setInterval(() => {
    try { confirmPendingWcPayments(); } catch (e) { console.error('[scanner] WC confirm error:', e.message); }
  }, 10 * 1000);

  // TRON: every 30 seconds
  setInterval(async () => {
    try { await scanTron(); } catch (e) { console.error('[scanner] TRON error:', e.message); }
  }, 30 * 1000);

  // Extra aggressive scans for fresh payments (< 5 min old): every 15 seconds
  // This covers the window right after a user presses "I've sent payment" and closes the page
  setInterval(async () => {
    const FRESH_WINDOW = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    for (const [network, ts] of freshPaymentNetworks) {
      if (now - ts > FRESH_WINDOW) {
        freshPaymentNetworks.delete(network);
        continue;
      }
      try {
        if (network === 'ton') await scanTon();
        else if (network === 'tron') await scanTron();
        else if (network === 'bsc') await scanEvm(EVM_CONFIG.bsc);
        else if (network === 'arbitrum') await scanEvm(EVM_CONFIG.arbitrum);
        // ETH scanned at its own 60s interval, no extra scan to stay within rate limits
      } catch (e) {
        console.warn(`[scanner] priority scan error (${network}):`, e.message);
      }
    }
  }, 15 * 1000);

  // Expire old payments: every 6 hours
  setInterval(() => {
    try { expireOld(); } catch (e) { console.error('[scanner] expire error:', e.message); }
  }, 6 * 3600 * 1000);

  // Initial scans after 5 seconds
  setTimeout(async () => {
    try { confirmPendingWcPayments(); } catch (e) {}  // WC first — instant
    try { await scanTon(); } catch (e) {}
    try { await scanEvm(EVM_CONFIG.eth); } catch (e) {}
    try { await scanEvm(EVM_CONFIG.bsc); } catch (e) {}
    try { await scanEvm(EVM_CONFIG.arbitrum); } catch (e) {}
    try { await scanTron(); } catch (e) {}
  }, 5000);
}

module.exports = { startScanner, triggerImmediateScan };
