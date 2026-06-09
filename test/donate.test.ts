import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic } from '@bsv/sdk';
import { cmdDonate } from '../src/commands/donate.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import type { Ctx } from '../src/context.js';
import { MockChainProvider } from './mock-provider.js';

let tmpDir: string;
let addr: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-donate-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = 'test-pass';
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, 'test-pass'),
  );
  addr = (await Wallet.unlock('main')).issueAddress('receive').address;
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cmdDonate', () => {
  it('dry-runs a default 10k-sat donation to the project address', async () => {
    const provider = new MockChainProvider();
    provider.utxos.set(addr, [{ txid: 'cd'.repeat(32), vout: 0, satoshis: 50_000, height: 1 }]);
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      lines.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const ctx: Ctx = {
      out: new Output(true),
      json: true,
      network: 'main',
      config: { ...DEFAULT_CONFIG },
    };
    await cmdDonate(ctx, undefined, { dryRun: true }, provider);

    const result = JSON.parse(lines.join(''));
    expect(result.dry_run).toBe(true);
    expect(result.amount_sats).toBe(10_000);
    expect(result.recipient).toBe('131CswxfV8Swi8zUSc3XfH9tEJLxzxmpa4');
    expect(provider.broadcasts).toHaveLength(0);
  });
});
