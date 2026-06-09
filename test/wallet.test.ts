import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import {
  buildWalletFile,
  readWalletFile,
  walletExists,
  writeWalletFile,
  Wallet,
} from '../src/wallet/wallet.js';
import { readLedger } from '../src/ledger.js';
import { CliError, EXIT } from '../src/errors.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-wallet-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PHRASE = Mnemonic.fromRandom().toString();

describe('wallet storage', () => {
  it('creates, persists, and unlocks an encrypted mnemonic wallet', async () => {
    const file = buildWalletFile('main', { type: 'mnemonic', value: PHRASE }, 'test-pass');
    expect(file.encrypted).toBe(true);
    expect(JSON.stringify(file)).not.toContain(PHRASE.split(' ')[0]);
    writeWalletFile('main', file);
    expect(walletExists('main')).toBe(true);

    const wallet = await Wallet.unlock('main');
    expect(wallet.isHd).toBe(true);
    expect(wallet.addressAt(0, 0)).toMatch(/^1/); // mainnet P2PKH
  });

  it('refuses to unlock with a wrong passphrase (exit 7)', async () => {
    writeWalletFile(
      'main',
      buildWalletFile('main', { type: 'mnemonic', value: PHRASE }, 'test-pass'),
    );
    process.env.BSV_PAY_PASSPHRASE = 'wrong';
    await expect(Wallet.unlock('main')).rejects.toMatchObject({ exitCode: EXIT.WALLET_LOCKED });
  });

  it('throws no_wallet with exit 2 when missing', () => {
    try {
      readWalletFile('main');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
      expect((e as CliError).errorCode).toBe('no_wallet');
    }
  });

  it('keeps testnet state separate from mainnet', async () => {
    writeWalletFile(
      'main',
      buildWalletFile('main', { type: 'mnemonic', value: PHRASE }, 'test-pass'),
    );
    expect(walletExists('test')).toBe(false);
    writeWalletFile(
      'test',
      buildWalletFile('test', { type: 'mnemonic', value: PHRASE }, 'test-pass'),
    );
    const testWallet = await Wallet.unlock('test');
    expect(testWallet.addressAt(0, 0)).toMatch(/^[mn]/); // testnet P2PKH prefix
    expect(testWallet.addressAt(0, 0)).not.toBe((await Wallet.unlock('main')).addressAt(0, 0));
  });

  it('issues fresh addresses, persists counters, and records them in the ledger', async () => {
    writeWalletFile(
      'main',
      buildWalletFile('main', { type: 'mnemonic', value: PHRASE }, 'test-pass'),
    );
    const wallet = await Wallet.unlock('main');
    const a0 = wallet.issueAddress('receive');
    const a1 = wallet.issueAddress('request', 'coffee');
    const c0 = wallet.issueAddress('change');
    expect(a0.index).toBe(0);
    expect(a1.index).toBe(1);
    expect(a0.address).not.toBe(a1.address);

    // counters persisted
    const reloaded = readWalletFile('main');
    expect(reloaded.next_receive_index).toBe(2);
    expect(reloaded.next_change_index).toBe(1);

    // ledger has all three
    const issued = readLedger('main').filter((e) => e.type === 'address_issued');
    expect(issued).toHaveLength(3);
    expect(issued.map((e) => e.address)).toContain(c0.address);

    // tracked addresses cover both chains
    const tracked = (await Wallet.unlock('main')).trackedAddresses();
    expect(tracked.map((t) => t.address)).toEqual(
      expect.arrayContaining([a0.address, a1.address, c0.address]),
    );
  });

  it('finds the signing key for any tracked address', async () => {
    writeWalletFile(
      'main',
      buildWalletFile('main', { type: 'mnemonic', value: PHRASE }, 'test-pass'),
    );
    const wallet = await Wallet.unlock('main');
    const { address } = wallet.issueAddress('receive');
    const key = wallet.privKeyForAddress(address);
    expect(key).toBeDefined();
    expect(key!.toAddress()).toBe(address);
    expect(wallet.privKeyForAddress('1BitcoinEaterAddressDontSendf59kuE')).toBeUndefined();
  });

  it('supports single-address WIF wallets', async () => {
    const wif = PrivateKey.fromRandom().toWif();
    writeWalletFile('main', buildWalletFile('main', { type: 'wif', value: wif }, 'test-pass'));
    const wallet = await Wallet.unlock('main');
    expect(wallet.isHd).toBe(false);
    const tracked = wallet.trackedAddresses();
    expect(tracked).toHaveLength(1);
    expect(wallet.issueAddress('receive').address).toBe(tracked[0]!.address);
  });

  it('never writes key material into the ledger', async () => {
    writeWalletFile(
      'main',
      buildWalletFile('main', { type: 'mnemonic', value: PHRASE }, 'test-pass'),
    );
    const wallet = await Wallet.unlock('main');
    wallet.issueAddress('receive');
    const raw = fs.readFileSync(path.join(tmpDir, 'ledger.jsonl'), 'utf8');
    for (const word of PHRASE.split(' ')) expect(raw).not.toContain(word + ' ');
  });
});
