import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HD, Mnemonic, PrivateKey } from '@bsv/sdk';
import { openWallet, type CoreWallet } from '../src/core/index.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { approvalSecretPath, policyPath, walletPath } from '../src/paths.js';
import { storeApprovalSecret } from '../src/policy/approvals.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import { MockChainProvider } from './mock-provider.js';

/**
 * Invariant 1 at the MCP boundary, proven executable (the core-key-boundary
 * pattern extended to the wire): drive every tool through success AND
 * failure paths over a real client/server pair, serialize every complete
 * wire-level result — content text, structuredContent, protocol errors,
 * and the tools/list listing itself — and assert no representation of the
 * key material (mnemonic, seed, xprv chain, per-address WIF/hex keys,
 * passphrase, ciphertext, approval secret or its stored hash) appears.
 */

const PASSPHRASE = 'sigil-PASSPHRASE-4b8e1d-very-distinctive';
const APPROVAL_SECRET = 'approval-SECRET-9c2f7a-very-distinctive';
const RECIPIENT = PrivateKey.fromRandom().toAddress();

let tmpDir: string;
let phrase: string;
let secrets: string[];
let walletAddr: string;
let wallet: CoreWallet;

/** Every representation of the wallet's secrets we can construct. */
function buildSecrets(): string[] {
  const list = [phrase, PASSPHRASE, APPROVAL_SECRET];
  const seed = Mnemonic.fromString(phrase).toSeed();
  list.push(seed.map((b) => b.toString(16).padStart(2, '0')).join(''));
  const master = HD.fromSeed(seed);
  list.push(master.toString()); // xprv
  const account = master.derive("m/44'/236'/0'");
  list.push(account.toString());
  for (const chain of [0, 1] as const) {
    for (let index = 0; index < 4; index++) {
      const priv = account.derive(`m/${chain}/${index}`).privKey;
      list.push(priv.toWif());
      list.push(priv.toString('hex', 64));
    }
  }
  const file = JSON.parse(fs.readFileSync(walletPath('main'), 'utf8')) as {
    cipher?: { ciphertext: string; tag: string };
  };
  if (file.cipher) list.push(file.cipher.ciphertext, file.cipher.tag);
  // the approval secret's argon2id hash must stay in its file, too
  const secretFile = JSON.parse(fs.readFileSync(approvalSecretPath(), 'utf8')) as {
    hash: string;
    salt: string;
  };
  list.push(secretFile.hash, secretFile.salt);
  return list;
}

function expectClean(label: string, text: string): void {
  for (const secret of secrets) {
    expect(text, `${label} leaked key material`).not.toContain(secret);
  }
  expect(text, `${label} mentions key-like fields`).not.toMatch(/xprv|privkey|private_key/i);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-mcp-keybound-'));
  process.env.BSV_PAY_HOME = tmpDir;
  delete process.env.BSV_PAY_PASSPHRASE;
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
  phrase = Mnemonic.fromRandom().toString();
  writeWalletFile('main', buildWalletFile('main', { type: 'mnemonic', value: phrase }, PASSPHRASE));
  storeApprovalSecret(APPROVAL_SECRET);
  secrets = buildSecrets();
  expect(secrets.length).toBeGreaterThanOrEqual(20);
  process.env.BSV_PAY_PASSPHRASE = PASSPHRASE; // for the funding unlock only
  walletAddr = (await Wallet.unlock('main')).issueAddress('receive').address;
  delete process.env.BSV_PAY_PASSPHRASE;
  wallet = await openWallet({ network: 'main', passphrase: PASSPHRASE });
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function connect(provider: MockChainProvider): Promise<Client> {
  const server = buildMcpServer({ network: 'main', wallet, provider });
  const client = new Client({ name: 'keybound-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** Full wire-level result (or thrown protocol error), serialized. */
async function capture(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    return JSON.stringify(await client.callTool({ name, arguments: args }));
  } catch (e) {
    const err = e as Error;
    return JSON.stringify({ name: err.name, message: err.message, stack: err.stack });
  }
}

describe('MCP key boundary (invariant 1 at the wire)', () => {
  it('meta: the leak detector itself catches planted secrets', () => {
    expect(() => expectClean('planted', JSON.stringify({ oops: phrase }))).toThrow();
    expect(() => expectClean('planted', `prefix ${secrets[3]!} suffix`)).toThrow(); // seed hex
    expect(() => expectClean('planted', APPROVAL_SECRET)).toThrow();
    expect(() => expectClean('planted', secrets[secrets.length - 2]!)).toThrow(); // secret hash
    expect(() => expectClean('planted', 'mentions xprv somewhere')).toThrow();
  });

  it('tools/list (descriptions + schemas) is clean', async () => {
    const client = await connect(new MockChainProvider());
    expectClean('tools/list', JSON.stringify(await client.listTools()));
  });

  it('every tool result, success and failure, across a whole session is clean', async () => {
    fs.writeFileSync(
      policyPath(),
      ['daily_budget_sats = 50000', 'approval_threshold_sats = 20000'].join('\n'),
    );
    const provider = new MockChainProvider();
    provider.utxos.set(walletAddr, [
      { txid: 'cd'.repeat(32), vout: 0, satoshis: 300_000, height: 800_000 },
    ]);
    provider.balances.set(walletAddr, { confirmed: 300_000, unconfirmed: 0 });
    const client = await connect(provider);

    const sweeps: Array<[string, Record<string, unknown>]> = [
      ['get_balance', {}],
      ['get_policy_status', {}],
      ['pay ok', { name: 'pay', address: RECIPIENT, amount_sats: 5_000, memo: 'memo' }],
      ['pay denied', { name: 'pay', address: RECIPIENT, amount_sats: 49_000 }],
      ['pay queued', { name: 'pay', address: RECIPIENT, amount_sats: 20_000 }],
      ['pay bad address', { name: 'pay', address: 'garbage', amount_sats: 100 }],
      ['pay bad amount (protocol error)', { name: 'pay', address: RECIPIENT, amount_sats: -5 }],
      ['get_history', { name: 'get_history', limit: 50 }],
      ['create_payment_request', { name: 'create_payment_request', amount_sats: 2_000 }],
      ['await unknown address', { name: 'await_payment', address: RECIPIENT, timeout_s: 1 }],
    ];
    for (const [label, args] of sweeps) {
      const { name = label, ...rest } = args;
      expectClean(label, await capture(client, name as string, rest));
    }

    // await_payment success + timeout against a request this session issued
    const request = (await client.callTool({
      name: 'create_payment_request',
      arguments: { amount_sats: 2_500, memo: 'invoice' },
    })) as { structuredContent: { address: string } };
    const requestAddr = request.structuredContent.address;
    expectClean(
      'await_payment timeout',
      await capture(client, 'await_payment', { address: requestAddr, timeout_s: 1 }),
    );
    provider.utxos.set(requestAddr, [
      { txid: 'ef'.repeat(32), vout: 0, satoshis: 2_500, height: 0 },
    ]);
    expectClean(
      'await_payment success',
      await capture(client, 'await_payment', { address: requestAddr, timeout_s: 10 }),
    );

    // broadcast failure paths: rejected and ambiguous
    const rejecting = new MockChainProvider();
    rejecting.utxos.set(walletAddr, [
      { txid: 'ab'.repeat(32), vout: 1, satoshis: 100_000, height: 800_000 },
    ]);
    rejecting.broadcastResult = { ok: false, error: 'dust output' };
    expectClean(
      'pay broadcast rejected',
      await capture(await connect(rejecting), 'pay', { address: RECIPIENT, amount_sats: 5_000 }),
    );
    const ambiguous = new MockChainProvider();
    ambiguous.utxos.set(walletAddr, [
      { txid: 'ab'.repeat(32), vout: 2, satoshis: 100_000, height: 800_000 },
    ]);
    ambiguous.broadcastError = new Error('socket reset mid-flight');
    expectClean(
      'pay broadcast ambiguous',
      await capture(await connect(ambiguous), 'pay', { address: RECIPIENT, amount_sats: 5_000 }),
    );

    // paid_fetch (M11): paywall paid, refused-after-payment, and capped paths
    let acceptPayment = true;
    const paywallServer = http.createServer((paywallReq, paywallRes) => {
      if (!paywallReq.headers['x-bsv-payment'] || !acceptPayment) {
        paywallRes.writeHead(402, {
          'x-bsv-payment-version': '1.0',
          'x-bsv-payment-satoshis-required': '1500',
          'x-bsv-payment-derivation-prefix': 'kb-mcp-prefix',
          'x-bsv-payment-address': RECIPIENT,
        });
        paywallRes.end('{"error":"payment_required"}');
        return;
      }
      paywallRes.writeHead(200, { 'content-type': 'text/plain' });
      paywallRes.end('clean agent goods');
    });
    await new Promise<void>((r) => paywallServer.listen(0, '127.0.0.1', r));
    const paywallUrl = `http://127.0.0.1:${(paywallServer.address() as AddressInfo).port}/x`;
    try {
      expectClean('paid_fetch success', await capture(client, 'paid_fetch', { url: paywallUrl }));
      acceptPayment = false;
      expectClean(
        'paid_fetch not redeemed',
        await capture(client, 'paid_fetch', { url: paywallUrl }),
      );
      expectClean(
        'paid_fetch max price exceeded',
        await capture(client, 'paid_fetch', { url: paywallUrl, max_price_sats: 1 }),
      );
    } finally {
      paywallServer.close();
    }

    // final state check: policy status with a queued approval present
    expectClean(
      'get_policy_status (queue pending)',
      await capture(client, 'get_policy_status', {}),
    );
  });
});
