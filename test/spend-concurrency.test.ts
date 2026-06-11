import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import { openWallet, send, type CoreWallet } from '../src/core/index.js';
import type { CliError } from '../src/errors.js';
import { readLedger } from '../src/ledger.js';
import { policyPath } from '../src/paths.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * Concurrency safety of the spend path. Budgets are recomputed from the
 * ledger at decision time, but the send entry that consumes them lands only
 * after broadcast — without serialization, N simultaneous send() calls
 * would ALL be decided against the same untouched budget and all pass.
 * send() single-flights the whole decide→broadcast→ledger span (see
 * core/spend-lock.ts); these tests prove total ledgered spend never
 * exceeds the budget no matter how many spends race.
 */

let tmpDir: string;
let walletAddr: string;
let wallet: CoreWallet;
const RECIPIENT = PrivateKey.fromRandom().toAddress();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-spend-conc-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
  walletAddr = (await Wallet.unlock('main')).issueAddress('receive').address;
  wallet = await openWallet({ network: 'main' });
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fundedProvider(sats = 200_000): MockChainProvider {
  const provider = new MockChainProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

function ledgeredSpendSats(): number {
  return readLedger('main')
    .filter((e) => e.type === 'send')
    .reduce((sum, e) => sum + e.amount_sats, 0);
}

async function raceSends(
  provider: MockChainProvider,
  count: number,
  amountSats: number,
): Promise<PromiseSettledResult<unknown>[]> {
  const core = { network: 'main' as const, provider };
  return Promise.allSettled(
    Array.from({ length: count }, () => send(wallet, core, { to: RECIPIENT, amountSats })),
  );
}

describe('concurrent spends never overshoot a budget', () => {
  it('daily budget: 5 racing sends of 4k against a 10k budget — exactly 2 land', async () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 10000');
    const provider = fundedProvider();

    const results = await raceSends(provider, 5, 4_000);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(3);
    for (const f of failed) {
      const err = f.reason as CliError;
      expect(err.errorCode).toBe('daily_budget_exceeded');
      expect((err.data as { remaining_sats: number }).remaining_sats).toBe(2_000);
    }

    // The owner's invariant: total ledgered spend never exceeds the budget.
    expect(ledgeredSpendSats()).toBe(8_000);
    expect(ledgeredSpendSats()).toBeLessThanOrEqual(10_000);
    expect(provider.broadcasts).toHaveLength(2);

    // Every racing spend left an audit trail: 2 allows, 3 denies.
    const decisions = readLedger('main').filter((e) => e.type === 'policy_decision');
    expect(decisions.filter((d) => d.decision === 'allow')).toHaveLength(2);
    expect(decisions.filter((d) => d.decision === 'deny')).toHaveLength(3);
  });

  it('session budget (in-memory accounting races too): 4 sends of 3k against 6k', async () => {
    fs.writeFileSync(policyPath(), 'session_budget_sats = 6000');
    const provider = fundedProvider();

    const results = await raceSends(provider, 4, 3_000);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as CliError);
    expect(errors).toHaveLength(2);
    for (const err of errors) expect(err.errorCode).toBe('session_budget_exceeded');
    expect(ledgeredSpendSats()).toBeLessThanOrEqual(6_000);
    expect(provider.broadcasts).toHaveLength(2);
  });

  it('a denied spend releases the lock — later sends still go through', async () => {
    fs.writeFileSync(policyPath(), 'per_tx_limit_sats = 5000\ndaily_budget_sats = 10000');
    const provider = fundedProvider();
    const core = { network: 'main' as const, provider };

    // over the hard per-tx limit: denied inside the locked span
    await expect(send(wallet, core, { to: RECIPIENT, amountSats: 9_000 })).rejects.toMatchObject({
      errorCode: 'per_tx_limit_exceeded',
    });
    // the chain is not poisoned: a compliant spend right after succeeds
    const result = await send(wallet, core, { to: RECIPIENT, amountSats: 4_000 });
    expect(result.txid).toHaveLength(64);
    expect(ledgeredSpendSats()).toBe(4_000);
  });

  it('rate limit under concurrency: 4 racing sends, max 2 per minute', async () => {
    fs.writeFileSync(policyPath(), 'rate_limit_per_minute = 2');
    const provider = fundedProvider();

    const results = await raceSends(provider, 4, 1_000);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as CliError);
    for (const err of errors) expect(err.errorCode).toBe('rate_limit_exceeded');
    expect(provider.broadcasts).toHaveLength(2);
  });
});
