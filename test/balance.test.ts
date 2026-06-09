import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic } from '@bsv/sdk';
import { cmdBalance } from '../src/commands/balance.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { CliError, EXIT } from '../src/errors.js';
import type { Ctx } from '../src/context.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-bal-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeCtx(json = true): Ctx {
  return {
    out: new Output(json),
    json,
    network: 'main',
    config: { ...DEFAULT_CONFIG },
  };
}

async function setupWallet(): Promise<{ addr0: string; addr1: string }> {
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
  const wallet = await Wallet.unlock('main');
  const addr0 = wallet.issueAddress('receive').address;
  const addr1 = wallet.issueAddress('receive').address;
  return { addr0, addr1 };
}

function capturedStdout(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe('cmdBalance', () => {
  it('sums confirmed and unconfirmed across tracked addresses (json)', async () => {
    const { addr0, addr1 } = await setupWallet();
    const provider = new MockChainProvider();
    provider.balances.set(addr0, { confirmed: 7000, unconfirmed: 0 });
    provider.balances.set(addr1, { confirmed: 1000, unconfirmed: 250 });

    const lines = capturedStdout();
    await cmdBalance(makeCtx(), provider);

    const obj = JSON.parse(lines.join(''));
    expect(obj.ok).toBe(true);
    expect(obj.confirmed_sats).toBe(8000);
    expect(obj.unconfirmed_sats).toBe(250);
    expect(obj.addresses).toHaveLength(2);
    expect(obj.addresses[0]).toEqual({ address: addr0, confirmed_sats: 7000, unconfirmed_sats: 0 });
  });

  it('errors with no_wallet (exit 2) when no wallet exists', async () => {
    await expect(cmdBalance(makeCtx(), new MockChainProvider())).rejects.toMatchObject({
      exitCode: EXIT.USAGE,
      errorCode: 'no_wallet',
    });
  });

  it('propagates provider failures as CliError exit 4', async () => {
    await setupWallet();
    const provider = new MockChainProvider();
    provider.getBalance = async () => {
      const { networkError } = await import('../src/errors.js');
      throw networkError('boom');
    };
    await expect(cmdBalance(makeCtx(), provider)).rejects.toMatchObject({
      exitCode: EXIT.NETWORK,
    });
  });

  it('does not need a passphrase (reads addresses from the ledger)', async () => {
    const { addr0 } = await setupWallet();
    delete process.env.BSV_PAY_PASSPHRASE; // locked wallet, non-interactive
    const provider = new MockChainProvider();
    provider.balances.set(addr0, { confirmed: 42, unconfirmed: 0 });
    const lines = capturedStdout();
    await cmdBalance(makeCtx(), provider);
    expect(JSON.parse(lines.join('')).confirmed_sats).toBe(42);
  });
});

describe('CliError network mapping', () => {
  it('networkError maps to exit 4 / network_error', async () => {
    const { networkError } = await import('../src/errors.js');
    const e = networkError('x');
    expect(e).toBeInstanceOf(CliError);
    expect(e.exitCode).toBe(4);
    expect(e.errorCode).toBe('network_error');
  });
});
