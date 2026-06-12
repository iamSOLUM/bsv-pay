import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mnemonic, Transaction, Utils } from '@bsv/sdk';
import { openWallet, paidFetch, requirePayment, type CoreWallet } from '../src/core/index.js';
import { EXIT, type CliError } from '../src/errors.js';
import { HEADER } from '../src/http402/protocol.js';
import { readLedger } from '../src/ledger.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * requirePayment: the 402 seller. Buyer and seller share one wallet and
 * one chain view here (paying yourself is fine at unit level; the e2e
 * runs true two-instance separation). The seller-side invariants: a fresh
 * quote address per 402; structural rejection of envelopes that don't pay
 * the quote; on-chain confirmation before serving; the receive ledgered;
 * a quote redeemable exactly once, even concurrently.
 */

let tmpDir: string;
let walletAddr: string;
let wallet: CoreWallet;

/** MockChainProvider whose broadcasts settle into the UTXO map (like a real mempool). */
class SettlingProvider extends MockChainProvider {
  override async broadcast(rawTxHex: string): ReturnType<MockChainProvider['broadcast']> {
    const result = await super.broadcast(rawTxHex);
    const tx = Transaction.fromHex(rawTxHex);
    const txid = tx.id('hex');
    tx.outputs.forEach((out, vout) => {
      const m = /^76a914([0-9a-f]{40})88ac$/.exec(out.lockingScript.toHex());
      if (!m) return;
      const bytes = m[1]!.match(/../g)!.map((b) => parseInt(b, 16));
      const address = Utils.toBase58Check(bytes, [0x00]);
      const rows = this.utxos.get(address) ?? [];
      rows.push({ txid, vout, satoshis: out.satoshis ?? 0, height: 0 });
      this.utxos.set(address, rows);
    });
    return result;
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-402-mw-'));
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

function fundedProvider(sats = 200_000): SettlingProvider {
  const provider = new SettlingProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

interface Paywall {
  url: string;
  served: number;
  close(): void;
}

async function startPaywall(
  provider: MockChainProvider,
  priceSats: number,
  middlewareOpts: { quoteTtlMs?: number; confirmTimeoutMs?: number } = {},
): Promise<Paywall> {
  const gate = requirePayment({
    network: 'main',
    provider,
    wallet,
    priceSats,
    confirmTimeoutMs: 5_000,
    ...middlewareOpts,
  });
  const paywall: Paywall = { url: '', served: 0, close: () => server.close() };
  const server = http.createServer((req, res) => {
    void gate(req, res, () => {
      paywall.served += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('the goods');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  paywall.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dataset`;
  return paywall;
}

describe('requirePayment', () => {
  it('quotes a 402 with valid terms and a FRESH address per quote', async () => {
    const provider = fundedProvider();
    const paywall = await startPaywall(provider, 1_500);
    try {
      const first = await fetch(paywall.url);
      const second = await fetch(paywall.url);
      expect(first.status).toBe(402);
      expect(first.headers.get(HEADER.version)).toBe('1.0');
      expect(first.headers.get(HEADER.satoshisRequired)).toBe('1500');
      const addr1 = first.headers.get(HEADER.address)!;
      const addr2 = second.headers.get(HEADER.address)!;
      expect(addr1).not.toBe(addr2); // unambiguous matching, like `request`
      expect(addr1).not.toBe(walletAddr);
      expect(first.headers.get(HEADER.derivationPrefix)).not.toBe(
        second.headers.get(HEADER.derivationPrefix),
      );
      // each quote's address is ledgered as issued (purpose: request)
      const issued = readLedger('main').filter((e) => e.type === 'address_issued');
      expect(issued.map((e) => e.address)).toEqual(expect.arrayContaining([addr1, addr2]));
    } finally {
      paywall.close();
    }
  });

  it('full loop with paidFetch: pays, confirms on-chain, serves, ledgers both sides', async () => {
    const provider = fundedProvider();
    const paywall = await startPaywall(provider, 1_500);
    try {
      const result = await paidFetch(
        wallet,
        { network: 'main', provider },
        { url: paywall.url, maxPriceSats: 2_000 },
      );
      expect(result).toMatchObject({ status: 200, paid: true, body: 'the goods' });
      expect(paywall.served).toBe(1);
      const ledger = readLedger('main');
      // buyer side: gate-authorized send; seller side: the confirmed receive
      expect(ledger.some((e) => e.type === 'send' && e.amount_sats === 1_500)).toBe(true);
      const receives = ledger.filter((e) => e.type === 'receive');
      expect(receives).toHaveLength(1);
      expect(receives[0]).toMatchObject({
        amount_sats: 1_500,
        address: result.payment!.address,
      });
      expect(receives[0]!.memo).toContain('402 sale');
    } finally {
      paywall.close();
    }
  });

  it('rejects an envelope whose transaction does not pay the quote', async () => {
    const provider = fundedProvider();
    const paywall = await startPaywall(provider, 1_500);
    try {
      const terms = await fetch(paywall.url);
      const prefix = terms.headers.get(HEADER.derivationPrefix)!;
      const retry = await fetch(paywall.url, {
        headers: {
          [HEADER.payment]: JSON.stringify({
            derivationPrefix: prefix,
            txid: 'a'.repeat(64),
            transaction: 'deadbeef', // not even a transaction
          }),
        },
      });
      expect(retry.status).toBe(402);
      expect(retry.headers.get(HEADER.error)).toBe('payment_insufficient');
      expect(readLedger('main').filter((e) => e.type === 'receive')).toHaveLength(0);
    } finally {
      paywall.close();
    }
  });

  it('rejects unknown and expired prefixes', async () => {
    const provider = fundedProvider();
    const paywall = await startPaywall(provider, 1_500, { quoteTtlMs: 1 });
    try {
      const unknown = await fetch(paywall.url, {
        headers: {
          [HEADER.payment]: JSON.stringify({
            derivationPrefix: 'never-quoted',
            txid: 'a'.repeat(64),
            transaction: '00',
          }),
        },
      });
      expect(unknown.status).toBe(402);
      expect(unknown.headers.get(HEADER.error)).toBe('unknown_or_expired_prefix');

      const terms = await fetch(paywall.url);
      await new Promise((r) => setTimeout(r, 10)); // outlive the 1 ms TTL
      const expired = await fetch(paywall.url, {
        headers: {
          [HEADER.payment]: JSON.stringify({
            derivationPrefix: terms.headers.get(HEADER.derivationPrefix),
            txid: 'a'.repeat(64),
            transaction: '00',
          }),
        },
      });
      expect(expired.status).toBe(402);
      expect(expired.headers.get(HEADER.error)).toBe('unknown_or_expired_prefix');
    } finally {
      paywall.close();
    }
  });

  it('a quote redeems exactly once: the replayed envelope gets re-quoted, one receive', async () => {
    const provider = fundedProvider();
    const paywall = await startPaywall(provider, 1_500);
    try {
      const result = await paidFetch(wallet, { network: 'main', provider }, { url: paywall.url });
      expect(result.paid).toBe(true);
      // replay the same paid envelope by hand
      const replay = await fetch(paywall.url, {
        headers: {
          [HEADER.payment]: JSON.stringify({
            derivationPrefix: result.payment!.derivationPrefix,
            txid: result.payment!.txid,
            transaction: 'replayed',
          }),
        },
      });
      expect(replay.status).toBe(402);
      expect(replay.headers.get(HEADER.error)).toBe('unknown_or_expired_prefix');
      expect(paywall.served).toBe(1);
      expect(readLedger('main').filter((e) => e.type === 'receive')).toHaveLength(1);
    } finally {
      paywall.close();
    }
  });

  it('payment never lands on-chain: 402 payment_not_found, buyer surfaces exit 10', async () => {
    // a provider that accepts broadcasts but never settles them
    const provider = new MockChainProvider();
    provider.utxos.set(walletAddr, [
      { txid: 'cd'.repeat(32), vout: 0, satoshis: 200_000, height: 800_000 },
    ]);
    const paywall = await startPaywall(provider, 1_500, { confirmTimeoutMs: 100 });
    try {
      let thrown: CliError | undefined;
      try {
        await paidFetch(wallet, { network: 'main', provider }, { url: paywall.url });
      } catch (e) {
        thrown = e as CliError;
      }
      expect(thrown?.exitCode).toBe(EXIT.PAYMENT_NOT_REDEEMED);
      expect((thrown?.data as { status: number }).status).toBe(402);
      expect(paywall.served).toBe(0);
      expect(readLedger('main').filter((e) => e.type === 'receive')).toHaveLength(0);
      // buyer's spend is still honestly ledgered
      expect(readLedger('main').some((e) => e.type === 'send')).toBe(true);
    } finally {
      paywall.close();
    }
  });
});
