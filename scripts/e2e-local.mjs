#!/usr/bin/env node
/**
 * Local end-to-end test of the PRD loop with the REAL CLI binary:
 *   init -> request -> (payment lands) -> watch detects -> send back -> balance reconciles
 *
 * Public BSV testnet faucets are essentially dead (one survivor, captcha-gated),
 * so this drives dist/cli.js over real HTTP against a local WhatsOnChain-
 * compatible mock instead. No live network, no coins needed, CI-safe.
 * scripts/e2e-testnet.mjs remains for when real testnet coins are available.
 *
 * Usage: npm run build && node scripts/e2e-local.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Transaction, Utils } from '@bsv/sdk';

const CLI = path.resolve(import.meta.dirname, '../dist/cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-e2e-local-'));
const TESTNET_P2PKH_PREFIX = 0x6f;

let failed = false;
function check(cond, label) {
  if (cond) {
    console.error(`  ok: ${label}`);
  } else {
    failed = true;
    console.error(`  FAIL: ${label}`);
  }
}

// ---------------------------------------------------------------- mock WoC
/** address -> [{tx_hash, tx_pos, value, height}] */
const utxosByAddress = new Map();
/** how many times each address's /unspent has been polled */
const pollCounts = new Map();

function addrOfP2pkhScript(hex) {
  // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  const m = /^76a914([0-9a-f]{40})88ac$/.exec(hex);
  if (!m) return null;
  const bytes = m[1].match(/../g).map((b) => parseInt(b, 16));
  return Utils.toBase58Check(bytes, [TESTNET_P2PKH_PREFIX]);
}

function credit(address, satoshis, height = 0) {
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

  if ((m = /^\/test\/address\/([^/]+)\/unspent$/.exec(url.pathname))) {
    pollCounts.set(m[1], (pollCounts.get(m[1]) ?? 0) + 1);
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
      const tx = Transaction.fromHex(JSON.parse(body).txhex); // throws on garbage
      const txid = tx.id('hex');
      // spend the inputs
      for (const input of tx.inputs) {
        const spentTxid = input.sourceTXID;
        for (const [addr, rows] of utxosByAddress) {
          utxosByAddress.set(
            addr,
            rows.filter((u) => !(u.tx_hash === spentTxid && u.tx_pos === input.sourceOutputIndex)),
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
      send(200, JSON.stringify(txid));
    });
    return;
  }
  send(404, { error: `mock: no route for ${req.method} ${url.pathname}` });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
console.error(`mock WhatsOnChain at ${apiUrl}, state dir ${HOME}`);

// ---------------------------------------------------------------- CLI driving
const env = {
  ...process.env,
  BSV_PAY_HOME: HOME,
  BSV_PAY_PASSPHRASE: 'e2e-local',
  BSV_PAY_API_URL: apiUrl,
};

// async (NOT spawnSync): the mock server lives in this process, so blocking
// the event loop would starve the very API the CLI is calling.
function cli(args, { allowExit = [0] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--testnet', '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => {
      if (!allowExit.includes(status)) {
        console.error(`FAIL: bsv-pay ${args.join(' ')} exited ${status}\nstdout: ${stdout}\nstderr: ${stderr}`);
        process.exit(1);
      }
      const objects = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      resolve({ status, objects });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1. init
  console.error('\n[1/6] init');
  const init = (await cli(['init'])).objects[0];
  check(init.ok === true && /^[mn]/.test(init.address), `wallet created (${init.address})`);

  // 2. request a payment (fresh address, no --wait)
  console.error('[2/6] request');
  const req = (await cli(['request', '10000sats', 'e2e-local invoice'])).objects[0];
  check(req.event === 'request_created' && req.address !== init.address, `fresh request address (${req.address})`);
  check(req.uri === `bitcoin:${req.address}?sv&amount=0.0001&label=e2e-local%20invoice`, 'BIP-21 URI shape');

  // 3. start the real watch process, let it baseline, then land the payment
  console.error('[3/6] watch detects the incoming payment');
  const watch = spawn(process.execPath, [CLI, 'watch', '--interval', '5', '--testnet', '--json'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const watchEvents = [];
  readline.createInterface({ input: watch.stdout }).on('line', (l) => watchEvents.push(JSON.parse(l)));

  // deterministic baseline: wait until watch has polled both tracked addresses once
  for (let i = 0; i < 100 && ((pollCounts.get(init.address) ?? 0) < 1 || (pollCounts.get(req.address) ?? 0) < 1); i++) {
    await sleep(100);
  }
  const faucetTxid = credit(req.address, 10_000, 0); // the "faucet" pays at 0-conf

  let payment;
  for (let i = 0; i < 200 && !payment; i++) {
    await sleep(100);
    payment = watchEvents.find((e) => e.event === 'payment');
  }
  watch.kill();
  check(!!payment, 'watch emitted a payment event within ~15s');
  if (payment) {
    check(payment.txid === faucetTxid && payment.amount_sats === 10_000, 'payment txid + amount match');
    check(payment.status === 'pending', 'detected at 0-conf as pending');
    check(payment.memo === 'e2e-local invoice', 'memo matched from the request');
  }

  // 4. balance shows the unconfirmed funds
  console.error('[4/6] balance shows the funds');
  const bal1 = (await cli(['balance'])).objects[0];
  check(bal1.unconfirmed_sats === 10_000 && bal1.confirmed_sats === 0, 'balance = 10,000 sats unconfirmed');

  // 5. send most of it back, scripted (--yes), spending unconfirmed change
  console.error('[5/6] send back');
  const RETURN_ADDRESS = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
  const send = (await cli(['send', RETURN_ADDRESS, '9000', 'e2e return', '--yes'])).objects[0];
  check(send.ok === true && /^[0-9a-f]{64}$/.test(send.txid), `broadcast accepted (${send.txid?.slice(0, 12)}â€¦)`);
  check(send.amount_sats === 9000 && send.fee_sats >= 1, `fee ${send.fee_sats} sats`);

  // 6. balance reconciles exactly: 10000 - 9000 - fee, sitting on the change address
  console.error('[6/6] balance reconciles');
  const bal2 = (await cli(['balance'])).objects[0];
  const total2 = bal2.confirmed_sats + bal2.unconfirmed_sats;
  check(total2 === 10_000 - 9000 - send.fee_sats, `final balance ${total2} = 10000 - 9000 - ${send.fee_sats}`);
  check(total2 === send.balance_after_sats, 'matches the balance_after_sats send reported');

  // bonus: insufficient funds and spend-limit exits still hold over real HTTP
  // (50000 is under the 100k limit, so it reaches UTXO selection and exits 3;
  // 100000 is at the limit, which is checked first and exits 8)
  check((await cli(['send', RETURN_ADDRESS, '50000', '--yes'], { allowExit: [3] })).status === 3, 'overspend exits 3');
  check(
    (await cli(['send', RETURN_ADDRESS, '100000', '--yes'], { allowExit: [8] })).status === 8,
    'spend limit exits 8',
  );

  // 7. the same engine through the bsv-pay/core library (M8): built artifact,
  //    same mock chain, same state dir the CLI just used.
  console.error('[7/7] bsv-pay/core library leg');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
  const coreExport = pkg.exports?.['./core'];
  check(
    !!coreExport &&
      fs.existsSync(path.resolve(import.meta.dirname, '..', coreExport.default)) &&
      fs.existsSync(path.resolve(import.meta.dirname, '..', coreExport.types)),
    'package.json exports ./core with built js + d.ts',
  );

  process.env.BSV_PAY_HOME = HOME;
  process.env.BSV_PAY_API_URL = apiUrl;
  const core = await import(pathToFileURL(path.resolve(import.meta.dirname, '../dist/core/index.js')).href);
  const coreOpts = { network: 'test' };

  const libBal = await core.getBalance(coreOpts);
  check(
    libBal.confirmedSats + libBal.unconfirmedSats === total2,
    `library getBalance matches the CLI (${total2} sats)`,
  );
  const movements = await core.getHistory(coreOpts);
  check(
    movements.length === 2 && movements[0].type === 'send' && movements[1].type === 'receive',
    'library getHistory sees the CLI loop, newest first',
  );

  // passphrase passed explicitly (no env var in this process) — never prompts
  const wallet = await core.openWallet({ ...coreOpts, passphrase: 'e2e-local' });
  const libSend = await core.send(wallet, coreOpts, {
    to: RETURN_ADDRESS,
    amountSats: 500,
    memo: 'library send',
  });
  check(/^[0-9a-f]{64}$/.test(libSend.txid), `library send broadcast (${libSend.txid.slice(0, 12)}…)`);
  const libBal2 = await core.getBalance(coreOpts);
  check(
    libBal2.confirmedSats + libBal2.unconfirmedSats === total2 - 500 - libSend.feeSats,
    `library balance reconciles ${total2} - 500 - ${libSend.feeSats}`,
  );

  // request + awaitPayment through the library: invoice, mock pays, detected
  const libReq = core.createRequest(wallet, { amountSats: 1000, memo: 'lib invoice' });
  check(libReq.uri.includes(libReq.address), 'library createRequest issues a URI for a fresh address');
  credit(libReq.address, 1000, 0);
  const libPaid = await core.awaitPayment(coreOpts, {
    address: libReq.address,
    timeoutMs: 30_000,
    pollIntervalMs: 100,
    memo: 'lib invoice',
  });
  check(libPaid.receivedSats === 1000 && !libPaid.confirmed, 'library awaitPayment sees the 0-conf payment');
  const libHist = await core.getHistory(coreOpts, { type: 'receive', limit: 1 });
  check(libHist[0]?.memo === 'lib invoice', 'library receive is ledgered with its memo');
} finally {
  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

if (failed) {
  console.error('\nE2E-LOCAL FAILED');
  process.exit(1);
}
console.error('\nE2E-LOCAL PASSED: full loop verified through the real CLI over HTTP.');

