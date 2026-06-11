import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import { openWallet, paidFetch, type CoreWallet } from '../src/core/index.js';
import { EXIT, type CliError } from '../src/errors.js';
import { transactionPays } from '../src/http402/protocol.js';
import { readLedger } from '../src/ledger.js';
import { policyPath } from '../src/paths.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * paidFetch: the 402 payer. The invariants under test — a free resource
 * never spends; the spend goes through the policy gate (denials/queues
 * propagate, decisions ledger); max-price caps before the gate; unusable
 * terms are refused BEFORE paying; and a post-payment refusal surfaces
 * exit 10 with the txid (money moved, never silently).
 */

let tmpDir: string;
let walletAddr: string;
let wallet: CoreWallet;
const SELLER = PrivateKey.fromRandom().toAddress();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-402-'));
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

interface Paywall {
  url: string;
  requests: Array<{ paymentHeader?: string }>;
  close(): void;
}

/** Minimal BRC-105-shaped paywall; `terms` headers can be overridden per test. */
async function startPaywall(
  priceSats: number,
  options: { termsOverride?: Record<string, string>; acceptPayment?: boolean } = {},
): Promise<Paywall> {
  const requests: Paywall['requests'] = [];
  const server = http.createServer((req, res) => {
    const paymentHeader = req.headers['x-bsv-payment'] as string | undefined;
    requests.push({ paymentHeader });
    if (!paymentHeader || options.acceptPayment === false) {
      res.writeHead(402, {
        'x-bsv-payment-version': '1.0',
        'x-bsv-payment-satoshis-required': String(priceSats),
        'x-bsv-payment-derivation-prefix': 'unit-prefix',
        'x-bsv-payment-address': SELLER,
        ...options.termsOverride,
      });
      res.end('{"error":"payment_required"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":"the goods"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/resource`, requests, close: () => server.close() };
}

async function thrown(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected paidFetch to throw');
}

describe('paidFetch', () => {
  it('a free resource returns paid:false and spends nothing', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('no paywall here');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const provider = fundedProvider();
    try {
      const result = await paidFetch(
        wallet,
        { network: 'main', provider },
        { url: `http://127.0.0.1:${port}/free` },
      );
      expect(result).toMatchObject({ status: 200, paid: false, body: 'no paywall here' });
      expect(result.payment).toBeUndefined();
      expect(provider.broadcasts).toHaveLength(0);
      expect(readLedger('main')).toHaveLength(1); // only the address_issued from setup
    } finally {
      server.close();
    }
  });

  it('pays a 402 within policy: gate-ledgered spend, envelope presented, content returned', async () => {
    const paywall = await startPaywall(4_000);
    const provider = fundedProvider();
    try {
      const result = await paidFetch(
        wallet,
        { network: 'main', provider },
        { url: paywall.url, maxPriceSats: 5_000 },
      );
      expect(result).toMatchObject({ status: 200, paid: true, body: '{"data":"the goods"}' });
      expect(result.payment).toMatchObject({
        amountSats: 4_000,
        address: SELLER,
        derivationPrefix: 'unit-prefix',
      });
      expect(provider.broadcasts).toHaveLength(1);

      // the retry presented a parseable envelope whose tx pays the seller
      const envelope = JSON.parse(paywall.requests[1]!.paymentHeader!) as {
        derivationPrefix: string;
        txid: string;
        transaction: string;
      };
      expect(envelope.derivationPrefix).toBe('unit-prefix');
      expect(envelope.txid).toBe(result.payment!.txid);
      expect(transactionPays(envelope.transaction, SELLER, 4_000, 'main')).toBe(true);

      const ledger = readLedger('main');
      expect(ledger.some((e) => e.type === 'send' && e.amount_sats === 4_000)).toBe(true);
      expect(ledger.some((e) => e.type === 'policy_decision' && e.decision === 'allow')).toBe(true);
      const memo = ledger.find((e) => e.type === 'send')!.memo;
      expect(memo).toContain('402 http://127.0.0.1');
    } finally {
      paywall.close();
    }
  });

  it('max-price caps before the gate: no spend, no decision, nothing ledgered', async () => {
    const paywall = await startPaywall(4_000);
    const provider = fundedProvider();
    try {
      const err = await thrown(
        paidFetch(wallet, { network: 'main', provider }, { url: paywall.url, maxPriceSats: 999 }),
      );
      expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
      expect(err.errorCode).toBe('max_price_exceeded');
      expect(err.data).toMatchObject({ price_sats: 4_000, max_price_sats: 999 });
      expect(provider.broadcasts).toHaveLength(0);
      expect(paywall.requests).toHaveLength(1); // never retried
      expect(readLedger('main').some((e) => e.type === 'policy_decision')).toBe(false);
    } finally {
      paywall.close();
    }
  });

  it('policy denial propagates with its ledgered deny; no HTTP retry happens', async () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 1000');
    const paywall = await startPaywall(4_000);
    const provider = fundedProvider();
    try {
      const err = await thrown(
        paidFetch(wallet, { network: 'main', provider }, { url: paywall.url }),
      );
      expect(err.errorCode).toBe('daily_budget_exceeded');
      expect(provider.broadcasts).toHaveLength(0);
      expect(paywall.requests).toHaveLength(1);
      expect(
        readLedger('main').some((e) => e.type === 'policy_decision' && e.decision === 'deny'),
      ).toBe(true);
    } finally {
      paywall.close();
    }
  });

  it('a 402 price at/above the approval threshold queues (exit 9), fetch fails cleanly', async () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 3000');
    const paywall = await startPaywall(4_000);
    const provider = fundedProvider();
    try {
      const err = await thrown(
        paidFetch(wallet, { network: 'main', provider }, { url: paywall.url }),
      );
      expect(err.exitCode).toBe(EXIT.PENDING_APPROVAL);
      expect(typeof (err.data as { approval_id?: string }).approval_id).toBe('string');
      expect(provider.broadcasts).toHaveLength(0);
    } finally {
      paywall.close();
    }
  });

  it('unsupported version / wrong-network address: refused BEFORE paying (exit 4)', async () => {
    const provider = fundedProvider();
    for (const termsOverride of [
      { 'x-bsv-payment-version': '2.0' },
      { 'x-bsv-payment-address': PrivateKey.fromRandom().toAddress('testnet') },
      { 'x-bsv-payment-satoshis-required': 'not-a-number' },
    ]) {
      const paywall = await startPaywall(4_000, { termsOverride });
      try {
        const err = await thrown(
          paidFetch(wallet, { network: 'main', provider }, { url: paywall.url }),
        );
        expect(err.exitCode).toBe(EXIT.NETWORK);
        expect(err.errorCode).toBe('invalid_payment_terms');
      } finally {
        paywall.close();
      }
    }
    expect(provider.broadcasts).toHaveLength(0);
    expect(readLedger('main').some((e) => e.type === 'send')).toBe(false);
  });

  it('server refuses after payment: exit 10 with the txid; the spend IS ledgered', async () => {
    const paywall = await startPaywall(4_000, { acceptPayment: false });
    const provider = fundedProvider();
    try {
      const err = await thrown(
        paidFetch(wallet, { network: 'main', provider }, { url: paywall.url }),
      );
      expect(err.exitCode).toBe(EXIT.PAYMENT_NOT_REDEEMED);
      expect(err.errorCode).toBe('payment_not_redeemed');
      const data = err.data as { txid: string; amount_sats: number };
      expect(data.amount_sats).toBe(4_000);
      expect(provider.broadcasts).toHaveLength(1); // the money really moved
      expect(readLedger('main').some((e) => e.type === 'send' && e.txid === data.txid)).toBe(true);
    } finally {
      paywall.close();
    }
  });

  it('rejects non-http URLs and unreachable hosts without spending', async () => {
    const provider = fundedProvider();
    const bad = await thrown(
      paidFetch(wallet, { network: 'main', provider }, { url: 'ftp://nope' }),
    );
    expect(bad.errorCode).toBe('invalid_url');
    const dead = await thrown(
      paidFetch(wallet, { network: 'main', provider }, { url: 'http://127.0.0.1:1/x' }),
    );
    expect(dead.exitCode).toBe(EXIT.NETWORK);
    expect(provider.broadcasts).toHaveLength(0);
  });
});
