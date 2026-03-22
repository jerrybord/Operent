/**
 * WalletConnect Session Manager (Server-side)
 *
 * Uses @walletconnect/sign-client on the backend so the relay WebSocket
 * runs on the VPS instead of inside Telegram's WebView.
 * Frontend just calls our REST endpoints and polls for status.
 */

const crypto = require('crypto');

// Chain configs matching frontend
const CHAIN_CONFIG = {
  eth:      { chainId: 1,     name: 'Ethereum',  contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6  },
  bsc:      { chainId: 56,    name: 'BNB Chain', contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  arbitrum: { chainId: 42161, name: 'Arbitrum',  contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6  },
};

const DEST_ADDR = '0x9dd5Cd88890b8EDfF25c0b1478ba1f38556B7d4C';
const WC_PROJECT_ID = process.env.WC_PROJECT_ID || 'a043247a4960e87434ecacc08540c9e9';
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

// In-memory store: sessionId -> session object
const sessions = new Map();

// Lazy-init SignClient singleton
let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { SignClient } = require('@walletconnect/sign-client');
      const client = await SignClient.init({
        projectId: WC_PROJECT_ID,
        metadata: {
          name: 'RentYourClaw',
          description: 'Deploy AI agents in Telegram',
          url: 'https://rentyourclaw.vercel.app',
          icons: ['https://rentyourclaw.vercel.app/icon.svg'],
        },
      });

      client.on('session_delete', ({ topic }) => {
        for (const [id, s] of sessions) {
          if (s.topic === topic && s.status === 'connected') {
            s.status = 'disconnected';
            console.log(`[WC] Session ${id} deleted by wallet`);
          }
        }
      });

      console.log('[WC] SignClient initialized');
      return client;
    })().catch(err => {
      clientPromise = null; // allow retry on next call
      throw err;
    });
  }
  return clientPromise;
}

// ── ERC-20 encoding ──────────────────────────────────────────────────────────

function encodeTokenAmount(amountUsd, decimals) {
  // Use integer arithmetic to avoid floating-point precision issues.
  // amountUsd is in dollars (e.g. 25.00). We convert to token units.
  // For decimals=6: 25.00 USD → 25_000_000 units
  // For decimals=18: 25.00 USD → 25_000_000_000_000_000_000 units
  const centsDec = 2;
  const cents = BigInt(Math.round(amountUsd * 10 ** centsDec));
  const factor = BigInt(10) ** BigInt(decimals - centsDec);
  return '0x' + (cents * factor).toString(16);
}

function encodeERC20Transfer(toAddr, amountHex) {
  // transfer(address,uint256) selector = 0xa9059cbb
  const addr = toAddr.toLowerCase().replace('0x', '').padStart(64, '0');
  const amt  = amountHex.replace('0x', '').padStart(64, '0');
  return '0xa9059cbb' + addr + amt;
}

// ── Public API ───────────────────────────────────────────────────────────────

async function createSession(network) {
  const cfg = CHAIN_CONFIG[network];
  if (!cfg) throw new Error('Unsupported network: ' + network);

  const client = await getClient();

  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      eip155: {
        methods: ['eth_sendTransaction', 'wallet_switchEthereumChain'],
        chains: [`eip155:${cfg.chainId}`],
        events: ['chainChanged', 'accountsChanged'],
      },
    },
  });

  const sessionId = crypto.randomUUID();
  const session = {
    uri,
    status: 'pending',    // pending | connected | failed | expired | disconnected
    topic: null,
    accounts: [],
    chainId: null,
    network,
    cfg,
    error: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);

  // Resolve when wallet approves (or reject on timeout/error)
  approval()
    .then(wcsession => {
      const s = sessions.get(sessionId);
      if (!s) return;
      // accounts are like "eip155:1:0xABCD..."
      const accts = (wcsession.namespaces?.eip155?.accounts || [])
        .map(a => a.split(':')[2])
        .filter(Boolean);
      const chainId = parseInt(
        (wcsession.namespaces?.eip155?.accounts?.[0] || '').split(':')[1] || cfg.chainId
      );
      s.status   = 'connected';
      s.topic    = wcsession.topic;
      s.accounts = accts;
      s.chainId  = chainId;
      console.log(`[WC] Session ${sessionId} connected addr=${accts[0]} chain=${chainId}`);
    })
    .catch(err => {
      const s = sessions.get(sessionId);
      if (s && s.status === 'pending') {
        s.status = 'failed';
        s.error  = err.message || String(err);
        console.error(`[WC] Session ${sessionId} approval failed:`, s.error);
      }
    });

  // Auto-expire pending sessions
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && s.status === 'pending') {
      s.status = 'expired';
      console.log(`[WC] Session ${sessionId} expired`);
    }
  }, SESSION_TTL_MS);

  return { sessionId, uri };
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

async function sendTransaction(sessionId, amountUsd) {
  const s = sessions.get(sessionId);
  if (!s)                       throw new Error('Session not found');
  if (s.status !== 'connected') throw new Error('Wallet not connected (status: ' + s.status + ')');
  if (!s.accounts[0])           throw new Error('No account in session');

  const client = await getClient();
  const amountHex = encodeTokenAmount(amountUsd, s.cfg.decimals);
  const data = encodeERC20Transfer(DEST_ADDR, amountHex);

  const txHash = await client.request({
    topic:   s.topic,
    chainId: `eip155:${s.chainId}`,
    request: {
      method: 'eth_sendTransaction',
      params: [{
        from:  s.accounts[0],
        to:    s.cfg.contract,
        data,
        value: '0x0',
      }],
    },
  });

  console.log(`[WC] Session ${sessionId} tx sent: ${txHash}`);
  return { txHash, fromAddr: s.accounts[0] };
}

// Periodic cleanup of old sessions (run every 30 min)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}, 30 * 60 * 1000);

module.exports = { createSession, getSession, sendTransaction, CHAIN_CONFIG };
