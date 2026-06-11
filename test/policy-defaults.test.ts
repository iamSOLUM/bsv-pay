import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import { cmdSend } from '../src/commands/send.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  openWallet,
  planSend,
  EXIT,
  type BsvPayError,
  type CoreWallet,
} from '../src/core/index.js';
import { readLedger } from '../src/ledger.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import type { Ctx } from '../src/context.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * NO-SURPRISE DEFAULTS: with no policy.toml, behavior is byte-identical to
 * pre-policy bsv-pay — same exit codes, same error codes and messages, same
 * JSON shapes, --allow-large works, nothing queues. (The broader proof is
 * the entire untouched Phase 1 suite; this file pins the contract bytes.)
 */

let tmpDir: string;
let walletAddr: string;
let wallet: CoreWallet;
const RECIPIENT = PrivateKey.fromRandom().toAddress();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-defaults-'));
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
  vi.restoreAllMocks();
});

function fundedProvider(sats = 300_000): MockChainProvider {
  const provider = new MockChainProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

function makeCtx(): Ctx {
  return { out: new Output(true), json: true, network: 'main', config: { ...DEFAULT_CONFIG } };
}

function jsonOut(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    lines.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return lines;
}

describe('no policy.toml: pre-policy behavior, byte for byte', () => {
  it('an ordinary send succeeds with the exact M8 JSON result shape', async () => {
    const lines = jsonOut();
    await cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { yes: true }, fundedProvider());
    const result = JSON.parse(lines.join(''));
    expect(Object.keys(result).sort()).toEqual([
      'amount_sats',
      'balance_after_sats',
      'change_sats',
      'explorer_url',
      'fee_sats',
      'ok',
      'recipient',
      'txid',
    ]);
    expect(result.ok).toBe(true);
  });

  it('--yes at the limit without --allow-large: exit 8, same code, same message', async () => {
    jsonOut();
    try {
      await cmdSend(makeCtx(), RECIPIENT, '100000', undefined, { yes: true }, fundedProvider());
      expect.unreachable();
    } catch (e) {
      const err = e as BsvPayError;
      expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
      expect(err.errorCode).toBe('spend_limit_exceeded');
      expect(err.message).toBe(
        'Amount 100,000 sats (0.001 BSV) is at/above your 100,000 sats (0.001 BSV) per-transaction limit. ' +
          'Add --allow-large alongside --yes, or raise spend_limit_sats in config.toml.',
      );
      expect(err.data).toMatchObject({ limit_sats: 100_000, amount_sats: 100_000 });
    }
  });

  it('--yes --allow-large still permits at-limit sends', async () => {
    jsonOut();
    const provider = fundedProvider();
    await cmdSend(
      makeCtx(),
      RECIPIENT,
      '100000',
      undefined,
      { yes: true, allowLarge: true },
      provider,
    );
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('the config spend limit is still honored from config.toml', async () => {
    jsonOut();
    const ctx = makeCtx();
    ctx.config.spendLimitSats = 2_000;
    resetPolicyCacheForTests();
    try {
      await cmdSend(ctx, RECIPIENT, '2000', undefined, { yes: true }, fundedProvider());
      expect.unreachable();
    } catch (e) {
      expect((e as BsvPayError).errorCode).toBe('spend_limit_exceeded');
    }
  });

  it('library planSend keeps the M8 contract for the soft limit', async () => {
    const core = { network: 'main' as const, provider: fundedProvider() };
    try {
      await planSend(wallet, core, { to: RECIPIENT, amountSats: 100_000 });
      expect.unreachable();
    } catch (e) {
      const err = e as BsvPayError;
      expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
      expect(err.errorCode).toBe('spend_limit_exceeded');
      expect(err.data).toMatchObject({ limit_sats: 100_000, amount_sats: 100_000 });
    }
    const plan = await planSend(wallet, core, {
      to: RECIPIENT,
      amountSats: 100_000,
      allowAboveLimit: true,
    });
    expect(plan.amountSats).toBe(100_000);
  });

  it('nothing ever queues (no exit 9) and no approvals exist', async () => {
    jsonOut();
    const provider = fundedProvider();
    await cmdSend(makeCtx(), RECIPIENT, '99999', undefined, { yes: true }, provider);
    const entries = readLedger('main');
    expect(
      entries.filter((e) => e.type === 'policy_decision' && e.decision === 'queue'),
    ).toHaveLength(0);
    expect(entries.filter((e) => e.type === 'approval_resolved')).toHaveLength(0);
  });

  it('--dry-run still persists nothing — not even a policy decision', async () => {
    jsonOut();
    await cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { dryRun: true }, fundedProvider());
    expect(readLedger('main').filter((e) => e.type !== 'address_issued')).toEqual([]);
  });

  it('real sends now also ledger an allow decision (additive, Phase 2)', async () => {
    jsonOut();
    await cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { yes: true }, fundedProvider());
    const decisions = readLedger('main').filter((e) => e.type === 'policy_decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'allow',
      rule: 'default',
      address: RECIPIENT,
      amount_sats: 5_000,
    });
    // and the send entry links back to it
    const sends = readLedger('main').filter((e) => e.type === 'send');
    expect(sends[0]!.decision_id).toBe((decisions[0] as { decision_id: string }).decision_id);
  });
});
