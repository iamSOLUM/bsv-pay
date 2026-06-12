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
import { LockingScript, MerklePath, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
function cli(args, { allowExit = [0], env: envOverride } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--testnet', '--json'], {
      env: envOverride ?? env,
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
  // Wait for the process to actually die: a lingering watch can complete one
  // more poll cycle and ledger the change from step 5's send as a fresh
  // receive, corrupting the step-7 history assertion (seen flaking on a
  // loaded Windows machine — kill() returns before termination completes).
  await new Promise((resolve) => watch.once('close', resolve));
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
    `library getHistory sees the CLI loop, newest first (got: ${movements.map((m) => `${m.type}:${m.amount_sats}`).join(', ') || 'empty'})`,
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

  // 8. M9 policy engine over the real CLI: allow, deny (budget / hard limit /
  //    denylist), queue (exit 9), approvals list, policy show/test.
  //    The interactive approve/reject path needs a human at a TTY by design —
  //    it is covered by unit tests (test/approvals.test.ts) and the manual
  //    checkpoint demo, never automated here.
  console.error('[8/8] policy engine governs the CLI');
  // spent so far today: 9000 (CLI leg) + 500 (library leg) = 9500 sats
  const DENIED_ADDRESS = PrivateKey.fromRandom().toAddress('testnet');
  fs.writeFileSync(path.join(HOME, 'policy.toml'), [
    'per_tx_limit_sats = 8000',
    'daily_budget_sats = 11000',
    'approval_threshold_sats = 1000',
    `denylist = ["${DENIED_ADDRESS}"]`,
    '',
  ].join('\n'));

  const policyShow = await cli(['policy', 'show']);
  check(policyShow.objects[0].source === 'file' && policyShow.objects[0].rules.per_tx_limit_sats === 8000, 'policy show reads the file');

  const ledgerEntries = () =>
    fs.readFileSync(path.join(HOME, 'ledger-testnet.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // allowed: small send within everything
  const bal3 = (await cli(['balance'])).objects[0];
  const total3 = bal3.confirmed_sats + bal3.unconfirmed_sats;
  const sendA = (await cli(['send', RETURN_ADDRESS, '200', 'within policy', '--yes'])).objects[0];
  check(sendA.ok === true, 'send within policy is allowed');
  check(
    ledgerEntries().some((e) => e.type === 'policy_decision' && e.decision === 'allow' && e.amount_sats === 200),
    'allow decision is in the ledger',
  );

  // denied: daily budget (9700 spent, 1300 left, asks for 2000)
  const deniedBudget = (await cli(['send', RETURN_ADDRESS, '2000', '--yes'], { allowExit: [8] })).objects[0];
  check(deniedBudget.error === 'daily_budget_exceeded' && deniedBudget.remaining_sats === 1300, 'over-budget send denied with exit 8 + remaining_sats');
  check(
    ledgerEntries().some((e) => e.type === 'policy_decision' && e.decision === 'deny' && e.rule === 'daily_budget_sats'),
    'deny decision is in the ledger with its rule',
  );

  // denied: hard per-tx limit ignores --allow-large
  const deniedHard = (await cli(['send', RETURN_ADDRESS, '9000', '--yes', '--allow-large'], { allowExit: [8] })).objects[0];
  check(deniedHard.error === 'per_tx_limit_exceeded', 'hard per-tx limit denies even --allow-large');

  // denied: denylist
  const deniedList = (await cli(['send', DENIED_ADDRESS, '100', '--yes'], { allowExit: [8] })).objects[0];
  check(deniedList.error === 'recipient_denied', 'denylisted recipient is denied');

  // queued: at/above the approval threshold, within budget -> exit 9
  const queued = (await cli(['send', RETURN_ADDRESS, '1200', 'needs human', '--yes'], { allowExit: [9] })).objects[0];
  check(queued.error === 'pending_approval' && typeof queued.approval_id === 'string', 'large send queues with exit 9 + approval_id');
  const approvalsList = (await cli(['approvals', 'list'])).objects[0];
  check(
    approvalsList.approvals.length === 1 && approvalsList.approvals[0].amount_sats === 1200 && approvalsList.approvals[0].id === queued.approval_id,
    'approvals list shows the queued payment',
  );

  // policy test: dry-run decisions with the right exit codes, persisting nothing
  const entriesBefore = ledgerEntries().length;
  check((await cli(['policy', 'test', RETURN_ADDRESS, '100'])).status === 0, 'policy test: would allow -> exit 0');
  check((await cli(['policy', 'test', RETURN_ADDRESS, '5000'], { allowExit: [8] })).status === 8, 'policy test: would deny -> exit 8');
  check((await cli(['policy', 'test', RETURN_ADDRESS, '1200'], { allowExit: [9] })).status === 9, 'policy test: would queue -> exit 9');
  check(ledgerEntries().length === entriesBefore, 'policy test persisted nothing');

  // nothing denied or queued moved any money
  const bal4 = (await cli(['balance'])).objects[0];
  const total4 = bal4.confirmed_sats + bal4.unconfirmed_sats;
  check(total4 === total3 - 200 - sendA.fee_sats, 'balance moved only by the one allowed send');

  // 9. M10 MCP server: the REAL `bsv-pay mcp` process over stdio, driven by a
  //    real MCP client against the same mock chain and state dir. This is the
  //    checkpoint demo loop: check allowance -> pay -> get BLOCKED over budget
  //    -> see the queued payment a human must approve.
  //    Spent today so far: 9000 + 500 + 200 = 9700 sats.
  console.error('[9/9] MCP server governs an agent session');
  fs.writeFileSync(path.join(HOME, 'policy.toml'), [
    'per_tx_limit_sats = 8000',
    'daily_budget_sats = 12000',
    'approval_threshold_sats = 1500',
    `denylist = ["${DENIED_ADDRESS}"]`,
    '',
  ].join('\n'));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--testnet'],
    env, // BSV_PAY_PASSPHRASE in env = headless unlock at start, agent holds no secret
    stderr: 'pipe',
  });
  let mcpStderr = '';
  const mcp = new Client({ name: 'e2e-local', version: '0.0.0' });
  await mcp.connect(transport);
  transport.stderr?.on('data', (c) => (mcpStderr += c));

  try {
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    check(
      tools.join(',') ===
        'await_payment,create_payment_request,get_balance,get_history,get_policy_status,paid_fetch,pay',
      'seven tools, no unlock/approve/secret surface',
    );

    const tool = async (name, args = {}) =>
      (await mcp.callTool({ name, arguments: args })).structuredContent;

    // agent checks its allowance first
    const status = await tool('get_policy_status');
    check(
      status.ok === true && status.source === 'file' && status.daily_remaining_sats === 2300,
      `get_policy_status: 2,300 sats of the daily budget left`,
    );
    check(
      status.pending_approvals.some((p) => p.approval_id === queued.approval_id),
      'the CLI-queued payment is visible to the agent',
    );

    // within allowance: pays
    const mcpBal1 = await tool('get_balance');
    const paid = await tool('pay', { address: RETURN_ADDRESS, amount_sats: 800, memo: 'mcp paid' });
    check(paid.ok === true && /^[0-9a-f]{64}$/.test(paid.txid), `MCP pay broadcast (${paid.txid?.slice(0, 12)}…)`);
    check(
      ledgerEntries().some((e) => e.type === 'send' && e.amount_sats === 800 && e.txid === paid.txid),
      'MCP send is ledgered',
    );

    // over budget: BLOCKED with a structured, agent-readable denial + ledgered deny
    const denied = await tool('pay', { address: RETURN_ADDRESS, amount_sats: 1600 });
    check(
      denied.ok === false && denied.code === 8 && denied.error === 'daily_budget_exceeded' &&
        denied.remaining_sats === 1500,
      'over-budget MCP pay returns the structured denial (remaining_sats 1500)',
    );
    check(
      ledgerEntries().some(
        (e) => e.type === 'policy_decision' && e.decision === 'deny' && e.amount_sats === 1600,
      ),
      'the MCP denial is ledgered with its rule',
    );

    // denylist holds over MCP too
    const deniedList9 = await tool('pay', { address: DENIED_ADDRESS, amount_sats: 100 });
    check(deniedList9.ok === false && deniedList9.error === 'recipient_denied', 'denylist holds over MCP');

    // at/above the threshold: queued for a HUMAN, not sent
    const queued9 = await tool('pay', { address: RETURN_ADDRESS, amount_sats: 1500, memo: 'big one' });
    check(
      queued9.ok === false && queued9.code === 9 && queued9.error === 'pending_approval' &&
        typeof queued9.approval_id === 'string',
      'large MCP pay queues with pending_approval + approval_id',
    );
    const approvals9 = (await cli(['approvals', 'list'])).objects[0];
    check(
      approvals9.approvals.some((a) => a.id === queued9.approval_id && a.amount_sats === 1500),
      'the human sees the agent-queued payment in approvals list',
    );

    // the receive loop: request -> payer pays -> await sees it
    const invoice = await tool('create_payment_request', { amount_sats: 700, memo: 'mcp invoice' });
    check(invoice.ok === true && invoice.uri.includes(invoice.address), 'MCP payment request issued');
    credit(invoice.address, 700, 0);
    const received = await tool('await_payment', { address: invoice.address, timeout_s: 30 });
    check(
      received.ok === true && received.amount_sats === 700 && received.confirmed === false,
      'MCP await_payment sees the 0-conf payment',
    );

    // money moved only by the one allowed pay (+ the 700 received)
    const mcpBal2 = await tool('get_balance');
    check(
      mcpBal2.total_sats === mcpBal1.total_sats - 800 - paid.fee_sats + 700,
      'balance moved only by the allowed MCP pay and the receive',
    );
    const history = await tool('get_history', { limit: 2 });
    check(
      history.payments[0].type === 'receive' && history.payments[0].amount_sats === 700 &&
        history.payments[1].type === 'send' && history.payments[1].amount_sats === 800,
      'MCP get_history sees the session, newest first',
    );
  } finally {
    await mcp.close();
  }
  check(mcpStderr.includes('bsv-pay MCP server ready'), 'server banner went to stderr, not stdout');

  // 10. M11 HTTP 402: a REAL `bsv-pay serve` paywall (its own wallet + state
  //     dir = the seller) and the buyer's `bsv-pay fetch`, two processes over
  //     the shared mock chain. Policy still governs the buyer's 402 spends.
  //     Buyer budget so far today: 9700 + 800 (MCP pay) = 10500 of 12000.
  console.error('[10/10] HTTP 402: serve sells, fetch buys, policy governs');
  credit(init.address, 10_000, 0); // top up the buyer; budget, not funds, is the limiter

  const SELLER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-e2e-seller-'));
  const sellerEnv = { ...env, BSV_PAY_HOME: SELLER_HOME };
  const PAYWALL_PORT = 18_000 + Math.floor(Math.random() * 2_000);
  const PAYWALL_URL = `http://127.0.0.1:${PAYWALL_PORT}/dataset`;
  let serveProc;
  try {
    const sellerInit = (await cli(['init'], { env: sellerEnv })).objects[0];
    check(sellerInit.ok === true, 'seller wallet created in its own state dir');

    serveProc = spawn(
      process.execPath,
      [CLI, 'serve', '--price', '700', '--port', String(PAYWALL_PORT), '--body', 'premium dataset', '--testnet'],
      { env: sellerEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let serveStderr = '';
    serveProc.stderr.on('data', (c) => (serveStderr += c));
    for (let i = 0; i < 100 && !serveStderr.includes('paywall on'); i++) await sleep(100);
    check(serveStderr.includes('paywall on'), 'serve started and announced itself on stderr');

    // buy: within budget (700 of the 1500 left) -> paid and served
    const buy1 = (await cli(['fetch', PAYWALL_URL])).objects[0];
    check(buy1.ok === true && buy1.status === 200 && buy1.paid === true, 'fetch paid the 402 and got the content');
    check(buy1.amount_sats === 700 && /^[0-9a-f]{64}$/.test(buy1.txid), `fetch paid 700 sats (txid ${buy1.txid?.slice(0, 12)}…)`);
    check(JSON.parse(buy1.body).message === 'premium dataset', 'the paid body is the seller’s content');
    check(
      ledgerEntries().some((e) => e.type === 'send' && e.amount_sats === 700 && e.memo?.startsWith('402 http://')),
      'buyer ledgered the 402 spend with its URL memo',
    );

    const sellerLedger = () =>
      fs.readFileSync(path.join(SELLER_HOME, 'ledger-testnet.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const sellerBal1 = (await cli(['balance'], { env: sellerEnv })).objects[0];
    check(sellerBal1.unconfirmed_sats === 700, 'seller balance shows the sale (700 sats)');
    check(
      sellerLedger().some((e) => e.type === 'receive' && e.amount_sats === 700 && e.memo?.startsWith('402 sale')),
      'seller ledgered the receive with a 402 sale memo',
    );

    // capped: --max-price refuses BEFORE paying
    const capped = (await cli(['fetch', PAYWALL_URL, '--max-price', '500'], { allowExit: [8] })).objects[0];
    check(capped.error === 'max_price_exceeded' && capped.price_sats === 700, 'max-price caps the fetch before any spend');

    // second buy: still within budget (800 left)
    const buy2 = (await cli(['fetch', PAYWALL_URL])).objects[0];
    check(buy2.ok === true && buy2.paid === true, 'second fetch paid (budget had 800 left)');

    // third buy: the daily budget says no -> structured denial, ledgered deny
    const blocked = (await cli(['fetch', PAYWALL_URL], { allowExit: [8] })).objects[0];
    check(
      blocked.error === 'daily_budget_exceeded' && blocked.remaining_sats === 100,
      'third fetch BLOCKED by the daily budget (100 sats left < 700)',
    );
    const sellerBal2 = (await cli(['balance'], { env: sellerEnv })).objects[0];
    check(sellerBal2.unconfirmed_sats === 1_400, 'seller earned exactly the two allowed sales (1,400 sats)');
  } finally {
    if (serveProc) serveProc.kill();
    fs.rmSync(SELLER_HOME, { recursive: true, force: true });
  }

  // 11. M12 BRC-100 custody (experimental): the real CLI delegates signing
  //     to a mock "desktop wallet" speaking the BRC-100 JSON-API over real
  //     HTTP, in its own state dir. The wallet app signs and broadcasts to
  //     the same mock chain; bsv-pay's policy gate still decides every
  //     spend BEFORE the wallet app is asked, and receive-side refuses.
  console.error('[11/11] BRC-100 custody: external wallet signs, policy still governs');
  const brc100Wallet = startMockBrc100Wallet(apiUrl);
  await new Promise((resolve) => brc100Wallet.server.listen(0, '127.0.0.1', resolve));
  const BRC100_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-e2e-brc100-'));
  const brc100Env = {
    ...env,
    BSV_PAY_HOME: BRC100_HOME,
    BSV_PAY_BRC100_URL: `http://127.0.0.1:${brc100Wallet.server.address().port}`,
  };
  try {
    brc100Wallet.fund(20_000);

    const exInit = (await cli(['init', '--experimental-brc100'], { env: brc100Env })).objects[0];
    check(
      exInit.ok === true && exInit.backend === 'brc100' && /^0[23][0-9a-f]{64}$/.test(exInit.identity_key),
      'BRC-100 wallet connected (identity key shown, nothing local to leak)',
    );
    const exFile = JSON.parse(fs.readFileSync(path.join(BRC100_HOME, 'wallet-testnet.json'), 'utf8'));
    check(
      exFile.backend === 'brc100' && exFile.secret === undefined && exFile.cipher === undefined,
      'delegating wallet file stores no secret',
    );

    const exBal1 = (await cli(['balance'], { env: brc100Env })).objects[0];
    check(
      exBal1.backend === 'brc100' && exBal1.confirmed_sats === 20_000,
      'balance comes from the wallet app (20,000 sats)',
    );

    fs.writeFileSync(path.join(BRC100_HOME, 'policy.toml'), 'daily_budget_sats = 6000\n');

    const exSend = (await cli(['send', RETURN_ADDRESS, '5000', 'brc100 e2e', '--yes'], { env: brc100Env })).objects[0];
    check(
      exSend.ok === true && exSend.backend === 'brc100' && /^[0-9a-f]{64}$/.test(exSend.txid),
      `send went through the wallet app within policy (txid ${exSend.txid?.slice(0, 12)}…)`,
    );
    check(exSend.fee_sats === 10 && exSend.fee_estimated === undefined, 'exact fee decoded from the wallet app tx');
    check(
      (utxosByAddress.get(RETURN_ADDRESS) ?? []).some((u) => u.tx_hash === exSend.txid && u.value === 5000),
      'the wallet app broadcast a real transaction to the chain',
    );
    check(brc100Wallet.state.createActionCalls === 1, 'exactly one action requested from the wallet app');

    const exDenied = (await cli(['send', RETURN_ADDRESS, '5000', '--yes'], { env: brc100Env, allowExit: [8] })).objects[0];
    check(
      exDenied.error === 'daily_budget_exceeded' && exDenied.remaining_sats === 1000,
      'over-budget send denied with 1,000 sats remaining',
    );
    check(brc100Wallet.state.createActionCalls === 1, 'the denied spend never reached the wallet app');

    const exLedger = fs.readFileSync(path.join(BRC100_HOME, 'ledger-testnet.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    check(
      exLedger.some((e) => e.type === 'policy_decision' && e.decision === 'allow' && e.amount_sats === 5000) &&
        exLedger.some((e) => e.type === 'policy_decision' && e.decision === 'deny' && e.rule === 'daily_budget_sats') &&
        exLedger.some((e) => e.type === 'send' && e.txid === exSend.txid && e.fee_sats === 10),
      'allow, deny, and the send are all ledgered',
    );

    const exReq = (await cli(['request', '1000'], { env: brc100Env, allowExit: [2] })).objects[0];
    check(exReq.error === 'brc100_receive_not_supported', 'receive-side refuses under external custody');

    const exBal2 = (await cli(['balance'], { env: brc100Env })).objects[0];
    check(exBal2.confirmed_sats === 20_000 - 5000 - 10, 'balance reconciles through the wallet app (14,990 sats)');
  } finally {
    brc100Wallet.server.close();
    fs.rmSync(BRC100_HOME, { recursive: true, force: true });
  }
} finally {
  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

// ------------------------------------------------- mock BRC-100 wallet app
/**
 * A minimal "desktop wallet" speaking the BRC-100 JSON-API shape the SDK's
 * HTTPWalletJSON client expects (POST /<call> with JSON args). It holds its
 * own testnet key, funds/signs createAction requests from an in-memory UTXO
 * set, and broadcasts to the mock chain like a real wallet app would. Its
 * key never leaves this function — bsv-pay only ever sees txids and amounts.
 */
function startMockBrc100Wallet(chainApiUrl) {
  const key = PrivateKey.fromRandom();
  const address = key.toAddress('testnet');
  const FEE = 10;
  let utxos = []; // { tx, vout, satoshis }
  const state = { createActionCalls: 0 };

  function fund(satoshis) {
    const fundTx = new Transaction();
    fundTx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis });
    fundTx.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: fundTx.id('hex'), txid: true }]]);
    utxos.push({ tx: fundTx, vout: 0, satoshis });
  }

  async function createAction(args) {
    state.createActionCalls++;
    const outs = args.outputs ?? [];
    const outputSum = outs.reduce((s, o) => s + o.satoshis, 0);
    const selected = [];
    let total = 0;
    for (const u of [...utxos].sort((a, b) => b.satoshis - a.satoshis)) {
      if (total >= outputSum + FEE) break;
      selected.push(u);
      total += u.satoshis;
    }
    if (total < outputSum + FEE) {
      const err = new Error('insufficient funds');
      err.walletCode = 7;
      err.totalSatoshisNeeded = outputSum + FEE;
      err.moreSatoshisNeeded = outputSum + FEE - total;
      throw err;
    }
    const tx = new Transaction();
    for (const u of selected) {
      tx.addInput({
        sourceTransaction: u.tx,
        sourceOutputIndex: u.vout,
        unlockingScriptTemplate: new P2PKH().unlock(key, 'all', false, u.satoshis, new P2PKH().lock(address)),
      });
    }
    for (const o of outs) {
      tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
    }
    const change = total - outputSum - FEE;
    if (change > 0) tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: change });
    await tx.sign();
    const broadcast = await fetch(`${chainApiUrl}/test/tx/raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txhex: tx.toHex() }),
    });
    if (!broadcast.ok) throw new Error('mock chain rejected the wallet broadcast');
    const beef = tx.toAtomicBEEF();
    utxos = utxos.filter((u) => !selected.includes(u));
    if (change > 0) {
      tx.merklePath = new MerklePath(800_001, [[{ offset: 0, hash: tx.id('hex'), txid: true }]]);
      utxos.push({ tx, vout: outs.length, satoshis: change });
    }
    return { txid: tx.id('hex'), tx: beef };
  }

  const walletServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const args = body ? JSON.parse(body) : {};
        switch (req.url.replace(/^\//, '')) {
          case 'getVersion':
            return reply(200, { version: 'mock-desktop 1.0.0' });
          case 'getNetwork':
            return reply(200, { network: 'testnet' });
          case 'isAuthenticated':
          case 'waitForAuthentication':
            return reply(200, { authenticated: true });
          case 'getPublicKey':
            return reply(200, { publicKey: key.toPublicKey().toString() });
          case 'listOutputs':
            return reply(200, {
              totalOutputs: utxos.length,
              outputs: utxos.map((u) => ({
                satoshis: u.satoshis,
                spendable: true,
                outpoint: `${u.tx.id('hex')}.${u.vout}`,
              })),
            });
          case 'createAction':
            return reply(200, await createAction(args));
          default:
            return reply(404, { message: `mock wallet: no route for ${req.url}` });
        }
      } catch (e) {
        if (e.walletCode === 7) {
          return reply(400, {
            isError: true,
            code: 7,
            message: e.message,
            totalSatoshisNeeded: e.totalSatoshisNeeded,
            moreSatoshisNeeded: e.moreSatoshisNeeded,
          });
        }
        reply(500, { message: e.message });
      }
    });
  });
  return { server: walletServer, fund, state, address };
}

if (failed) {
  console.error('\nE2E-LOCAL FAILED');
  process.exit(1);
}
console.error('\nE2E-LOCAL PASSED: full loop verified through the real CLI over HTTP.');

