#!/usr/bin/env node
/**
 * End-to-end testnet exercise: init -> request -> (faucet) -> wait detects ->
 * send back -> balance reconciles. Uses only --json + exit codes, exactly the
 * way a script consumer would.
 *
 * Live network + manual faucet step, so it is gated:
 *   BSV_PAY_E2E=1 node scripts/e2e-testnet.mjs
 *
 * Optional: BSV_PAY_E2E_RETURN_ADDRESS=<testnet addr> to send funds back
 * (defaults to the witnessonchain faucet return address).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.BSV_PAY_E2E !== '1') {
  console.error('Skipping live testnet e2e (set BSV_PAY_E2E=1 to run).');
  process.exit(0);
}

const CLI = path.resolve(import.meta.dirname, '../dist/cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-e2e-'));
const RETURN_ADDRESS = process.env.BSV_PAY_E2E_RETURN_ADDRESS ?? 'msX4FBpJ4SqQwgio12BCvfgvFdSqaubXnV';

const env = {
  ...process.env,
  BSV_PAY_HOME: HOME,
  BSV_PAY_PASSPHRASE: 'e2e-throwaway',
};

function run(args, { allowExit = [0] } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args, '--testnet', '--json'], {
    env,
    encoding: 'utf8',
    timeout: 700_000,
  });
  process.stderr.write(res.stderr ?? '');
  if (!allowExit.includes(res.status)) {
    console.error(`FAIL: bsv-pay ${args.join(' ')} exited ${res.status}\n${res.stdout}`);
    process.exit(1);
  }
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  return { status: res.status, objects: lines.map((l) => JSON.parse(l)) };
}

console.error(`e2e state dir: ${HOME}`);

// 1. init
const init = run(['init']).objects[0];
console.error(`wallet created, first address ${init.address}`);

// 2. request + wait for the faucet payment (15 min budget)
console.error('\n>>> Fund this request from a testnet faucet, e.g.');
console.error('>>>   https://witnessonchain.com/faucet/tbsv');
const reqRun = run(['request', '10000sats', 'e2e faucet', '--wait', '--timeout', '900']);
const created = reqRun.objects.find((o) => o.event === 'request_created');
console.error(`>>> PAY THIS ADDRESS: ${created.address}`);
const paid = reqRun.objects.find((o) => o.event === 'payment_received');
console.error(`payment seen: ${paid.received_sats} sats in ${paid.txid}`);

// 3. balance shows the funds (0-conf counts as unconfirmed or confirmed)
const bal1 = run(['balance']).objects[0];
const total1 = bal1.confirmed_sats + bal1.unconfirmed_sats;
if (total1 < paid.received_sats) {
  console.error(`FAIL: balance ${total1} < received ${paid.received_sats}`);
  process.exit(1);
}
console.error(`balance after funding: ${total1} sats`);

// 4. send most of it back (leave room for the fee), scripted with --yes
const sendAmount = Math.max(1, paid.received_sats - 500);
const send = run(['send', RETURN_ADDRESS, String(sendAmount), 'e2e return', '--yes']).objects[0];
console.error(`sent back: ${send.txid} (fee ${send.fee_sats} sats)`);

// 5. balance reconciles: previous total - amount - fee
const bal2 = run(['balance']).objects[0];
const total2 = bal2.confirmed_sats + bal2.unconfirmed_sats;
const expected = total1 - sendAmount - send.fee_sats;
if (total2 !== expected) {
  console.error(`FAIL: balance ${total2} != expected ${expected}`);
  process.exit(1);
}

console.error(`\nE2E PASSED: balance reconciles at ${total2} sats.`);
fs.rmSync(HOME, { recursive: true, force: true });
