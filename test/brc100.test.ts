import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PrivateKey } from '@bsv/sdk';
import { cmdInit } from '../src/commands/init.js';
import { cmdWatch } from '../src/commands/watch.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import {
  createRequest,
  getBalance,
  openWallet,
  paidFetch,
  requirePayment,
  send,
  type CoreWallet,
} from '../src/core/index.js';
import { EXIT, type CliError } from '../src/errors.js';
import { readLedger } from '../src/ledger.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { Output } from '../src/output.js';
import { policyPath } from '../src/paths.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import {
  readWalletFile,
  buildBrc100WalletFile,
  writeWalletFile,
  Wallet,
} from '../src/wallet/wallet.js';
import { MockBrc100Wallet } from './mock-brc100.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * M12 — BRC-100 custody (experimental). The external wallet signs; bsv-pay
 * still decides: every spend passes the policy gate BEFORE the wallet app
 * sees an action, receive-side surfaces refuse (funds would be invisible
 * to the wallet app), and neither the mock wallet's key nor its handle
 * ever crosses the core boundary.
 */

const RECIPIENT = PrivateKey.fromRandom().toAddress();

let tmpDir: string;
let mock: MockBrc100Wallet;

function makeCtx(): Ctx {
  return { out: new Output(true), json: true, network: 'main', config: { ...DEFAULT_CONFIG } };
}

function muteStdio(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

async function errOf(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
    throw new Error('expected a CliError');
  } catch (e) {
    return e as CliError;
  }
}

/** A brc100-delegating wallet file + a funded mock wallet app. */
async function openBrc100(fundSats = 50_000): Promise<CoreWallet> {
  writeWalletFile('main', buildBrc100WalletFile('main', 'http://mock.invalid:0'));
  mock.fund(fundSats);
  return openWallet({ network: 'main', brc100: mock });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-brc100-'));
  process.env.BSV_PAY_HOME = tmpDir;
  delete process.env.BSV_PAY_BRC100_URL;
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
  mock = new MockBrc100Wallet();
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_BRC100_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('init --experimental-brc100', () => {
  it('writes a delegating wallet file: no secret, no cipher, just the URL', async () => {
    muteStdio();
    await cmdInit(makeCtx(), { experimentalBrc100: true }, { wallet: mock, url: 'http://w.test' });
    const file = readWalletFile('main');
    expect(file.backend).toBe('brc100');
    expect(file.secret).toBeUndefined();
    expect(file.kdf).toBeUndefined();
    expect(file.cipher).toBeUndefined();
    expect(file.encrypted).toBe(false);
  });

  it('--brc100 still exits 2 and points at the experimental flag', async () => {
    const err = await errOf(cmdInit(makeCtx(), { brc100: true }));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.errorCode).toBe('brc100_not_supported');
    expect(err.message).toContain('--experimental-brc100');
  });

  it('a network mismatch refuses and writes nothing (invariant 7)', async () => {
    muteStdio();
    mock.network = 'testnet'; // wallet app on testnet, bsv-pay on mainnet
    const err = await errOf(cmdInit(makeCtx(), { experimentalBrc100: true }, { wallet: mock }));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.errorCode).toBe('brc100_network_mismatch');
    expect(fs.existsSync(path.join(tmpDir, 'wallet.json'))).toBe(false);
  });

  it('rejects seed/WIF import flags alongside external custody', async () => {
    const err = await errOf(
      cmdInit(makeCtx(), { experimentalBrc100: true, importSeed: true }, { wallet: mock }),
    );
    expect(err.errorCode).toBe('conflicting_flags');
  });
});

describe('openWallet with BRC-100 custody', () => {
  it('returns a brc100-backed CoreWallet exposing no addresses', async () => {
    const wallet = await openBrc100();
    expect(wallet.backend).toBe('brc100');
    expect(wallet.addresses()).toEqual([]);
    expect(wallet.network).toBe('main');
  });

  it('an unreachable wallet app is exit 7 brc100_unreachable', async () => {
    writeWalletFile('main', buildBrc100WalletFile('main', 'http://127.0.0.1:2'));
    const err = await errOf(openWallet({ network: 'main' }));
    expect(err.exitCode).toBe(EXIT.WALLET_LOCKED);
    expect(err.errorCode).toBe('brc100_unreachable');
  });

  it('a direct local unlock of a delegating wallet file refuses', async () => {
    writeWalletFile('main', buildBrc100WalletFile('main', 'http://w.test'));
    const err = await errOf(Wallet.unlock('main'));
    expect(err.errorCode).toBe('brc100_no_local_keys');
  });
});

describe('spending: the policy gate stays in front of the external wallet', () => {
  it('an allowed send goes through the wallet app and is fully ledgered', async () => {
    const wallet = await openBrc100(50_000);
    const result = await send(
      wallet,
      { network: 'main', provider: new MockChainProvider() },
      { to: RECIPIENT, amountSats: 5_000, memo: 'brc100 send' },
    );

    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.external).toBe(true);
    expect(result.feeSats).toBe(mock.feeSats); // exact, decoded from the wallet's tx
    expect(result.feeEstimated).toBeUndefined();
    expect(result.changeSats).toBe(50_000 - 5_000 - mock.feeSats);
    expect(result.balanceAfterSats).toBe(50_000 - 5_000 - mock.feeSats);
    expect(result.rawTxHex).toMatch(/^[0-9a-f]+$/);
    expect(mock.broadcasts).toHaveLength(1);

    const ledger = readLedger('main');
    const decision = ledger.find((e) => e.type === 'policy_decision');
    expect(decision).toMatchObject({ decision: 'allow', address: RECIPIENT, amount_sats: 5_000 });
    const sendEntry = ledger.find((e) => e.type === 'send');
    expect(sendEntry).toMatchObject({
      txid: result.txid,
      amount_sats: 5_000,
      address: RECIPIENT,
      status: 'pending',
      fee_sats: mock.feeSats,
      decision_id: (decision as { decision_id: string }).decision_id,
    });
  });

  it('the wallet app sees a bounded description carrying the memo', async () => {
    const wallet = await openBrc100();
    const longMemo = 'x'.repeat(120);
    await send(
      wallet,
      { network: 'main', provider: new MockChainProvider() },
      { to: RECIPIENT, amountSats: 1_000, memo: longMemo },
    );
    const description = mock.createActionCalls[0]!.description;
    expect(description.startsWith('bsv-pay: ')).toBe(true);
    expect(Buffer.byteLength(description, 'utf8')).toBeLessThanOrEqual(50);
  });

  it('a policy denial never reaches the wallet app and is ledgered', async () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 8000');
    resetPolicyCacheForTests();
    const wallet = await openBrc100(50_000);
    const core = { network: 'main' as const, provider: new MockChainProvider() };

    await send(wallet, core, { to: RECIPIENT, amountSats: 5_000 });
    const err = await errOf(send(wallet, core, { to: RECIPIENT, amountSats: 5_000 }));
    expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
    expect(err.errorCode).toBe('daily_budget_exceeded');
    expect(err.data?.remaining_sats).toBe(3_000);
    expect(mock.createActionCalls).toHaveLength(1); // only the allowed spend

    const denies = readLedger('main').filter(
      (e) => e.type === 'policy_decision' && e.decision === 'deny',
    );
    expect(denies).toHaveLength(1);
  });

  it('an approval-threshold spend queues without touching the wallet app', async () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 1000');
    resetPolicyCacheForTests();
    const wallet = await openBrc100();
    const err = await errOf(
      send(
        wallet,
        { network: 'main', provider: new MockChainProvider() },
        { to: RECIPIENT, amountSats: 1_500 },
      ),
    );
    expect(err.exitCode).toBe(EXIT.PENDING_APPROVAL);
    expect(err.data?.approval_id).toBeTruthy();
    expect(mock.createActionCalls).toHaveLength(0);
  });

  it('a dry run evaluates policy but never touches the wallet app', async () => {
    const wallet = await openBrc100(50_000);
    const result = await send(
      wallet,
      { network: 'main', provider: new MockChainProvider() },
      { to: RECIPIENT, amountSats: 5_000, dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(result.external).toBe(true);
    expect(result.feeEstimated).toBe(true);
    expect(result.txid).toBe('');
    expect(mock.createActionCalls).toHaveLength(0);
    expect(readLedger('main').filter((e) => e.type === 'send')).toHaveLength(0);
    expect(mock.totalSats()).toBe(50_000);
  });

  it('a declined action is exit 5: allow decision ledgered, no send entry', async () => {
    const wallet = await openBrc100();
    mock.failNextAction = new Error('User declined the spending authorization');
    const err = await errOf(
      send(
        wallet,
        { network: 'main', provider: new MockChainProvider() },
        { to: RECIPIENT, amountSats: 5_000 },
      ),
    );
    expect(err.exitCode).toBe(EXIT.BROADCAST_REJECTED);
    expect(err.errorCode).toBe('brc100_action_rejected');
    const ledger = readLedger('main');
    expect(ledger.some((e) => e.type === 'policy_decision' && e.decision === 'allow')).toBe(true);
    expect(ledger.filter((e) => e.type === 'send')).toHaveLength(0);
  });

  it('an ambiguous wallet-side outcome is exit 6 and ledgered as unknown', async () => {
    const wallet = await openBrc100();
    const txid = 'ab'.repeat(32);
    mock.failNextAction = Object.assign(new Error('broadcast needs review'), {
      reviewActionResults: [],
      txid,
    });
    const err = await errOf(
      send(
        wallet,
        { network: 'main', provider: new MockChainProvider() },
        { to: RECIPIENT, amountSats: 5_000 },
      ),
    );
    expect(err.exitCode).toBe(EXIT.BROADCAST_UNKNOWN);
    expect(err.errorCode).toBe('brc100_broadcast_unknown');
    expect(err.data?.txid).toBe(txid);
    const entry = readLedger('main').find((e) => e.type === 'send');
    expect(entry).toMatchObject({ txid, status: 'unknown', amount_sats: 5_000 });
  });

  it('insufficient funds: fail-fast pre-check and the wallet app verdict both exit 3', async () => {
    const wallet = await openBrc100(5_000);
    const core = { network: 'main' as const, provider: new MockChainProvider() };

    // definitely insufficient: caught before the wallet app is asked
    const early = await errOf(send(wallet, core, { to: RECIPIENT, amountSats: 50_000 }));
    expect(early.exitCode).toBe(EXIT.INSUFFICIENT_FUNDS);
    expect(mock.createActionCalls).toHaveLength(0);

    // covers the amount but not the wallet's fee: the wallet app decides
    const late = await errOf(send(wallet, core, { to: RECIPIENT, amountSats: 4_995 }));
    expect(late.exitCode).toBe(EXIT.INSUFFICIENT_FUNDS);
    expect(late.errorCode).toBe('insufficient_funds');
    expect(mock.createActionCalls).toHaveLength(1);
  });

  it('paidFetch pays a 402 through the external wallet, same gate', async () => {
    const wallet = await openBrc100();
    const paywall = http.createServer((req, res) => {
      if (!req.headers['x-bsv-payment']) {
        res.writeHead(402, {
          'x-bsv-payment-version': '1.0',
          'x-bsv-payment-satoshis-required': '2000',
          'x-bsv-payment-derivation-prefix': 'brc100-prefix',
          'x-bsv-payment-address': RECIPIENT,
        });
        res.end('{"error":"payment_required"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('externally paid content');
    });
    await new Promise<void>((r) => paywall.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(paywall.address() as AddressInfo).port}/data`;
    try {
      const result = await paidFetch(
        wallet,
        { network: 'main', provider: new MockChainProvider() },
        { url },
      );
      expect(result.paid).toBe(true);
      expect(result.body).toBe('externally paid content');
      expect(mock.broadcasts).toHaveLength(1);
      expect(readLedger('main').filter((e) => e.type === 'send')).toHaveLength(1);
    } finally {
      paywall.close();
    }
  });
});

describe('balance and the receive-side refusals', () => {
  it('getBalance reports the wallet app total (no per-address detail)', async () => {
    await openBrc100(42_000);
    const balance = await getBalance({ network: 'main', brc100: mock });
    expect(balance.backend).toBe('brc100');
    expect(balance.confirmedSats).toBe(42_000);
    expect(balance.unconfirmedSats).toBe(0);
    expect(balance.addresses).toEqual([]);
  });

  it('createRequest refuses: funds would be invisible to the wallet app', async () => {
    const wallet = await openBrc100();
    expect(() => createRequest(wallet, { amountSats: 1_000 })).toThrowError(
      expect.objectContaining({ errorCode: 'brc100_receive_not_supported', exitCode: EXIT.USAGE }),
    );
  });

  it('requirePayment refuses at construction, not on the first customer', async () => {
    const wallet = await openBrc100();
    expect(() => requirePayment({ network: 'main', wallet, priceSats: 100 })).toThrowError(
      expect.objectContaining({ errorCode: 'brc100_receive_not_supported' }),
    );
  });

  it('watch refuses up front', async () => {
    muteStdio();
    writeWalletFile('main', buildBrc100WalletFile('main', 'http://w.test'));
    const err = await errOf(cmdWatch(makeCtx(), {}, new MockChainProvider(), 1));
    expect(err.errorCode).toBe('brc100_receive_not_supported');
  });
});

describe('MCP surface under BRC-100 custody', () => {
  it('pay works through the gate; request tools return structured refusals', async () => {
    const wallet = await openBrc100(50_000);
    const server = buildMcpServer({
      network: 'main',
      wallet,
      provider: new MockChainProvider(),
      brc100: mock,
    });
    const client = new Client({ name: 'brc100-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const pay = await client.callTool({
      name: 'pay',
      arguments: { address: RECIPIENT, amount_sats: 5_000 },
    });
    expect((pay.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(mock.broadcasts).toHaveLength(1);

    const request = await client.callTool({
      name: 'create_payment_request',
      arguments: { amount_sats: 1_000 },
    });
    expect(request.structuredContent as object).toMatchObject({
      ok: false,
      error: 'brc100_receive_not_supported',
      code: EXIT.USAGE,
    });

    const balance = await client.callTool({ name: 'get_balance', arguments: {} });
    expect((balance.structuredContent as { confirmed_sats?: number }).confirmed_sats).toBe(
      50_000 - 5_000 - mock.feeSats,
    );
  });
});

describe('key boundary: the wallet app key and handle never cross (invariant 1)', () => {
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

  async function capture(fn: () => unknown): Promise<string> {
    try {
      return ser(await fn());
    } catch (e) {
      return ser(e);
    }
  }

  it('every result and error across the brc100 surface is clean', async () => {
    const wallet = await openBrc100(50_000);
    const secrets = [mock.key.toWif(), mock.key.toString('hex', 64)];
    const core = { network: 'main' as const, provider: new MockChainProvider() };

    const outputs = [
      ['openWallet result', ser(wallet)],
      [
        'send result',
        await capture(() => send(wallet, core, { to: RECIPIENT, amountSats: 5_000 })),
      ],
      [
        'dry run result',
        await capture(() => send(wallet, core, { to: RECIPIENT, amountSats: 100, dryRun: true })),
      ],
      ['getBalance result', await capture(() => getBalance({ network: 'main', brc100: mock }))],
      ['createRequest refusal', await capture(() => createRequest(wallet, { amountSats: 1 }))],
      [
        'declined action error',
        await (async () => {
          mock.failNextAction = new Error('declined');
          return capture(() => send(wallet, core, { to: RECIPIENT, amountSats: 100 }));
        })(),
      ],
    ] as const;

    // meta: the detector catches a planted secret
    expect(`leak ${secrets[0]!}`).toContain(secrets[0]!);

    for (const [label, text] of outputs) {
      for (const secret of secrets) {
        expect(text, `${label} leaked the wallet app key`).not.toContain(secret);
      }
      expect(text, `${label} mentions key-like fields`).not.toMatch(/xprv|privkey|private_key/i);
    }
  });
});
