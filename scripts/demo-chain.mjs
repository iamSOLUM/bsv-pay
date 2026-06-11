#!/usr/bin/env node
/**
 * Standalone local mock chain for interactive demos (the M10 checkpoint —
 * public testnet faucets are dead). Same WhatsOnChain-compatible surface the
 * e2e harness uses, kept alive until Ctrl+C, plus a faucet:
 *
 *   node scripts/demo-chain.mjs [port]          # default 8799
 *
 *   GET /faucet/<address>/<sats>                # credit at 0-conf -> {txid}
 *   GET /faucet/<address>/<sats>?confirmed=1    # credit as confirmed
 *
 * Point bsv-pay at it with BSV_PAY_API_URL=http://127.0.0.1:8799 and a
 * throwaway BSV_PAY_HOME, and use --testnet everywhere (the mock only
 * serves /test/... routes — mainnet stays untouchable, per CLAUDE.md).
 * State is in-memory and dies with the process; the ledger in your demo
 * BSV_PAY_HOME persists, so reuse the same home across restarts or wipe it.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { Transaction, Utils } from '@bsv/sdk';

const PORT = Number(process.argv[2] ?? 8799);
const TESTNET_P2PKH_PREFIX = 0x6f;

/** address -> [{tx_hash, tx_pos, value, height}] */
const utxosByAddress = new Map();

function addrOfP2pkhScript(hex) {
  // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  const m = /^76a914([0-9a-f]{40})88ac$/.exec(hex);
  if (!m) return null;
  const bytes = m[1].match(/../g).map((b) => parseInt(b, 16));
  return Utils.toBase58Check(bytes, [TESTNET_P2PKH_PREFIX]);
}

function isTestnetAddress(address) {
  try {
    const { prefix } = Utils.fromBase58Check(address);
    return prefix[0] === TESTNET_P2PKH_PREFIX;
  } catch {
    return false;
  }
}

function credit(address, satoshis, height) {
  const txid = crypto.randomBytes(32).toString('hex');
  const list = utxosByAddress.get(address) ?? [];
  list.push({ tx_hash: txid, tx_pos: 0, value: satoshis, height });
  utxosByAddress.set(address, list);
  return txid;
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://localhost');
  let m;

  if ((m = /^\/faucet\/([^/]+)\/(\d+)$/.exec(url.pathname))) {
    const [, address, satsRaw] = m;
    const sats = Number(satsRaw);
    if (!isTestnetAddress(address)) {
      return send(400, { error: `faucet: "${address}" is not a valid testnet address` });
    }
    if (!Number.isSafeInteger(sats) || sats <= 0) {
      return send(400, { error: 'faucet: sats must be a positive integer' });
    }
    const confirmed = url.searchParams.get('confirmed') === '1';
    const txid = credit(address, sats, confirmed ? 800_000 : 0);
    console.error(`faucet: ${sats} sats -> ${address} (${confirmed ? 'confirmed' : '0-conf'})`);
    return send(200, { ok: true, txid, address, sats, confirmed });
  }
  if ((m = /^\/test\/address\/([^/]+)\/unspent$/.exec(url.pathname))) {
    return send(200, utxosByAddress.get(m[1]) ?? []);
  }
  if ((m = /^\/test\/address\/([^/]+)\/balance$/.exec(url.pathname))) {
    const rows = utxosByAddress.get(m[1]) ?? [];
    return send(200, {
      confirmed: rows.filter((u) => u.height > 0).reduce((s, u) => s + u.value, 0),
      unconfirmed: rows.filter((u) => u.height === 0).reduce((s, u) => s + u.value, 0),
    });
  }
  if (/^\/test\/address\/[^/]+\/history$/.test(url.pathname)) return send(200, []);
  if (url.pathname === '/test/tx/raw' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let tx;
      try {
        tx = Transaction.fromHex(JSON.parse(body).txhex);
      } catch {
        return send(400, { error: 'broadcast: unparseable transaction' });
      }
      const txid = tx.id('hex');
      // spend the inputs
      for (const input of tx.inputs) {
        for (const [addr, rows] of utxosByAddress) {
          utxosByAddress.set(
            addr,
            rows.filter(
              (u) => !(u.tx_hash === input.sourceTXID && u.tx_pos === input.sourceOutputIndex),
            ),
          );
        }
      }
      // credit the outputs (mempool, height 0)
      tx.outputs.forEach((out, i) => {
        const addr = addrOfP2pkhScript(out.lockingScript.toHex());
        if (!addr) return;
        const list = utxosByAddress.get(addr) ?? [];
        list.push({ tx_hash: txid, tx_pos: i, value: out.satoshis, height: 0 });
        utxosByAddress.set(addr, list);
      });
      console.error(
        `broadcast: ${txid.slice(0, 12)}… (${tx.outputs.map((o) => o.satoshis).join(' + ')} sats out)`,
      );
      send(200, JSON.stringify(txid));
    });
    return;
  }
  send(404, { error: `mock: no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`bsv-pay demo chain on http://127.0.0.1:${PORT} (testnet routes only)`);
  console.error(`  faucet:  GET /faucet/<address>/<sats>   e.g. /faucet/mxyz.../50000`);
  console.error(`  wire up: BSV_PAY_API_URL=http://127.0.0.1:${PORT}  (+ --testnet)`);
  console.error('  Ctrl+C stops it; chain state is in-memory only.');
});
