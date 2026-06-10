import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic } from '@bsv/sdk';
import { openWallet, CoreWallet, EXIT, type BsvPayError } from '../src/core/index.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-core-wallet-'));
  process.env.BSV_PAY_HOME = tmpDir;
  delete process.env.BSV_PAY_PASSPHRASE;
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeEncryptedWallet(passphrase = 'core-pass'): string {
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile('main', buildWalletFile('main', { type: 'mnemonic', value: phrase }, passphrase));
  return phrase;
}

/** Fails the test if anything is written to stdout/stderr; returns the spies. */
function spyConsoleStreams(): { calls: () => number } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { calls: () => out.mock.calls.length + err.mock.calls.length };
}

async function errorOf(p: Promise<unknown>): Promise<BsvPayError> {
  try {
    await p;
    throw new Error('expected the promise to reject');
  } catch (e) {
    return e as BsvPayError;
  }
}

describe('openWallet', () => {
  it('opens with an explicit passphrase and exposes addresses only', async () => {
    writeEncryptedWallet();
    const streams = spyConsoleStreams();
    const wallet = await openWallet({ network: 'main', passphrase: 'core-pass' });

    expect(wallet).toBeInstanceOf(CoreWallet);
    expect(wallet.network).toBe('main');
    expect(wallet.isHd).toBe(true);
    expect(wallet.warnings).toEqual([]);
    // index 0 of the receive chain is always tracked
    expect(wallet.addresses().length).toBeGreaterThanOrEqual(1);
    expect(streams.calls()).toBe(0); // no console output, ever
  });

  it('accepts an async passphrase supplier', async () => {
    writeEncryptedWallet();
    const wallet = await openWallet({ network: 'main', passphrase: async () => 'core-pass' });
    expect(wallet.addresses().length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to BSV_PAY_PASSPHRASE', async () => {
    writeEncryptedWallet();
    process.env.BSV_PAY_PASSPHRASE = 'core-pass';
    const wallet = await openWallet({ network: 'main' });
    expect(wallet.isHd).toBe(true);
  });

  it('throws code 7 passphrase_required when encrypted and no passphrase, without prompting', async () => {
    writeEncryptedWallet();
    const streams = spyConsoleStreams();
    const err = await errorOf(openWallet({ network: 'main' }));
    expect(err.exitCode).toBe(EXIT.WALLET_LOCKED);
    expect(err.errorCode).toBe('passphrase_required');
    expect(streams.calls()).toBe(0);
  });

  it('throws code 7 bad_passphrase on a wrong passphrase', async () => {
    writeEncryptedWallet();
    const err = await errorOf(openWallet({ network: 'main', passphrase: 'wrong' }));
    expect(err.exitCode).toBe(EXIT.WALLET_LOCKED);
    expect(err.errorCode).toBe('bad_passphrase');
  });

  it('throws code 2 no_wallet when no wallet file exists', async () => {
    const err = await errorOf(openWallet({ network: 'main' }));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.errorCode).toBe('no_wallet');
  });

  it('collects the unencrypted warning instead of printing it', async () => {
    const phrase = Mnemonic.fromRandom().toString();
    writeWalletFile('main', buildWalletFile('main', { type: 'mnemonic', value: phrase }, null));
    const streams = spyConsoleStreams();
    const wallet = await openWallet({ network: 'main' });
    expect(wallet.warnings).toHaveLength(1);
    expect(wallet.warnings[0]).toMatch(/UNENCRYPTED/);
    expect(streams.calls()).toBe(0);
  });

  it('routes warnings to onWarning when supplied', async () => {
    const phrase = Mnemonic.fromRandom().toString();
    writeWalletFile('main', buildWalletFile('main', { type: 'mnemonic', value: phrase }, null));
    const seen: string[] = [];
    const wallet = await openWallet({ network: 'main', onWarning: (t) => seen.push(t) });
    expect(seen).toHaveLength(1);
    expect(wallet.warnings).toEqual([]);
  });

  it('exposes no key material on the CoreWallet surface or its JSON form', async () => {
    const phrase = writeEncryptedWallet();
    const wallet = await openWallet({ network: 'main', passphrase: 'core-pass' });
    const memberNames = [
      ...Object.getOwnPropertyNames(wallet),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(wallet) as object),
    ];
    for (const name of memberNames) {
      expect(name).not.toMatch(/key|priv|seed|secret|mnemonic|wif|cipher/i);
    }
    const json = JSON.stringify(wallet);
    expect(json).not.toMatch(/private|wif|seed|mnemonic/i);
    for (const word of phrase.split(' ')) expect(json).not.toContain(`"${word}"`);
  });

  it('matches the addresses the signing wallet tracks', async () => {
    writeEncryptedWallet();
    process.env.BSV_PAY_PASSPHRASE = 'core-pass';
    const signing = await Wallet.unlock('main');
    signing.issueAddress('receive', 'extra');
    const wallet = await openWallet({ network: 'main' });
    expect(wallet.addresses()).toEqual(signing.trackedAddresses().map((a) => a.address));
  });
});
