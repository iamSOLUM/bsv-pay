import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic } from '@bsv/sdk';
import { getBalance, getHistory, EXIT, type BsvPayError } from '../src/core/index.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { appendLedger } from '../src/ledger.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;
let addrA: string;
let addrB: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-core-bal-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
  const wallet = await Wallet.unlock('main');
  addrA = wallet.issueAddress('receive').address;
  addrB = wallet.issueAddress('request', 'invoice').address;
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('getBalance', () => {
  it('aggregates confirmed and unconfirmed across all ledger-tracked addresses', async () => {
    const provider = new MockChainProvider();
    provider.balances.set(addrA, { confirmed: 7_000, unconfirmed: 500 });
    provider.balances.set(addrB, { confirmed: 0, unconfirmed: 2_500 });

    const result = await getBalance({ network: 'main', provider });
    expect(result.confirmedSats).toBe(7_000);
    expect(result.unconfirmedSats).toBe(3_000);
    expect(result.addresses).toEqual([
      { address: addrA, confirmedSats: 7_000, unconfirmedSats: 500 },
      { address: addrB, confirmedSats: 0, unconfirmedSats: 2_500 },
    ]);
  });

  it('throws code 2 no_wallet when no wallet exists', async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      await getBalance({ network: 'main', provider: new MockChainProvider() });
      expect.unreachable();
    } catch (e) {
      expect((e as BsvPayError).exitCode).toBe(EXIT.USAGE);
      expect((e as BsvPayError).errorCode).toBe('no_wallet');
    }
  });

  it('writes nothing to stdout or stderr', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await getBalance({ network: 'main', provider: new MockChainProvider() });
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});

describe('getHistory', () => {
  function seedMovements(): void {
    appendLedger('main', {
      type: 'receive',
      txid: 'aa'.repeat(32),
      amount_sats: 10_000,
      address: addrA,
      timestamp: '2026-06-01T00:00:00.000Z',
      status: 'confirmed',
    });
    appendLedger('main', {
      type: 'send',
      txid: 'bb'.repeat(32),
      amount_sats: 4_000,
      address: 'somewhere',
      memo: 'lunch',
      timestamp: '2026-06-02T00:00:00.000Z',
      status: 'pending',
      fee_sats: 2,
    });
    appendLedger('main', {
      type: 'receive',
      txid: 'cc'.repeat(32),
      amount_sats: 1_500,
      address: addrB,
      timestamp: '2026-06-03T00:00:00.000Z',
      status: 'pending',
    });
  }

  it('returns money movements only, newest first', () => {
    seedMovements();
    const history = getHistory({ network: 'main' });
    expect(history.map((e) => e.txid)).toEqual(['cc'.repeat(32), 'bb'.repeat(32), 'aa'.repeat(32)]);
    // address_issued entries (from beforeEach) are excluded
    expect(history.every((e) => e.type === 'send' || e.type === 'receive')).toBe(true);
  });

  it('applies type filter then limit', () => {
    seedMovements();
    const receives = getHistory({ network: 'main' }, { type: 'receive' });
    expect(receives.map((e) => e.txid)).toEqual(['cc'.repeat(32), 'aa'.repeat(32)]);
    const limited = getHistory({ network: 'main' }, { type: 'receive', limit: 1 });
    expect(limited.map((e) => e.txid)).toEqual(['cc'.repeat(32)]);
  });

  it('returns [] for a wallet with no movements and throws no_wallet without a wallet', () => {
    expect(getHistory({ network: 'main' })).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      getHistory({ network: 'main' });
      expect.unreachable();
    } catch (e) {
      expect((e as BsvPayError).errorCode).toBe('no_wallet');
    }
  });
});
