import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic, PrivateKey, Transaction } from '@bsv/sdk';
import { cmdSend } from '../src/commands/send.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { readLedger } from '../src/ledger.js';
import { EXIT, networkError, type CliError } from '../src/errors.js';
import type { Ctx } from '../src/context.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;
let walletAddr: string;
const RECIPIENT = PrivateKey.fromRandom().toAddress();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-send-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
  walletAddr = (await Wallet.unlock('main')).issueAddress('receive').address;
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeCtx(): Ctx {
  return { out: new Output(true), json: true, network: 'main', config: { ...DEFAULT_CONFIG } };
}

function fundedProvider(sats = 50_000, height: number | null = 800_000): MockChainProvider {
  const provider = new MockChainProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: height ?? undefined },
  ]);
  return provider;
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

async function exitCodeOf(p: Promise<unknown>): Promise<{ exit?: number; code?: string }> {
  try {
    await p;
    return {};
  } catch (e) {
    return { exit: (e as CliError).exitCode, code: (e as CliError).errorCode };
  }
}

describe('cmdSend', () => {
  it('builds, broadcasts, and records a valid send (--yes)', async () => {
    const provider = fundedProvider();
    const lines = jsonOut();
    await cmdSend(makeCtx(), RECIPIENT, '5000', 'lunch', { yes: true }, provider);

    expect(provider.broadcasts).toHaveLength(1);
    const tx = Transaction.fromHex(provider.broadcasts[0]!);
    expect(tx.outputs[0]!.satoshis).toBe(5000);
    expect(tx.outputs).toHaveLength(2); // recipient + change

    const result = JSON.parse(lines.join(''));
    expect(result.ok).toBe(true);
    expect(result.txid).toBe(tx.id('hex'));
    expect(result.amount_sats).toBe(5000);
    expect(result.fee_sats).toBeGreaterThan(0);
    expect(result.balance_after_sats).toBe(50_000 - 5000 - result.fee_sats);

    const sends = readLedger('main').filter((e) => e.type === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      amount_sats: 5000,
      address: RECIPIENT,
      memo: 'lunch',
      status: 'pending',
    });

    // change address was issued and tracked
    const issued = readLedger('main').filter(
      (e) => e.type === 'address_issued' && e.purpose === 'change',
    );
    expect(issued).toHaveLength(1);
  });

  it('accepts sats and bsv suffixes', async () => {
    const provider = fundedProvider();
    jsonOut();
    await cmdSend(makeCtx(), RECIPIENT, '0.0001bsv', undefined, { yes: true }, provider);
    const tx = Transaction.fromHex(provider.broadcasts[0]!);
    expect(tx.outputs[0]!.satoshis).toBe(10_000);
  });

  it('rejects a bad address with exit 2 before any network call', async () => {
    const provider = fundedProvider();
    let touched = false;
    provider.getUtxos = async () => {
      touched = true;
      return [];
    };
    jsonOut();
    const r = await exitCodeOf(
      cmdSend(makeCtx(), 'notanaddress', '5000', undefined, { yes: true }, provider),
    );
    expect(r.exit).toBe(EXIT.USAGE);
    expect(touched).toBe(false);
  });

  it('rejects an unparseable amount with exit 2', async () => {
    jsonOut();
    const r = await exitCodeOf(
      cmdSend(makeCtx(), RECIPIENT, '5,000', undefined, { yes: true }, fundedProvider()),
    );
    expect(r).toEqual({ exit: EXIT.USAGE, code: 'invalid_amount' });
  });

  it('exits 3 on insufficient funds', async () => {
    jsonOut();
    const r = await exitCodeOf(
      cmdSend(
        makeCtx(),
        RECIPIENT,
        '100000',
        undefined,
        { yes: true, allowLarge: true },
        fundedProvider(2_000),
      ),
    );
    expect(r).toEqual({ exit: EXIT.INSUFFICIENT_FUNDS, code: 'insufficient_funds' });
  });

  it('exits 8 when --yes hits the spend limit without --allow-large', async () => {
    jsonOut();
    const r = await exitCodeOf(
      cmdSend(makeCtx(), RECIPIENT, '100000', undefined, { yes: true }, fundedProvider(200_000)),
    );
    expect(r).toEqual({ exit: EXIT.SPEND_LIMIT, code: 'spend_limit_exceeded' });
  });

  it('allows at-limit sends with --yes --allow-large', async () => {
    const provider = fundedProvider(200_000);
    jsonOut();
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

  it('exits 5 when the network rejects the broadcast and records nothing as sent', async () => {
    const provider = fundedProvider();
    provider.broadcastResult = { ok: false, error: 'dust output' };
    jsonOut();
    const r = await exitCodeOf(
      cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { yes: true }, provider),
    );
    expect(r).toEqual({ exit: EXIT.BROADCAST_REJECTED, code: 'broadcast_rejected' });
    expect(readLedger('main').filter((e) => e.type === 'send')).toHaveLength(0);
  });

  it('exits 6 with the txid when broadcast fails ambiguously, ledger says unknown', async () => {
    const provider = fundedProvider();
    provider.broadcastError = networkError('socket reset mid-flight');
    jsonOut();
    try {
      await cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { yes: true }, provider);
      expect.unreachable();
    } catch (e) {
      const err = e as CliError;
      expect(err.exitCode).toBe(EXIT.BROADCAST_UNKNOWN);
      expect(err.data?.txid).toMatch(/^[0-9a-f]{64}$/);
    }
    const sends = readLedger('main').filter((e) => e.type === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ status: 'unknown' });
  });

  it('--dry-run builds but never broadcasts, persists nothing', async () => {
    const provider = fundedProvider();
    const lines = jsonOut();
    await cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { dryRun: true }, provider);
    expect(provider.broadcasts).toHaveLength(0);
    const result = JSON.parse(lines.join(''));
    expect(result.dry_run).toBe(true);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(readLedger('main').filter((e) => e.type === 'send')).toHaveLength(0);
    expect(
      readLedger('main').filter((e) => e.type === 'address_issued' && e.purpose === 'change'),
    ).toHaveLength(0);
  });

  it('--confirmed-only refuses to spend unconfirmed UTXOs', async () => {
    const provider = fundedProvider(50_000, null); // unconfirmed
    jsonOut();
    const r = await exitCodeOf(
      cmdSend(
        makeCtx(),
        RECIPIENT,
        '5000',
        undefined,
        { yes: true, confirmedOnly: true },
        provider,
      ),
    );
    expect(r.exit).toBe(EXIT.INSUFFICIENT_FUNDS);
    // without the flag the same UTXO is spendable
    await cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { yes: true }, provider);
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('requires a confirmation route: non-interactive without --yes exits 2', async () => {
    jsonOut();
    const r = await exitCodeOf(
      cmdSend(makeCtx(), RECIPIENT, '5000', undefined, {}, fundedProvider()),
    );
    expect(r).toEqual({ exit: EXIT.USAGE, code: 'confirmation_required' });
  });

  it('rejects a testnet recipient on mainnet with exit 2', async () => {
    jsonOut();
    const testAddr = PrivateKey.fromRandom().toAddress('testnet');
    const r = await exitCodeOf(
      cmdSend(makeCtx(), testAddr, '5000', undefined, { yes: true }, fundedProvider()),
    );
    expect(r).toEqual({ exit: EXIT.USAGE, code: 'wrong_network_address' });
  });

  it('never leaks key material in JSON output', async () => {
    const provider = fundedProvider();
    const lines = jsonOut();
    await cmdSend(makeCtx(), RECIPIENT, '5000', undefined, { yes: true }, provider);
    const joined = lines.join('');
    expect(joined).not.toMatch(/private|wif|seed|mnemonic/i);
  });
});
