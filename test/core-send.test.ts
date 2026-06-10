import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic, PrivateKey, Transaction } from '@bsv/sdk';
import {
  openWallet,
  planSend,
  executeSend,
  send,
  EXIT,
  type BsvPayError,
  type CoreWallet,
} from '../src/core/index.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { readLedger } from '../src/ledger.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;
let walletAddr: string;
let wallet: CoreWallet;
const RECIPIENT = PrivateKey.fromRandom().toAddress();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-core-send-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
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

function fundedProvider(sats = 50_000): MockChainProvider {
  const provider = new MockChainProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

async function errorOf(p: Promise<unknown>): Promise<BsvPayError> {
  try {
    await p;
    throw new Error('expected the promise to reject');
  } catch (e) {
    return e as BsvPayError;
  }
}

describe('core send', () => {
  it('plans, signs, broadcasts, and records a send', async () => {
    const provider = fundedProvider();
    const core = { network: 'main' as const, provider };
    const result = await send(wallet, core, { to: RECIPIENT, amountSats: 5_000, memo: 'lunch' });

    expect(provider.broadcasts).toHaveLength(1);
    const tx = Transaction.fromHex(provider.broadcasts[0]!);
    expect(tx.id('hex')).toBe(result.txid);
    expect(tx.outputs[0]!.satoshis).toBe(5_000);
    expect(tx.outputs).toHaveLength(2); // recipient + change
    expect(result.balanceAfterSats).toBe(50_000 - 5_000 - result.feeSats);
    expect(result.dryRun).toBe(false);

    const sends = readLedger('main').filter((e) => e.type === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      amount_sats: 5_000,
      address: RECIPIENT,
      memo: 'lunch',
      status: 'pending',
      fee_sats: result.feeSats,
    });
    const change = readLedger('main').filter(
      (e) => e.type === 'address_issued' && e.purpose === 'change',
    );
    expect(change).toHaveLength(1);
  });

  it('throws code 8 at/above the spend limit unless allowAboveLimit', async () => {
    const provider = fundedProvider(300_000);
    const core = { network: 'main' as const, provider };
    const err = await errorOf(planSend(wallet, core, { to: RECIPIENT, amountSats: 100_000 }));
    expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
    expect(err.errorCode).toBe('spend_limit_exceeded');
    expect(err.data).toMatchObject({ limit_sats: 100_000, amount_sats: 100_000 });

    const plan = await planSend(wallet, core, {
      to: RECIPIENT,
      amountSats: 100_000,
      allowAboveLimit: true,
    });
    expect(plan.amountSats).toBe(100_000);
  });

  it('the spend-limit guard fires before any network call', async () => {
    const provider = fundedProvider(300_000);
    let touched = false;
    provider.getUtxos = async () => {
      touched = true;
      return [];
    };
    const core = { network: 'main' as const, provider };
    await errorOf(planSend(wallet, core, { to: RECIPIENT, amountSats: 100_000 }));
    expect(touched).toBe(false);
  });

  it('rejects bad addresses (2), bad amounts (2), and insufficient funds (3)', async () => {
    const core = { network: 'main' as const, provider: fundedProvider(2_000) };
    expect((await errorOf(planSend(wallet, core, { to: 'nope', amountSats: 1 }))).exitCode).toBe(
      EXIT.USAGE,
    );
    expect(
      (await errorOf(planSend(wallet, core, { to: RECIPIENT, amountSats: 0 }))).errorCode,
    ).toBe('invalid_amount');
    expect(
      (await errorOf(planSend(wallet, core, { to: RECIPIENT, amountSats: 10.5 }))).errorCode,
    ).toBe('invalid_amount');
    expect(
      (await errorOf(planSend(wallet, core, { to: RECIPIENT, amountSats: 50_000 }))).exitCode,
    ).toBe(EXIT.INSUFFICIENT_FUNDS);
  });

  it('dry run signs but persists nothing and broadcasts nothing', async () => {
    const provider = fundedProvider();
    const core = { network: 'main' as const, provider };
    const plan = await planSend(wallet, core, { to: RECIPIENT, amountSats: 5_000 });
    const result = await executeSend(wallet, core, plan, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(provider.broadcasts).toHaveLength(0);
    expect(readLedger('main').filter((e) => e.type === 'send')).toHaveLength(0);
    expect(
      readLedger('main').filter((e) => e.type === 'address_issued' && e.purpose === 'change'),
    ).toHaveLength(0);
  });

  it('throws code 5 on definite rejection with no ledger entry', async () => {
    const provider = fundedProvider();
    provider.broadcastResult = { ok: false, error: 'dust output' };
    const core = { network: 'main' as const, provider };
    const err = await errorOf(send(wallet, core, { to: RECIPIENT, amountSats: 5_000 }));
    expect(err.exitCode).toBe(EXIT.BROADCAST_REJECTED);
    expect(readLedger('main').filter((e) => e.type === 'send')).toHaveLength(0);
  });

  it('throws code 6 with txid on ambiguous failure; ledger says unknown', async () => {
    const provider = fundedProvider();
    provider.broadcastError = new Error('socket reset mid-flight');
    const core = { network: 'main' as const, provider };
    const err = await errorOf(send(wallet, core, { to: RECIPIENT, amountSats: 5_000 }));
    expect(err.exitCode).toBe(EXIT.BROADCAST_UNKNOWN);
    expect(err.data?.txid).toMatch(/^[0-9a-f]{64}$/);
    const sends = readLedger('main').filter((e) => e.type === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ status: 'unknown' });
  });

  it('writes nothing to stdout/stderr and leaks no key material in results', async () => {
    const provider = fundedProvider();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errStream = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const core = { network: 'main' as const, provider };
    const result = await send(wallet, core, { to: RECIPIENT, amountSats: 5_000 });
    expect(out).not.toHaveBeenCalled();
    expect(errStream).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private|wif|seed|mnemonic/i);
  });
});
