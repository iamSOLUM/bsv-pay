import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import { openWallet, type CoreWallet } from '../src/core/index.js';
import { appendLedger } from '../src/ledger.js';
import { buildMcpServer, type McpServerOptions } from '../src/mcp/server.js';
import { policyPath } from '../src/paths.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * MCP server over the in-memory client/server pair: the same code path a
 * real client exercises (schemas validated by the SDK), no subprocess.
 * The contract under test: every tool returns structuredContent with
 * ok:true|false; expected failures are RESULTS (never protocol errors,
 * never isError) carrying stable snake_case codes.
 */

let tmpDir: string;
let walletAddr: string;
let wallet: CoreWallet;
const RECIPIENT = PrivateKey.fromRandom().toAddress();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-mcp-'));
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

async function connectClient(
  overrides: Partial<McpServerOptions> = {},
): Promise<{ client: Client; provider: MockChainProvider }> {
  const provider =
    overrides.provider instanceof MockChainProvider ? overrides.provider : new MockChainProvider();
  const server = buildMcpServer({ network: 'main', wallet, provider, ...overrides });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, provider };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

describe('tool surface', () => {
  it('exposes exactly the read-only tools (so far) with agent-facing descriptions', async () => {
    const { client } = await connectClient();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_balance', 'get_history', 'get_policy_status']);
    for (const tool of tools) {
      // tool descriptions are prompt engineering: units must be stated
      expect(tool.description).toMatch(/satoshis/);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe('get_balance', () => {
  it('sums confirmed and unconfirmed across tracked addresses', async () => {
    const provider = new MockChainProvider();
    provider.balances.set(walletAddr, { confirmed: 7_000, unconfirmed: 1_500 });
    const { client } = await connectClient({ provider });
    const balance = await call(client, 'get_balance');
    expect(balance).toMatchObject({
      ok: true,
      network: 'main',
      confirmed_sats: 7_000,
      unconfirmed_sats: 1_500,
      total_sats: 8_500,
      addresses_tracked: 1,
    });
  });

  it('no wallet → structured ok:false result, not a protocol error', async () => {
    fs.rmSync(path.join(tmpDir, 'wallet.json'), { force: true });
    const { client } = await connectClient();
    const balance = await call(client, 'get_balance');
    expect(balance.ok).toBe(false);
    expect(balance.error).toBe('no_wallet');
    expect(typeof balance.message).toBe('string');
  });
});

describe('get_history', () => {
  it('returns ledger movements newest first with memos, respecting limit/type', async () => {
    for (const [i, type] of (['receive', 'send', 'receive'] as const).entries()) {
      appendLedger('main', {
        type,
        txid: String(i).repeat(64).slice(0, 64),
        amount_sats: 1_000 + i,
        address: RECIPIENT,
        memo: `memo-${i}`,
        timestamp: new Date(Date.now() - (3 - i) * 60_000).toISOString(),
        status: 'confirmed',
      });
    }
    const { client } = await connectClient();

    const all = await call(client, 'get_history');
    expect(all.count).toBe(3);
    const payments = all.payments as Array<Record<string, unknown>>;
    expect(payments[0]).toMatchObject({ amount_sats: 1_002, memo: 'memo-2' });

    const sends = await call(client, 'get_history', { type: 'send', limit: 1 });
    expect(sends.count).toBe(1);
    expect((sends.payments as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'send',
      amount_sats: 1_001,
    });
  });
});

describe('get_policy_status', () => {
  it('defaults: source "defaults", legacy soft limit, nothing pending', async () => {
    const { client } = await connectClient();
    const status = await call(client, 'get_policy_status');
    expect(status).toMatchObject({
      ok: true,
      network: 'main',
      source: 'defaults',
      approval_secret_configured: false,
      allowlist: [],
      denylist: [],
      pending_approvals: [],
    });
    expect(typeof status.soft_spend_limit_sats).toBe('number');
    expect(status.per_tx_limit_sats).toBeUndefined();
  });

  it('reports budgets, remaining headroom, and the human approval queue', async () => {
    fs.writeFileSync(
      policyPath(),
      [
        'per_tx_limit_sats = 50000',
        'daily_budget_sats = 10000',
        `denylist = ["${RECIPIENT}"]`,
      ].join('\n'),
    );
    appendLedger('main', {
      type: 'send',
      txid: 'b'.repeat(64),
      amount_sats: 4_000,
      address: RECIPIENT,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });
    appendLedger('main', {
      type: 'policy_decision',
      decision: 'queue',
      rule: 'approval_threshold_sats',
      reason: 'queued for approval',
      address: RECIPIENT,
      amount_sats: 60_000,
      timestamp: new Date().toISOString(),
      decision_id: 'd-queue',
      approval_id: 'appr-9',
    });
    const { client } = await connectClient();

    const status = await call(client, 'get_policy_status');
    expect(status).toMatchObject({
      source: 'file',
      per_tx_limit_sats: 50_000,
      daily_budget_sats: 10_000,
      daily_remaining_sats: 6_000,
      denylist: [RECIPIENT],
    });
    expect(status.usage).toMatchObject({ daily_spent_sats: 4_000, sends_last_minute: 1 });
    expect(status.pending_approvals).toEqual([
      expect.objectContaining({ approval_id: 'appr-9', amount_sats: 60_000 }),
    ]);
  });
});
