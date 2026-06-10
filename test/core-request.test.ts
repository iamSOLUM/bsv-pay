import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic } from '@bsv/sdk';
import {
  openWallet,
  createRequest,
  awaitPayment,
  EXIT,
  type BsvPayError,
  type CoreWallet,
} from '../src/core/index.js';
import { buildWalletFile, writeWalletFile } from '../src/wallet/wallet.js';
import { readLedger, trackedAddressesFromLedger } from '../src/ledger.js';
import type { Utxo } from '../src/chain/provider.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;
let wallet: CoreWallet;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-core-req-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
  wallet = await openWallet({ network: 'main' });
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('createRequest', () => {
  it('issues a fresh tracked address per request with a BIP-21 URI', () => {
    const first = createRequest(wallet, { amountSats: 10_000, memo: 'coffee' });
    const second = createRequest(wallet, { amountSats: 10_000 });

    expect(first.address).not.toBe(second.address);
    expect(first.uri).toBe(`bitcoin:${first.address}?sv&amount=0.0001&label=coffee`);
    expect(first.network).toBe('main');
    expect(trackedAddressesFromLedger('main')).toEqual(
      expect.arrayContaining([first.address, second.address]),
    );
    const issued = readLedger('main').filter(
      (e) => e.type === 'address_issued' && e.purpose === 'request',
    );
    expect(issued).toHaveLength(2);
  });

  it('rejects non-positive or fractional amounts with code 2', () => {
    for (const amountSats of [0, -5, 10.5]) {
      try {
        createRequest(wallet, { amountSats });
        expect.unreachable();
      } catch (e) {
        expect((e as BsvPayError).exitCode).toBe(EXIT.USAGE);
        expect((e as BsvPayError).errorCode).toBe('invalid_amount');
      }
    }
  });
});

describe('awaitPayment', () => {
  it('resolves on the first incoming payment and appends the receive entry', async () => {
    const provider = new MockChainProvider();
    const request = createRequest(wallet, { amountSats: 5_000, memo: 'pay me' });
    let polls = 0;
    provider.getUtxos = async (): Promise<Utxo[]> => {
      polls += 1;
      if (polls >= 2) return [{ txid: 'ef'.repeat(32), vout: 0, satoshis: 4_900, height: 0 }];
      return [];
    };

    const paid = await awaitPayment(
      { network: 'main', provider },
      { address: request.address, timeoutMs: 600_000, pollIntervalMs: 1, memo: 'pay me' },
    );
    expect(paid).toEqual({
      address: request.address,
      txid: 'ef'.repeat(32),
      receivedSats: 4_900,
      confirmed: false,
    });

    const receives = readLedger('main').filter((e) => e.type === 'receive');
    expect(receives).toHaveLength(1);
    expect(receives[0]).toMatchObject({
      address: request.address,
      amount_sats: 4_900,
      memo: 'pay me',
      status: 'pending',
    });
  });

  it('reports confirmed payments as confirmed', async () => {
    const provider = new MockChainProvider();
    const request = createRequest(wallet, { amountSats: 5_000 });
    provider.utxos.set(request.address, [
      { txid: 'ab'.repeat(32), vout: 0, satoshis: 5_000, height: 800_000 },
    ]);
    const paid = await awaitPayment(
      { network: 'main', provider },
      { address: request.address, timeoutMs: 600_000 },
    );
    expect(paid.confirmed).toBe(true);
    expect(readLedger('main').filter((e) => e.type === 'receive')[0]).toMatchObject({
      status: 'confirmed',
    });
  });

  it('survives transient provider failures and keeps polling', async () => {
    const provider = new MockChainProvider();
    const request = createRequest(wallet, { amountSats: 5_000 });
    let polls = 0;
    provider.getUtxos = async (): Promise<Utxo[]> => {
      polls += 1;
      if (polls === 1) throw new Error('rate limited');
      return [{ txid: 'cd'.repeat(32), vout: 0, satoshis: 5_000, height: 0 }];
    };
    const paid = await awaitPayment(
      { network: 'main', provider },
      { address: request.address, timeoutMs: 600_000, pollIntervalMs: 1 },
    );
    expect(paid.receivedSats).toBe(5_000);
  });

  it('throws code 4 request_timeout past the deadline, with no ledger entry', async () => {
    const provider = new MockChainProvider(); // never pays
    const request = createRequest(wallet, { amountSats: 5_000 });
    const start = Date.now();
    vi.spyOn(Date, 'now')
      .mockImplementationOnce(() => start) // deadline computation
      .mockImplementation(() => start + 700_000);
    try {
      await awaitPayment(
        { network: 'main', provider },
        { address: request.address, timeoutMs: 600_000 },
      );
      expect.unreachable();
    } catch (e) {
      expect((e as BsvPayError).exitCode).toBe(EXIT.NETWORK);
      expect((e as BsvPayError).errorCode).toBe('request_timeout');
      expect((e as BsvPayError).data).toMatchObject({ address: request.address });
    }
    expect(readLedger('main').filter((e) => e.type === 'receive')).toHaveLength(0);
  });

  it('writes nothing to stdout/stderr', async () => {
    const provider = new MockChainProvider();
    const request = createRequest(wallet, { amountSats: 5_000 });
    provider.utxos.set(request.address, [
      { txid: 'aa'.repeat(32), vout: 0, satoshis: 5_000, height: 0 },
    ]);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await awaitPayment(
      { network: 'main', provider },
      { address: request.address, timeoutMs: 600_000 },
    );
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
