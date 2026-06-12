import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HD, Mnemonic, PrivateKey } from '@bsv/sdk';
import {
  openWallet,
  getBalance,
  getHistory,
  createRequest,
  awaitPayment,
  paidFetch,
  planSend,
  executeSend,
  send,
  type CoreWallet,
} from '../src/core/index.js';
import { CliError } from '../src/errors.js';
import { walletPath } from '../src/paths.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * Invariant 1, proven executable: serialize EVERY result and error the core
 * API can produce — success and failure paths — and assert that no form of
 * the key material (mnemonic phrase, seed bytes, extended private keys,
 * per-address private keys as WIF or hex, the passphrase, or even the
 * wallet's ciphertext) appears anywhere.
 */

const PASSPHRASE = 'sigil-PASSPHRASE-7d9f2c-very-distinctive';
const RECIPIENT = PrivateKey.fromRandom().toAddress();

let tmpDir: string;
let phrase: string;
let secrets: string[];
let walletAddr: string;
let wallet: CoreWallet;

/** Every representation of the wallet's key material we can construct. */
function buildSecrets(): string[] {
  const list = [phrase, PASSPHRASE];
  const seed = Mnemonic.fromString(phrase).toSeed();
  list.push(seed.map((b) => b.toString(16).padStart(2, '0')).join(''));
  const master = HD.fromSeed(seed);
  list.push(master.toString()); // xprv
  const account = master.derive("m/44'/236'/0'");
  list.push(account.toString());
  for (const chain of [0, 1] as const) {
    for (let index = 0; index < 4; index++) {
      const priv = account.derive(`m/${chain}/${index}`).privKey;
      list.push(priv.toWif());
      list.push(priv.toString('hex', 64));
    }
  }
  // even the encrypted blob must never surface in API output
  const file = JSON.parse(fs.readFileSync(walletPath('main'), 'utf8')) as {
    cipher?: { ciphertext: string; tag: string };
  };
  if (file.cipher) list.push(file.cipher.ciphertext, file.cipher.tag);
  return list;
}

/** Serialize a result or error, including everything an error carries. */
function ser(value: unknown): string {
  if (value instanceof Error) {
    const e = value as CliError;
    return JSON.stringify({
      name: e.name,
      message: e.message,
      stack: e.stack,
      errorCode: e.errorCode,
      exitCode: e.exitCode,
      data: e.data,
    });
  }
  return JSON.stringify(value);
}

/** Run a core call; return the serialized result or serialized thrown error. */
async function capture(fn: () => unknown): Promise<string> {
  try {
    return ser(await fn());
  } catch (e) {
    return ser(e);
  }
}

function expectClean(label: string, text: string): void {
  for (const secret of secrets) {
    expect(text, `${label} leaked key material`).not.toContain(secret);
  }
  expect(text, `${label} mentions key-like fields`).not.toMatch(/xprv|privkey|private_key/i);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-keybound-'));
  process.env.BSV_PAY_HOME = tmpDir;
  delete process.env.BSV_PAY_PASSPHRASE;
  phrase = Mnemonic.fromRandom().toString();
  writeWalletFile('main', buildWalletFile('main', { type: 'mnemonic', value: phrase }, PASSPHRASE));
  secrets = buildSecrets();
  expect(secrets.length).toBeGreaterThanOrEqual(20);
  process.env.BSV_PAY_PASSPHRASE = PASSPHRASE; // for the funding unlock only
  walletAddr = (await Wallet.unlock('main')).issueAddress('receive').address;
  delete process.env.BSV_PAY_PASSPHRASE;
  wallet = await openWallet({ network: 'main', passphrase: PASSPHRASE });
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fundedProvider(sats = 300_000): MockChainProvider {
  const provider = new MockChainProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

describe('core key boundary (invariant 1, executable proof)', () => {
  it('meta: the leak detector itself catches planted secrets', () => {
    // If these did NOT throw, every other assertion in this file would be hollow.
    expect(() => expectClean('planted', JSON.stringify({ oops: phrase }))).toThrow();
    expect(() => expectClean('planted', `prefix ${secrets[2]!} suffix`)).toThrow(); // seed hex
    expect(() => expectClean('planted', `wif: ${secrets[5]!}`)).toThrow(); // a private key WIF
    expect(() => expectClean('planted', PASSPHRASE)).toThrow();
    expect(() => expectClean('planted', 'mentions xprv somewhere')).toThrow();
  });

  it('openWallet: success, wrong passphrase, missing passphrase, no wallet', async () => {
    expectClean('openWallet result', ser(wallet));
    expectClean('openWallet warnings', JSON.stringify(wallet.warnings));
    expectClean(
      'openWallet wrong passphrase',
      await capture(() => openWallet({ network: 'main', passphrase: 'wrong' })),
    );
    expectClean(
      'openWallet missing passphrase',
      await capture(() => openWallet({ network: 'main' })),
    );
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-keybound-empty-'));
    process.env.BSV_PAY_HOME = emptyHome;
    try {
      expectClean('openWallet no wallet', await capture(() => openWallet({ network: 'main' })));
      expectClean(
        'getBalance no wallet',
        await capture(() => getBalance({ network: 'main', provider: new MockChainProvider() })),
      );
      expectClean('getHistory no wallet', await capture(() => getHistory({ network: 'main' })));
    } finally {
      process.env.BSV_PAY_HOME = tmpDir;
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('openWallet: unencrypted wallet warning text is clean', async () => {
    writeWalletFile('main', buildWalletFile('main', { type: 'mnemonic', value: phrase }, null));
    const opened = await openWallet({ network: 'main' });
    expectClean('unencrypted warnings', JSON.stringify(opened.warnings));
    expectClean('unencrypted wallet object', ser(opened));
  });

  it('getBalance and getHistory: success paths', async () => {
    const provider = fundedProvider();
    provider.balances.set(walletAddr, { confirmed: 300_000, unconfirmed: 0 });
    expectClean(
      'getBalance result',
      await capture(() => getBalance({ network: 'main', provider })),
    );
    await send(
      wallet,
      { network: 'main', provider },
      {
        to: RECIPIENT,
        amountSats: 5_000,
        memo: 'history memo',
      },
    );
    expectClean('getHistory result', await capture(() => getHistory({ network: 'main' })));
    expectClean(
      'getHistory filtered',
      await capture(() => getHistory({ network: 'main' }, { type: 'send', limit: 1 })),
    );
  });

  it('createRequest and awaitPayment: success, invalid amount, timeout', async () => {
    const request = createRequest(wallet, { amountSats: 10_000, memo: 'invoice' });
    expectClean('createRequest result', ser(request));
    expectClean(
      'createRequest invalid amount',
      await capture(() => createRequest(wallet, { amountSats: -1 })),
    );

    const provider = new MockChainProvider();
    provider.utxos.set(request.address, [
      { txid: 'ab'.repeat(32), vout: 0, satoshis: 10_000, height: 0 },
    ]);
    expectClean(
      'awaitPayment result',
      await capture(() =>
        awaitPayment(
          { network: 'main', provider },
          { address: request.address, timeoutMs: 30_000, pollIntervalMs: 1, memo: 'invoice' },
        ),
      ),
    );
    expectClean(
      'awaitPayment timeout',
      await capture(() =>
        awaitPayment(
          { network: 'main', provider: new MockChainProvider() },
          { address: createRequest(wallet, { amountSats: 1 }).address, timeoutMs: 0 },
        ),
      ),
    );
  });

  it('planSend/executeSend/send: success, dry run, and every failure path', async () => {
    const core = { network: 'main' as const, provider: fundedProvider() };
    const plan = await planSend(wallet, core, { to: RECIPIENT, amountSats: 5_000, memo: 'm' });
    expectClean('planSend result', ser(plan));
    expectClean(
      'executeSend dry run',
      await capture(() => executeSend(wallet, core, plan, { dryRun: true })),
    );
    expectClean('executeSend result', await capture(() => executeSend(wallet, core, plan)));

    expectClean(
      'planSend bad address',
      await capture(() => planSend(wallet, core, { to: 'garbage', amountSats: 1 })),
    );
    expectClean(
      'planSend bad amount',
      await capture(() => planSend(wallet, core, { to: RECIPIENT, amountSats: 1.5 })),
    );
    expectClean(
      'planSend over limit',
      await capture(() => planSend(wallet, core, { to: RECIPIENT, amountSats: 100_000 })),
    );
    expectClean(
      'planSend insufficient funds',
      await capture(() =>
        planSend(
          wallet,
          { network: 'main', provider: fundedProvider(2_000) },
          { to: RECIPIENT, amountSats: 50_000 },
        ),
      ),
    );

    const rejecting = fundedProvider();
    rejecting.broadcastResult = { ok: false, error: 'dust output' };
    expectClean(
      'send broadcast rejected',
      await capture(() =>
        send(
          wallet,
          { network: 'main', provider: rejecting },
          { to: RECIPIENT, amountSats: 5_000 },
        ),
      ),
    );
    const ambiguous = fundedProvider();
    ambiguous.broadcastError = new Error('socket reset mid-flight');
    expectClean(
      'send broadcast ambiguous',
      await capture(() =>
        send(
          wallet,
          { network: 'main', provider: ambiguous },
          { to: RECIPIENT, amountSats: 5_000 },
        ),
      ),
    );
  });

  it('paidFetch (M11): success and not-redeemed results carry no key material', async () => {
    let accept = true;
    const paywall = http.createServer((req, res) => {
      if (!req.headers['x-bsv-payment'] || !accept) {
        res.writeHead(402, {
          'x-bsv-payment-version': '1.0',
          'x-bsv-payment-satoshis-required': '2000',
          'x-bsv-payment-derivation-prefix': 'kb-prefix',
          'x-bsv-payment-address': RECIPIENT,
        });
        res.end('{"error":"payment_required"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('clean goods');
    });
    await new Promise<void>((r) => paywall.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(paywall.address() as AddressInfo).port}/x`;
    try {
      // the result includes rawTxHex via SendResult internals — must be clean
      expectClean(
        'paidFetch success',
        await capture(() =>
          paidFetch(wallet, { network: 'main', provider: fundedProvider() }, { url }),
        ),
      );
      accept = false;
      expectClean(
        'paidFetch not redeemed (exit 10, carries txid)',
        await capture(() =>
          paidFetch(wallet, { network: 'main', provider: fundedProvider() }, { url }),
        ),
      );
      expectClean(
        'paidFetch max price exceeded',
        await capture(() =>
          paidFetch(
            wallet,
            { network: 'main', provider: fundedProvider() },
            { url, maxPriceSats: 1 },
          ),
        ),
      );
    } finally {
      paywall.close();
    }
  });
});
