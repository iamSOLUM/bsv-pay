import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import { openWallet, type CoreWallet } from '../src/core/index.js';
import { appendLedger, readLedger } from '../src/ledger.js';
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

function fundProvider(provider: MockChainProvider, sats = 200_000): MockChainProvider {
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

function ledgeredSpendSats(): number {
  return readLedger('main')
    .filter((e) => e.type === 'send')
    .reduce((sum, e) => sum + e.amount_sats, 0);
}

describe('tool surface', () => {
  it('exposes the M10+M11 tools with agent-facing descriptions', async () => {
    const { client } = await connectClient();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'await_payment',
      'create_payment_request',
      'get_balance',
      'get_history',
      'get_policy_status',
      'paid_fetch',
      'pay',
    ]);
    for (const tool of tools) {
      // tool descriptions are prompt engineering: units must be stated
      expect(tool.description).toMatch(/satoshis/);
    }
    const pay = tools.find((t) => t.name === 'pay')!;
    // irreversibility and budgets must be spelled out for the LLM
    expect(pay.description).toMatch(/IRREVERSIBLE/);
    expect(pay.description).toMatch(/policy/);
    expect(pay.annotations?.readOnlyHint).toBe(false);
    expect(pay.annotations?.destructiveHint).toBe(true);
    // there is deliberately NO tool that unlocks, approves, or edits policy
    for (const name of names) expect(name).not.toMatch(/approve|unlock|secret|policy_set|seed/);
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

describe('pay', () => {
  it('within policy → broadcast txid; the send and the allow decision are ledgered', async () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 10000');
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });

    const paid = await call(client, 'pay', {
      address: RECIPIENT,
      amount_sats: 4_000,
      memo: 'mcp test',
    });
    expect(paid).toMatchObject({
      ok: true,
      network: 'main',
      address: RECIPIENT,
      amount_sats: 4_000,
    });
    expect(typeof paid.txid).toBe('string');
    expect(provider.broadcasts).toHaveLength(1);

    const ledger = readLedger('main');
    expect(ledger.filter((e) => e.type === 'send')).toHaveLength(1);
    expect(
      ledger.filter((e) => e.type === 'policy_decision' && e.decision === 'allow'),
    ).toHaveLength(1);
  });

  it('over budget → structured denial with remaining_sats AND a ledgered deny decision', async () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 3000');
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });

    const denied = await call(client, 'pay', { address: RECIPIENT, amount_sats: 5_000 });
    expect(denied).toMatchObject({
      ok: false,
      code: 8,
      error: 'daily_budget_exceeded',
      rule: 'daily_budget_sats',
      budget_sats: 3_000,
      remaining_sats: 3_000,
      amount_sats: 5_000,
    });
    expect(typeof denied.message).toBe('string');
    expect(provider.broadcasts).toHaveLength(0);

    const denies = readLedger('main').filter(
      (e) => e.type === 'policy_decision' && e.decision === 'deny',
    );
    expect(denies).toHaveLength(1);
    expect(denies[0]).toMatchObject({ rule: 'daily_budget_sats', amount_sats: 5_000 });
  });

  it('denylisted recipient → recipient_denied, nothing broadcast', async () => {
    fs.writeFileSync(policyPath(), `denylist = ["${RECIPIENT}"]`);
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });

    const denied = await call(client, 'pay', { address: RECIPIENT, amount_sats: 1_000 });
    expect(denied).toMatchObject({ ok: false, error: 'recipient_denied', rule: 'denylist' });
    expect(provider.broadcasts).toHaveLength(0);
  });

  it('at/above the approval threshold → pending_approval with approval_id, not sent', async () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 5000');
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });

    const queued = await call(client, 'pay', { address: RECIPIENT, amount_sats: 7_000 });
    expect(queued).toMatchObject({
      ok: false,
      code: 9,
      error: 'pending_approval',
      rule: 'approval_threshold_sats',
    });
    expect(typeof queued.approval_id).toBe('string');
    expect(provider.broadcasts).toHaveLength(0);

    // the queue is visible to the agent via get_policy_status
    const status = await call(client, 'get_policy_status');
    expect(status.pending_approvals).toEqual([
      expect.objectContaining({ approval_id: queued.approval_id, amount_sats: 7_000 }),
    ]);
  });

  it('the soft spend limit cannot be crossed from MCP (no allow-large equivalent)', async () => {
    // no policy.toml: the legacy confirmable limit applies; MCP is unattended
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
      config: { spendLimitSats: 2_000 },
    });
    const denied = await call(client, 'pay', { address: RECIPIENT, amount_sats: 2_500 });
    expect(denied).toMatchObject({ ok: false, error: 'spend_limit_exceeded' });
    expect(provider.broadcasts).toHaveLength(0);
  });

  it('N concurrent pays against a budget that allows only some: ledger never overshoots', async () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 10000');
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(client, 'pay', { address: RECIPIENT, amount_sats: 4_000 }),
      ),
    );

    const succeeded = results.filter((r) => r.ok === true);
    const denied = results.filter((r) => r.ok === false);
    expect(succeeded).toHaveLength(2);
    expect(denied).toHaveLength(3);
    for (const d of denied) {
      expect(d.error).toBe('daily_budget_exceeded');
      expect(d.remaining_sats).toBe(2_000);
    }

    // the owner's invariant: total ledgered spend never exceeds the budget
    expect(ledgeredSpendSats()).toBe(8_000);
    expect(ledgeredSpendSats()).toBeLessThanOrEqual(10_000);
    expect(provider.broadcasts).toHaveLength(2);
    const decisions = readLedger('main').filter((e) => e.type === 'policy_decision');
    expect(decisions.filter((d) => d.decision === 'allow')).toHaveLength(2);
    expect(decisions.filter((d) => d.decision === 'deny')).toHaveLength(3);
  });
});

describe('paid_fetch', () => {
  async function startPaywall(priceSats: number): Promise<{ url: string; close(): void }> {
    const server = http.createServer((req, res) => {
      if (!req.headers['x-bsv-payment']) {
        res.writeHead(402, {
          'x-bsv-payment-version': '1.0',
          'x-bsv-payment-satoshis-required': String(priceSats),
          'x-bsv-payment-derivation-prefix': 'mcp-prefix',
          'x-bsv-payment-address': RECIPIENT,
        });
        res.end('{"error":"payment_required"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":"agent goods"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/api`, close: () => server.close() };
  }

  it('pays a 402 within policy and returns the body + payment details', async () => {
    const paywall = await startPaywall(1_200);
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });
    try {
      const fetched = await call(client, 'paid_fetch', {
        url: paywall.url,
        max_price_sats: 2_000,
      });
      expect(fetched).toMatchObject({
        ok: true,
        status: 200,
        paid: true,
        body: '{"data":"agent goods"}',
        body_truncated: false,
        amount_sats: 1_200,
        address: RECIPIENT,
      });
      expect(typeof fetched.txid).toBe('string');
      expect(provider.broadcasts).toHaveLength(1);
      expect(readLedger('main').some((e) => e.type === 'send' && e.amount_sats === 1_200)).toBe(
        true,
      );
    } finally {
      paywall.close();
    }
  });

  it('max_price_sats caps the fetch: structured ok:false, nothing spent', async () => {
    const paywall = await startPaywall(5_000);
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });
    try {
      const refused = await call(client, 'paid_fetch', {
        url: paywall.url,
        max_price_sats: 1_000,
      });
      expect(refused).toMatchObject({
        ok: false,
        code: 8,
        error: 'max_price_exceeded',
        price_sats: 5_000,
        max_price_sats: 1_000,
      });
      expect(provider.broadcasts).toHaveLength(0);
    } finally {
      paywall.close();
    }
  });

  it('policy denial on the 402 spend is a structured result with the rule', async () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 500');
    const paywall = await startPaywall(1_200);
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });
    try {
      const denied = await call(client, 'paid_fetch', { url: paywall.url });
      expect(denied).toMatchObject({
        ok: false,
        error: 'daily_budget_exceeded',
        rule: 'daily_budget_sats',
      });
      expect(provider.broadcasts).toHaveLength(0);
    } finally {
      paywall.close();
    }
  });

  it('a free resource costs nothing and respects max_body_chars', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(100));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const { client, provider } = await connectClient({
      provider: fundProvider(new MockChainProvider()),
    });
    try {
      const fetched = await call(client, 'paid_fetch', {
        url: `http://127.0.0.1:${port}/big`,
        max_body_chars: 10,
      });
      expect(fetched).toMatchObject({
        ok: true,
        paid: false,
        body: 'xxxxxxxxxx',
        body_truncated: true,
      });
      expect(provider.broadcasts).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});

describe('create_payment_request + await_payment', () => {
  it('issues a fresh address + URI, then sees the incoming payment and ledgers it', async () => {
    const { client, provider } = await connectClient();

    const request = await call(client, 'create_payment_request', {
      amount_sats: 2_500,
      memo: 'data purchase',
    });
    expect(request.ok).toBe(true);
    expect(request.address).not.toBe(walletAddr); // fresh address per request
    expect(request.uri).toMatch(/^bitcoin:/);

    // payer pays: the mock chain now shows a UTXO on the request address
    provider.utxos.set(request.address as string, [
      { txid: 'ef'.repeat(32), vout: 0, satoshis: 2_500, height: 0 },
    ]);
    const payment = await call(client, 'await_payment', {
      address: request.address,
      timeout_s: 10,
    });
    expect(payment).toMatchObject({
      ok: true,
      address: request.address,
      amount_sats: 2_500,
      confirmed: false,
    });
    const receives = readLedger('main').filter((e) => e.type === 'receive');
    expect(receives).toHaveLength(1);
    expect(receives[0]).toMatchObject({ amount_sats: 2_500, address: request.address });
  });

  it('timeout → ok:false request_timeout (result, not protocol error); safe to retry', async () => {
    const { client } = await connectClient();
    const request = await call(client, 'create_payment_request', { amount_sats: 1_000 });
    const timedOut = await call(client, 'await_payment', {
      address: request.address,
      timeout_s: 1,
    });
    expect(timedOut).toMatchObject({ ok: false, code: 4, error: 'request_timeout' });
  });

  it('refuses to await an address this wallet did not issue', async () => {
    const { client } = await connectClient();
    const refused = await call(client, 'await_payment', { address: RECIPIENT, timeout_s: 1 });
    expect(refused).toMatchObject({ ok: false, error: 'unknown_address' });
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
