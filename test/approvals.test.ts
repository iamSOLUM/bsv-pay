import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import {
  cmdApprovalsApprove,
  cmdApprovalsList,
  cmdApprovalsReject,
  cmdApprovalsSetSecret,
} from '../src/commands/approvals.js';
import { cmdSend } from '../src/commands/send.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { EXIT, type CliError } from '../src/errors.js';
import { appendLedger, readLedger } from '../src/ledger.js';
import { approvalSecretPath, policyPath } from '../src/paths.js';
import {
  approvalSecretConfigured,
  listPendingApprovals,
  storeApprovalSecret,
  verifyApprovalSecret,
} from '../src/policy/approvals.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { buildWalletFile, writeWalletFile, Wallet } from '../src/wallet/wallet.js';
import type { Ctx } from '../src/context.js';
import { MockChainProvider } from './mock-provider.js';

const SECRET = 'human-only-approval-secret';
const WALLET_PASSPHRASE = 'test-pass'; // also in env — the agent "knows" this
const RECIPIENT = PrivateKey.fromRandom().toAddress();

let tmpDir: string;
let walletAddr: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-approvals-'));
  process.env.BSV_PAY_HOME = tmpDir;
  process.env.BSV_PAY_PASSPHRASE = WALLET_PASSPHRASE;
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
  const phrase = Mnemonic.fromRandom().toString();
  writeWalletFile(
    'main',
    buildWalletFile('main', { type: 'mnemonic', value: phrase }, WALLET_PASSPHRASE),
  );
  walletAddr = (await Wallet.unlock('main')).issueAddress('receive').address;
  fs.writeFileSync(policyPath(), 'approval_threshold_sats = 1000');
  resetPolicyCacheForTests();
});

afterEach(() => {
  mockTty(undefined);
  delete process.env.BSV_PAY_HOME;
  delete process.env.BSV_PAY_PASSPHRASE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Simulate (or remove) an interactive terminal. */
function mockTty(on: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: on, configurable: true });
}

function makeCtx(): Ctx {
  return { out: new Output(true), json: true, network: 'main', config: { ...DEFAULT_CONFIG } };
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

function fundedProvider(sats = 50_000): MockChainProvider {
  const provider = new MockChainProvider();
  provider.utxos.set(walletAddr, [
    { txid: 'cd'.repeat(32), vout: 0, satoshis: sats, height: 800_000 },
  ]);
  return provider;
}

async function errOf(p: Promise<unknown> | (() => Promise<unknown>)): Promise<CliError> {
  try {
    await (typeof p === 'function' ? p() : p);
    throw new Error('expected an error');
  } catch (e) {
    return e as CliError;
  }
}

/** Queue a 2000-sat payment via the real CLI path; returns the approval id. */
async function queuePayment(provider: MockChainProvider): Promise<string> {
  const err = await errOf(
    cmdSend(makeCtx(), RECIPIENT, '2000', 'big one', { yes: true }, provider),
  );
  expect(err.exitCode).toBe(EXIT.PENDING_APPROVAL);
  expect(err.errorCode).toBe('pending_approval');
  expect(provider.broadcasts).toHaveLength(0); // queued, NOT sent
  return err.data!.approval_id as string;
}

describe('queueing (exit 9)', () => {
  it('a send at/above the threshold queues with a ledger entry and no broadcast', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    const queue = readLedger('main').filter(
      (e) => e.type === 'policy_decision' && e.decision === 'queue',
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      rule: 'approval_threshold_sats',
      address: RECIPIENT,
      amount_sats: 2_000,
      memo: 'big one',
      approval_id: id,
    });
    expect(listPendingApprovals('main')).toHaveLength(1);
  });

  it('approvals list renders the pending queue', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    const lines = jsonOut();
    cmdApprovalsList(makeCtx());
    const result = JSON.parse(lines.join(''));
    expect(result.ok).toBe(true);
    expect(result.approvals).toEqual([
      {
        id,
        address: RECIPIENT,
        amount_sats: 2_000,
        memo: 'big one',
        queued_at: expect.any(String),
      },
    ]);
  });
});

describe('SELF-APPROVAL BLOCKED: agent with shell + BSV_PAY_PASSPHRASE', () => {
  it('no TTY -> refused before any prompt, even with an injected prompt', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    storeApprovalSecret(SECRET);
    mockTty(false); // piped agent shell
    jsonOut();
    const err = await errOf(
      cmdApprovalsApprove(makeCtx(), id, provider, { promptSecret: async () => SECRET }),
    );
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.errorCode).toBe('tty_required');
    expect(provider.broadcasts).toHaveLength(0);
    expect(listPendingApprovals('main')).toHaveLength(1); // still pending
  });

  it('the wallet passphrase (from env) is NOT accepted as the approval secret', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    storeApprovalSecret(SECRET);
    mockTty(true); // even with a PTY trick
    jsonOut();
    const err = await errOf(
      cmdApprovalsApprove(makeCtx(), id, provider, {
        promptSecret: async () => WALLET_PASSPHRASE, // all the agent knows
      }),
    );
    expect(err.exitCode).toBe(EXIT.WALLET_LOCKED);
    expect(err.errorCode).toBe('bad_approval_secret');
    expect(provider.broadcasts).toHaveLength(0);
    expect(listPendingApprovals('main')).toHaveLength(1);
  });

  it('fail-closed: threshold set but no secret configured -> approve refuses with guidance', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    mockTty(true);
    jsonOut();
    const err = await errOf(cmdApprovalsApprove(makeCtx(), id, provider));
    expect(err.errorCode).toBe('approval_secret_missing');
    expect(provider.broadcasts).toHaveLength(0);
  });

  it('reject is equally gated (no TTY -> refused)', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    storeApprovalSecret(SECRET);
    mockTty(false);
    jsonOut();
    const err = await errOf(
      cmdApprovalsReject(makeCtx(), id, { promptSecret: async () => SECRET }),
    );
    expect(err.errorCode).toBe('tty_required');
    expect(listPendingApprovals('main')).toHaveLength(1);
  });
});

describe('the human path', () => {
  it('approve with the right secret: re-decides, sends, resolves, full audit trail', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    storeApprovalSecret(SECRET);
    mockTty(true);
    const lines = jsonOut();
    await cmdApprovalsApprove(makeCtx(), id, provider, { promptSecret: async () => SECRET });

    expect(provider.broadcasts).toHaveLength(1);
    const result = JSON.parse(lines.join(''));
    expect(result).toMatchObject({ ok: true, approval_id: id, amount_sats: 2_000 });
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);

    const entries = readLedger('main');
    const allow = entries.find(
      (e) => e.type === 'policy_decision' && e.decision === 'allow' && e.rule === 'approval',
    );
    expect(allow).toBeDefined();
    expect((allow as { reason: string }).reason).toContain(id);
    const resolved = entries.filter((e) => e.type === 'approval_resolved');
    expect(resolved).toEqual([
      expect.objectContaining({ approval_id: id, resolution: 'approved', txid: result.txid }),
    ]);
    const sends = entries.filter((e) => e.type === 'send');
    expect(sends).toHaveLength(1);
    expect(listPendingApprovals('main')).toHaveLength(0);
  });

  it('approve accepts an unambiguous id prefix', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    storeApprovalSecret(SECRET);
    mockTty(true);
    jsonOut();
    await cmdApprovalsApprove(makeCtx(), id.slice(0, 8), provider, {
      promptSecret: async () => SECRET,
    });
    expect(provider.broadcasts).toHaveLength(1);
  });

  it('a deny at approval time (budget now exhausted) leaves the approval pending', async () => {
    fs.writeFileSync(
      policyPath(),
      ['approval_threshold_sats = 1000', 'daily_budget_sats = 5000'].join('\n'),
    );
    resetPolicyCacheForTests();
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    // budget gets consumed by something else before the human approves
    appendLedger('main', {
      type: 'send',
      txid: 'ee'.repeat(32),
      amount_sats: 4_000,
      address: RECIPIENT,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });
    storeApprovalSecret(SECRET);
    mockTty(true);
    jsonOut();
    const err = await errOf(
      cmdApprovalsApprove(makeCtx(), id, provider, { promptSecret: async () => SECRET }),
    );
    expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
    expect(err.errorCode).toBe('daily_budget_exceeded');
    expect(provider.broadcasts).toHaveLength(0);
    expect(listPendingApprovals('main')).toHaveLength(1); // approve again tomorrow
  });

  it('reject resolves without sending', async () => {
    const provider = fundedProvider();
    const id = await queuePayment(provider);
    storeApprovalSecret(SECRET);
    mockTty(true);
    jsonOut();
    await cmdApprovalsReject(makeCtx(), id, { promptSecret: async () => SECRET });
    expect(provider.broadcasts).toHaveLength(0);
    expect(listPendingApprovals('main')).toHaveLength(0);
    expect(
      readLedger('main').filter(
        (e) => e.type === 'approval_resolved' && e.resolution === 'rejected',
      ),
    ).toHaveLength(1);
  });

  it('unknown approval id is exit 2', async () => {
    mockTty(true);
    jsonOut();
    const err = await errOf(cmdApprovalsApprove(makeCtx(), 'nope', fundedProvider()));
    expect(err.errorCode).toBe('unknown_approval');
  });
});

describe('set-secret', () => {
  it('requires a TTY — no non-interactive setup', async () => {
    mockTty(false);
    jsonOut();
    const err = await errOf(
      cmdApprovalsSetSecret(makeCtx(), { promptNewSecret: async () => SECRET }),
    );
    expect(err.errorCode).toBe('tty_required');
    expect(approvalSecretConfigured()).toBe(false);
  });

  it('first-time set stores only an argon2id hash, never the secret', async () => {
    mockTty(true);
    jsonOut();
    await cmdApprovalsSetSecret(makeCtx(), { promptNewSecret: async () => SECRET });
    expect(approvalSecretConfigured()).toBe(true);
    const raw = fs.readFileSync(approvalSecretPath(), 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(JSON.parse(raw).algo).toBe('argon2id');
    expect(verifyApprovalSecret(SECRET)).toBe(true);
    expect(verifyApprovalSecret(WALLET_PASSPHRASE)).toBe(false);
  });

  it('changing the secret requires the current one', async () => {
    storeApprovalSecret(SECRET);
    mockTty(true);
    jsonOut();
    const err = await errOf(
      cmdApprovalsSetSecret(makeCtx(), {
        promptOldSecret: async () => 'wrong-old',
        promptNewSecret: async () => 'new-secret',
      }),
    );
    expect(err.errorCode).toBe('bad_approval_secret');
    expect(verifyApprovalSecret(SECRET)).toBe(true); // unchanged
    await cmdApprovalsSetSecret(makeCtx(), {
      promptOldSecret: async () => SECRET,
      promptNewSecret: async () => 'new-secret',
    });
    expect(verifyApprovalSecret('new-secret')).toBe(true);
    expect(verifyApprovalSecret(SECRET)).toBe(false);
  });
});
