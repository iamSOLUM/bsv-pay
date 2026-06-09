import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic } from '@bsv/sdk';
import { cmdWatch } from '../src/commands/watch.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { readLedger } from '../src/ledger.js';
import { EXIT, type CliError } from '../src/errors.js';
import type { Ctx } from '../src/context.js';
import type { Utxo } from '../src/chain/provider.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;
let addr: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-watch-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
  addr = (await Wallet.unlock('main')).issueAddress('request', 'invoice-42').address;
  // make sleeps instant
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeCtx(json = true): Ctx {
  return { out: new Output(json), json, network: 'main', config: { ...DEFAULT_CONFIG } };
}

function stdoutLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    lines.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return lines;
}

/** Provider whose getUtxos answer changes per polling cycle. */
function scriptedProvider(script: Utxo[][]): MockChainProvider {
  const provider = new MockChainProvider();
  let call = -1;
  provider.getUtxos = async () => {
    call += 1;
    return script[Math.min(call, script.length - 1)] ?? [];
  };
  return provider;
}

const TXID_A = '11'.repeat(32);

describe('cmdWatch', () => {
  it('errors with no_wallet when there is no wallet', async () => {
    fs.rmSync(path.join(tmpDir, 'wallet.json'));
    try {
      await cmdWatch(makeCtx(), {}, new MockChainProvider(), 1);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).errorCode).toBe('no_wallet');
    }
  });

  it('rejects a non-numeric --interval with exit 2', async () => {
    try {
      await cmdWatch(makeCtx(), { interval: 'fast' }, new MockChainProvider(), 1);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });

  it('baselines pre-existing funds silently, then reports new payments as NDJSON', async () => {
    const provider = scriptedProvider([
      [{ txid: 'ee'.repeat(32), vout: 0, satoshis: 99_999, height: 800_000 }], // pre-existing
      [
        { txid: 'ee'.repeat(32), vout: 0, satoshis: 99_999, height: 800_000 },
        { txid: TXID_A, vout: 0, satoshis: 4_200, height: 0 }, // new, unconfirmed
      ],
    ]);
    const lines = stdoutLines();
    await cmdWatch(makeCtx(), {}, provider, 2);

    const events = lines.map((l) => JSON.parse(l));
    const payments = events.filter((e) => e.event === 'payment');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      status: 'pending',
      address: addr,
      txid: TXID_A,
      amount_sats: 4200,
      memo: 'invoice-42',
      session_total_sats: 4200,
    });
    // every stdout line is valid JSON (NDJSON discipline)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('emits a confirmed event when a pending payment confirms', async () => {
    const provider = scriptedProvider([
      [],
      [{ txid: TXID_A, vout: 0, satoshis: 4_200, height: 0 }],
      [{ txid: TXID_A, vout: 0, satoshis: 4_200, height: 800_001 }],
    ]);
    const lines = stdoutLines();
    await cmdWatch(makeCtx(), {}, provider, 3);

    const events = lines.map((l) => JSON.parse(l));
    expect(events.filter((e) => e.event === 'payment')).toHaveLength(1);
    const confirmed = events.filter((e) => e.event === 'confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].txid).toBe(TXID_A);
  });

  it('appends one ledger receive per payment (deduped across cycles)', async () => {
    const provider = scriptedProvider([
      [],
      [{ txid: TXID_A, vout: 0, satoshis: 4_200, height: 0 }],
      [{ txid: TXID_A, vout: 0, satoshis: 4_200, height: 800_001 }],
    ]);
    stdoutLines();
    await cmdWatch(makeCtx(), {}, provider, 3);
    const receives = readLedger('main').filter((e) => e.type === 'receive');
    expect(receives).toHaveLength(1);
    expect(receives[0]).toMatchObject({ txid: TXID_A, amount_sats: 4200, memo: 'invoice-42' });
  });

  it('survives provider failures by backing off instead of crashing', async () => {
    const provider = new MockChainProvider();
    let call = -1;
    provider.getUtxos = async () => {
      call += 1;
      if (call === 1) throw new Error('429 rate limited');
      if (call >= 2) return [{ txid: TXID_A, vout: 0, satoshis: 1_000, height: 0 }];
      return [];
    };
    const lines = stdoutLines();
    await cmdWatch(makeCtx(), {}, provider, 3);
    const payments = lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'payment');
    expect(payments).toHaveLength(1); // detected after the failed cycle
  });

  it('emits a final watch_stopped event with the session total', async () => {
    const provider = scriptedProvider([
      [],
      [{ txid: TXID_A, vout: 0, satoshis: 2_500, height: 0 }],
    ]);
    const lines = stdoutLines();
    await cmdWatch(makeCtx(), {}, provider, 2);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last).toEqual({ event: 'watch_stopped', session_total_sats: 2500 });
  });
});
