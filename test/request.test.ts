import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic } from '@bsv/sdk';
import { buildPaymentUri, cmdRequest } from '../src/commands/request.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildWalletFile, writeWalletFile } from '../src/wallet/wallet.js';
import { readLedger, trackedAddressesFromLedger } from '../src/ledger.js';
import { EXIT, type CliError } from '../src/errors.js';
import type { Ctx } from '../src/context.js';
import type { Utxo } from '../src/chain/provider.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-req-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeCtx(): Ctx {
  const config = { ...DEFAULT_CONFIG, pollIntervalSecs: 5 };
  return { out: new Output(true), json: true, network: 'main', config };
}

function jsonLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    lines.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return lines;
}

describe('buildPaymentUri', () => {
  it('builds a BIP-21 URI with sv flag and BSV amount', () => {
    expect(buildPaymentUri('1abc', 10_000)).toBe('bitcoin:1abc?sv&amount=0.0001');
  });

  it('URL-encodes the label', () => {
    expect(buildPaymentUri('1abc', 1, 'two words & more')).toBe(
      'bitcoin:1abc?sv&amount=0.00000001&label=two%20words%20%26%20more',
    );
  });
});

describe('cmdRequest', () => {
  it('issues a fresh address per request and tracks it', async () => {
    const lines = jsonLines();
    await cmdRequest(makeCtx(), '5000', 'coffee', {}, new MockChainProvider());
    await cmdRequest(makeCtx(), '5000', 'tea', {}, new MockChainProvider());

    const objs = lines.map((l) => JSON.parse(l));
    expect(objs[0].address).not.toBe(objs[1].address);
    expect(objs[0].uri).toContain(objs[0].address);
    expect(objs[0].amount_sats).toBe(5000);
    expect(trackedAddressesFromLedger('main')).toContain(objs[0].address);
  });

  it('rejects bad amounts with exit 2', async () => {
    jsonLines();
    try {
      await cmdRequest(makeCtx(), 'lots', undefined, {}, new MockChainProvider());
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });

  it('rejects a non-numeric --timeout with exit 2', async () => {
    jsonLines();
    try {
      await cmdRequest(
        makeCtx(),
        '5000',
        undefined,
        { wait: true, timeout: 'soon' },
        new MockChainProvider(),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).errorCode).toBe('invalid_timeout');
    }
  });

  it('--wait resolves when a payment lands, appends a receive to the ledger', async () => {
    const provider = new MockChainProvider();
    // pay the request address on the second poll
    let polls = 0;
    let requestAddress = '';
    provider.getUtxos = async (address: string): Promise<Utxo[]> => {
      requestAddress = address;
      polls += 1;
      if (polls >= 2) return [{ txid: 'ef'.repeat(32), vout: 0, satoshis: 4900, height: 0 }];
      return [];
    };

    const ctx = makeCtx();
    ctx.config.pollIntervalSecs = 5; // floor; loop uses ms so this is fine for mock
    const lines = jsonLines();

    // shrink the poll interval via fake timers? simpler: patch config to 5s but
    // make the first poll hit immediately and the second after one sleep.
    const t0 = Date.now();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    await cmdRequest(ctx, '5000', 'pay me', { wait: true, timeout: '600' }, provider);
    expect(Date.now() - t0).toBeLessThan(5000);

    const objs = lines.map((l) => JSON.parse(l));
    expect(objs[0].event).toBe('request_created');
    const done = objs[objs.length - 1];
    expect(done.event).toBe('payment_received');
    expect(done.txid).toBe('ef'.repeat(32));
    expect(done.received_sats).toBe(4900);
    expect(done.status).toBe('pending');

    const receives = readLedger('main').filter((e) => e.type === 'receive');
    expect(receives).toHaveLength(1);
    expect(receives[0]).toMatchObject({
      address: requestAddress,
      amount_sats: 4900,
      memo: 'pay me',
      status: 'pending',
    });
  });

  it('--wait times out with exit 4 and request_timeout', async () => {
    const provider = new MockChainProvider(); // never pays
    jsonLines();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    const start = Date.now();
    vi.spyOn(Date, 'now')
      .mockImplementationOnce(() => start) // deadline computation
      .mockImplementation(() => start + 700_000); // any later check: past deadline
    try {
      await cmdRequest(makeCtx(), '5000', undefined, { wait: true, timeout: '600' }, provider);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.NETWORK);
      expect((e as CliError).errorCode).toBe('request_timeout');
    }
  });
});
