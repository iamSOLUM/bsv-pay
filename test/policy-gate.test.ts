import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Mnemonic, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import { cmdSend } from '../src/commands/send.js';
import { cmdDonate } from '../src/commands/donate.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { openWallet, planSend, executeSend, send, type CoreWallet } from '../src/core/index.js';
import type { SendPlan } from '../src/core/send.js';
import { EXIT, type CliError } from '../src/errors.js';
import { readLedger } from '../src/ledger.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import type { Ctx } from '../src/context.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * The single-gate proof (invariant 2), three layers:
 *  1. STATIC: the only doors money can leave through (broadcast, signing,
 *     raw fetch) exist in allowlisted files only — a new spend path fails
 *     this test by existing.
 *  2. RUNTIME: executeSend refuses plans the gate did not authorize —
 *     hand-built, altered, dry-run-only, or already consumed.
 *  3. SWEEP: a provider that rejects any broadcast lacking a prior ledgered
 *     allow decision matching the transaction's actual outputs, run across
 *     every spend-capable entry point. M10 added the MCP pay tool; M11
 *     MUST add paidFetch to this sweep.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function srcFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(path.sep).join('/'));
}

describe('static choke points: all spend I/O lives behind the gate', () => {
  const rules: { name: string; pattern: RegExp; allowed: string[] }[] = [
    { name: 'network broadcast calls', pattern: /\.broadcast\(/, allowed: ['core/send.ts'] },
    {
      name: 'transaction building',
      pattern: /buildSignedTx\(/,
      allowed: ['tx.ts', 'core/send.ts'],
    },
    { name: 'transaction signing', pattern: /\.sign\(/, allowed: ['tx.ts'] },
    {
      name: 'signing-key access',
      pattern: /privKeyForAddress\(/,
      allowed: ['wallet/wallet.ts', 'tx.ts'],
    },
    { name: 'raw HTTP', pattern: /\bfetch\(/, allowed: ['chain/whatsonchain.ts'] },
    {
      name: 'gate invocation',
      pattern: /authorizeSpend\(|authorizeApprovedSpend\(/,
      allowed: ['policy/engine.ts', 'core/send.ts'],
    },
  ];

  for (const rule of rules) {
    it(`${rule.name} only in: ${rule.allowed.join(', ')}`, () => {
      const offenders = srcFiles().filter(
        (f) =>
          rule.pattern.test(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')) &&
          !rule.allowed.includes(f),
      );
      expect(
        offenders,
        `New spend path? ${rule.name} found outside the gate. Route it through planSend/executeSend (and add MCP/402 entry points to the sweep below).`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------- runtime

let tmpDir: string;
let walletAddr: string;
let wallet: CoreWallet;
const RECIPIENT = PrivateKey.fromRandom().toAddress();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-gate-'));
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
  vi.restoreAllMocks();
});

function fundedProvider(sats = 50_000): MockChainProvider {
  const provider = new MockChainProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

async function gateError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
    throw new Error('expected unauthorized_spend');
  } catch (e) {
    return e as CliError;
  }
}

describe('runtime gate: executeSend refuses unauthorized plans', () => {
  it('a hand-built plan is rejected with zero broadcasts', async () => {
    const provider = fundedProvider();
    const core = { network: 'main' as const, provider };
    const forged: SendPlan = {
      to: RECIPIENT,
      amountSats: 5_000,
      feeSats: 10,
      changeSats: 44_990,
      balanceAfterSats: 44_990,
      inputCount: 1,
      inputs: [{ txid: 'cd'.repeat(32), vout: 0, satoshis: 50_000, address: walletAddr }],
      changeAddress: walletAddr,
    };
    const err = await gateError(executeSend(wallet, core, forged));
    expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
    expect(err.errorCode).toBe('unauthorized_spend');
    expect(provider.broadcasts).toHaveLength(0);
    expect(readLedger('main').filter((e) => e.type === 'send')).toHaveLength(0);
  });

  it('an altered plan (amount bumped after authorization) is rejected', async () => {
    const provider = fundedProvider();
    const core = { network: 'main' as const, provider };
    const plan = await planSend(wallet, core, { to: RECIPIENT, amountSats: 5_000 });
    plan.amountSats = 45_000; // tamper
    const err = await gateError(executeSend(wallet, core, plan));
    expect(err.errorCode).toBe('unauthorized_spend');
    expect(provider.broadcasts).toHaveLength(0);
  });

  it('a dry-run plan can never be executed for real', async () => {
    const provider = fundedProvider();
    const core = { network: 'main' as const, provider };
    const plan = await planSend(wallet, core, { to: RECIPIENT, amountSats: 5_000, dryRun: true });
    await executeSend(wallet, core, plan, { dryRun: true }); // fine: stays dry
    const err = await gateError(executeSend(wallet, core, plan));
    expect(err.errorCode).toBe('unauthorized_spend');
    expect(provider.broadcasts).toHaveLength(0);
  });

  it('one authorization = one broadcast: re-executing a consumed plan fails', async () => {
    const provider = fundedProvider();
    const core = { network: 'main' as const, provider };
    const plan = await planSend(wallet, core, { to: RECIPIENT, amountSats: 5_000 });
    await executeSend(wallet, core, plan);
    expect(provider.broadcasts).toHaveLength(1);
    const err = await gateError(executeSend(wallet, core, plan));
    expect(err.errorCode).toBe('unauthorized_spend');
    expect(provider.broadcasts).toHaveLength(1); // still exactly one
  });
});

// ---------------------------------------------------------------- sweep

const MAINNET_P2PKH_PREFIX = 0x00;

function outputAddress(lockingScriptHex: string): string | null {
  const m = /^76a914([0-9a-f]{40})88ac$/.exec(lockingScriptHex);
  if (!m) return null;
  const bytes = m[1]!.match(/../g)!.map((b) => parseInt(b, 16));
  return Utils.toBase58Check(bytes, [MAINNET_P2PKH_PREFIX]);
}

/** Rejects any broadcast not preceded by a matching ledgered allow decision. */
class CrossCheckProvider extends MockChainProvider {
  override async broadcast(rawTxHex: string): ReturnType<MockChainProvider['broadcast']> {
    const tx = Transaction.fromHex(rawTxHex);
    const out = tx.outputs[0]!;
    const recipient = outputAddress(out.lockingScript.toHex());
    const authorized = readLedger('main').some(
      (e) =>
        e.type === 'policy_decision' &&
        e.decision === 'allow' &&
        e.address === recipient &&
        e.amount_sats === out.satoshis,
    );
    if (!authorized) {
      throw new Error(
        `GATE BYPASS: broadcasting ${out.satoshis} sats to ${recipient} with no prior allow decision in the ledger`,
      );
    }
    return super.broadcast(rawTxHex);
  }
}

function crossCheckFunded(sats = 80_000): CrossCheckProvider {
  const provider = new CrossCheckProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'ab'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

function makeCtx(): Ctx {
  return { out: new Output(true), json: true, network: 'main', config: { ...DEFAULT_CONFIG } };
}

function muteStdio(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

describe('sweep: every spend entry point broadcasts only gate-authorized transactions', () => {
  // M11 MUST add core paidFetch here.
  it('CLI send', async () => {
    muteStdio();
    const provider = crossCheckFunded();
    await cmdSend(makeCtx(), RECIPIENT, '5000', 'sweep', { yes: true }, provider);
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('CLI donate', async () => {
    muteStdio();
    const provider = crossCheckFunded();
    await cmdDonate(makeCtx(), '1500', { yes: true }, provider);
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('library send()', async () => {
    const provider = crossCheckFunded();
    await send(wallet, { network: 'main', provider }, { to: RECIPIENT, amountSats: 5_000 });
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('library planSend + executeSend', async () => {
    const provider = crossCheckFunded();
    const core = { network: 'main' as const, provider };
    const plan = await planSend(wallet, core, { to: RECIPIENT, amountSats: 2_500 });
    await executeSend(wallet, core, plan);
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('MCP pay tool', async () => {
    const provider = crossCheckFunded();
    const server = buildMcpServer({ network: 'main', wallet, provider });
    const client = new Client({ name: 'sweep-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({
      name: 'pay',
      arguments: { address: RECIPIENT, amount_sats: 5_000 },
    });
    expect((result.structuredContent as { ok: boolean; txid?: string }).ok).toBe(true);
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('meta: the cross-check itself rejects an unledgered broadcast', async () => {
    const provider = crossCheckFunded();
    // a transaction built outside the gate: no allow decision exists for it
    const forged = new Transaction();
    forged.addOutput({ lockingScript: new P2PKH().lock(RECIPIENT), satoshis: 1234 });
    await expect(provider.broadcast(forged.toHex())).rejects.toThrow(/GATE BYPASS/);
    expect(provider.broadcasts).toHaveLength(0);
  });
});
