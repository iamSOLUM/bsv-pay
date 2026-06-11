import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { DEFAULT_CONFIG } from '../src/config.js';
import { EXIT, type CliError } from '../src/errors.js';
import { appendLedger, readLedger } from '../src/ledger.js';
import { policyPath } from '../src/paths.js';
import { addSessionSpent, resetSessionSpentForTests, readUsage } from '../src/policy/budget.js';
import {
  authorizeApprovedSpend,
  authorizeSpend,
  evaluateSpend,
  type PolicyEnv,
} from '../src/policy/engine.js';
import { loadPolicy, resetPolicyCacheForTests, type Policy } from '../src/policy/policy.js';

let tmpDir: string;
const TO = PrivateKey.fromRandom().toAddress();
const OTHER = PrivateKey.fromRandom().toAddress();
const ENV: PolicyEnv = { network: 'main', config: { ...DEFAULT_CONFIG } };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-policy-engine-'));
  process.env.BSV_PAY_HOME = tmpDir;
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function policy(overrides: Partial<Policy>): Policy {
  return { source: 'file', allowlist: [], denylist: [], ...overrides };
}

const NO_USAGE = { dailySpentSats: 0, sessionSpentSats: 0, sendsLastMinute: 0, sendsLastHour: 0 };

function thrown(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected a policy error');
}

describe('evaluateSpend (pure rules)', () => {
  it('denylist wins over everything, including the allowlist', () => {
    const v = evaluateSpend(
      policy({ allowlist: [TO], denylist: [TO], approvalThresholdSats: 1 }),
      NO_USAGE,
      { to: TO, amountSats: 5 },
    );
    expect(v).toMatchObject({ decision: 'deny', rule: 'denylist', errorCode: 'recipient_denied' });
  });

  it('a non-empty allowlist denies everyone not on it', () => {
    const p = policy({ allowlist: [OTHER] });
    expect(evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 5 })).toMatchObject({
      decision: 'deny',
      errorCode: 'recipient_not_allowed',
    });
    expect(evaluateSpend(p, NO_USAGE, { to: OTHER, amountSats: 5 })).toMatchObject({
      decision: 'allow',
    });
    // empty allowlist restricts nothing
    expect(evaluateSpend(policy({}), NO_USAGE, { to: TO, amountSats: 5 })).toMatchObject({
      decision: 'allow',
    });
  });

  it('hard per-tx limit: caps at the limit, no flag can cross it', () => {
    const p = policy({ perTxLimitSats: 50_000 });
    expect(evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 50_000 })).toMatchObject({
      decision: 'allow',
    });
    const v = evaluateSpend(p, NO_USAGE, {
      to: TO,
      amountSats: 50_001,
      softLimitConfirmed: true, // --allow-large must NOT satisfy a hard limit
    });
    expect(v).toMatchObject({
      decision: 'deny',
      rule: 'per_tx_limit_sats',
      errorCode: 'per_tx_limit_exceeded',
    });
  });

  it('soft limit: byte-compatible legacy semantics (>= denies unless confirmed)', () => {
    const p = policy({ softPerTxLimitSats: 100_000 });
    const denied = evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 100_000 });
    expect(denied).toMatchObject({ decision: 'deny', errorCode: 'spend_limit_exceeded' });
    expect((denied as { data: object }).data).toEqual({
      limit_sats: 100_000,
      amount_sats: 100_000,
    });
    expect(
      evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 100_000, softLimitConfirmed: true }),
    ).toMatchObject({ decision: 'allow' });
  });

  it('session and daily budgets deny when the amount exceeds what remains', () => {
    const p = policy({ sessionBudgetSats: 10_000, dailyBudgetSats: 20_000 });
    expect(
      evaluateSpend(p, { ...NO_USAGE, sessionSpentSats: 9_000 }, { to: TO, amountSats: 1_001 }),
    ).toMatchObject({ decision: 'deny', errorCode: 'session_budget_exceeded' });
    const daily = evaluateSpend(
      p,
      { ...NO_USAGE, dailySpentSats: 19_500 },
      { to: TO, amountSats: 501 },
    );
    expect(daily).toMatchObject({ decision: 'deny', errorCode: 'daily_budget_exceeded' });
    expect((daily as { data: { remaining_sats: number } }).data.remaining_sats).toBe(500);
    // spending exactly the remainder is allowed
    expect(
      evaluateSpend(p, { ...NO_USAGE, dailySpentSats: 19_500 }, { to: TO, amountSats: 500 }),
    ).toMatchObject({ decision: 'allow' });
  });

  it('rate limits deny at the cap', () => {
    const p = policy({ rateLimitPerMinute: 2, rateLimitPerHour: 5 });
    expect(
      evaluateSpend(p, { ...NO_USAGE, sendsLastMinute: 2 }, { to: TO, amountSats: 1 }),
    ).toMatchObject({ decision: 'deny', errorCode: 'rate_limit_exceeded' });
    expect(
      evaluateSpend(p, { ...NO_USAGE, sendsLastHour: 5 }, { to: TO, amountSats: 1 }),
    ).toMatchObject({ decision: 'deny', errorCode: 'rate_limit_exceeded' });
    expect(
      evaluateSpend(
        p,
        { ...NO_USAGE, sendsLastMinute: 1, sendsLastHour: 4 },
        { to: TO, amountSats: 1 },
      ),
    ).toMatchObject({ decision: 'allow' });
  });

  it('approval threshold queues at/above; budget denial beats queueing', () => {
    const p = policy({ approvalThresholdSats: 25_000, dailyBudgetSats: 30_000 });
    expect(evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 25_000 })).toMatchObject({
      decision: 'queue',
      rule: 'approval_threshold_sats',
    });
    expect(evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 24_999 })).toMatchObject({
      decision: 'allow',
    });
    // over budget AND over threshold: deny wins (queueing it would be noise)
    expect(
      evaluateSpend(p, { ...NO_USAGE, dailySpentSats: 10_000 }, { to: TO, amountSats: 25_000 }),
    ).toMatchObject({ decision: 'deny', errorCode: 'daily_budget_exceeded' });
  });
});

describe('authorizeSpend (the enforcing gate)', () => {
  function decisions(): Extract<
    ReturnType<typeof readLedger>[number],
    { type: 'policy_decision' }
  >[] {
    return readLedger('main').filter((e) => e.type === 'policy_decision');
  }

  it('allow: returns an authorization and ledgers the decision', () => {
    const auth = authorizeSpend(ENV, { to: TO, amountSats: 5_000 }, { mode: 'enforce' });
    expect(auth.to).toBe(TO);
    expect(auth.amountSats).toBe(5_000);
    expect(auth.evaluateOnly).toBe(false);
    const entries = decisions();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      decision: 'allow',
      rule: 'default',
      address: TO,
      amount_sats: 5_000,
      decision_id: auth.decisionId,
    });
  });

  it('deny: throws exit 8 with rule + reason AND ledgers the denial', () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 1000');
    resetPolicyCacheForTests();
    const err = thrown(() =>
      authorizeSpend(ENV, { to: TO, amountSats: 5_000, memo: 'too big' }, { mode: 'enforce' }),
    );
    expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
    expect(err.errorCode).toBe('daily_budget_exceeded');
    expect(err.data).toMatchObject({ rule: 'daily_budget_sats', remaining_sats: 1000 });
    const entries = decisions();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      decision: 'deny',
      rule: 'daily_budget_sats',
      address: TO,
      amount_sats: 5_000,
      memo: 'too big',
    });
    expect(entries[0]!.reason).toMatch(/exceeds the remaining 24h budget/);
  });

  it('queue: throws exit 9 and ledgers the queue entry with an approval id', () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 1000');
    resetPolicyCacheForTests();
    const err = thrown(() =>
      authorizeSpend(ENV, { to: TO, amountSats: 2_000, confirmedOnly: true }, { mode: 'enforce' }),
    );
    expect(err.exitCode).toBe(EXIT.PENDING_APPROVAL);
    expect(err.errorCode).toBe('pending_approval');
    expect(err.data?.approval_id).toMatch(/[0-9a-f-]{36}/);
    const entries = decisions();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      decision: 'queue',
      approval_id: err.data?.approval_id,
      confirmed_only: true,
    });
  });

  it('evaluate mode: identical verdicts, nothing persisted', () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 1000');
    resetPolicyCacheForTests();
    const err = thrown(() =>
      authorizeSpend(ENV, { to: TO, amountSats: 5_000 }, { mode: 'evaluate' }),
    );
    expect(err.errorCode).toBe('daily_budget_exceeded');
    const auth = authorizeSpend(ENV, { to: TO, amountSats: 500 }, { mode: 'evaluate' });
    expect(auth.evaluateOnly).toBe(true);
    expect(decisions()).toHaveLength(0); // invariant: dry-runs persist nothing
  });

  it('budget decisions read the ledger written by earlier sends', () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 10000');
    resetPolicyCacheForTests();
    appendLedger('main', {
      type: 'send',
      txid: 'aa'.repeat(32),
      amount_sats: 9_500,
      address: OTHER,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });
    expect(readUsage('main').dailySpentSats).toBe(9_500);
    const err = thrown(() => authorizeSpend(ENV, { to: TO, amountSats: 501 }, { mode: 'enforce' }));
    expect(err.errorCode).toBe('daily_budget_exceeded');
    authorizeSpend(ENV, { to: TO, amountSats: 500 }, { mode: 'enforce' }); // exactly the rest
  });

  it('session budget counts spends recorded via addSessionSpent', () => {
    fs.writeFileSync(policyPath(), 'session_budget_sats = 1000');
    resetPolicyCacheForTests();
    addSessionSpent('main', 800);
    const err = thrown(() => authorizeSpend(ENV, { to: TO, amountSats: 300 }, { mode: 'enforce' }));
    expect(err.errorCode).toBe('session_budget_exceeded');
  });
});

describe('authorizeApprovedSpend (approval context)', () => {
  it('skips only the threshold rule and ledgers rule=approval', () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 1000');
    resetPolicyCacheForTests();
    const auth = authorizeApprovedSpend(ENV, { to: TO, amountSats: 5_000 }, 'approval-123');
    expect(auth.evaluateOnly).toBe(false);
    const entry = readLedger('main').find((e) => e.type === 'policy_decision');
    expect(entry).toMatchObject({ decision: 'allow', rule: 'approval' });
    expect((entry as { reason: string }).reason).toContain('approval-123');
  });

  it('still denies on budget at approval time (approval is not a bypass)', () => {
    fs.writeFileSync(
      policyPath(),
      ['approval_threshold_sats = 1000', 'daily_budget_sats = 3000'].join('\n'),
    );
    resetPolicyCacheForTests();
    appendLedger('main', {
      type: 'send',
      txid: 'bb'.repeat(32),
      amount_sats: 2_900,
      address: OTHER,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });
    const err = thrown(() => authorizeApprovedSpend(ENV, { to: TO, amountSats: 2_000 }, 'a-1'));
    expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
    expect(err.errorCode).toBe('daily_budget_exceeded');
  });

  it('denylist still applies at approval time', () => {
    fs.writeFileSync(
      policyPath(),
      ['approval_threshold_sats = 1000', `denylist = ["${TO}"]`].join('\n'),
    );
    resetPolicyCacheForTests();
    const err = thrown(() => authorizeApprovedSpend(ENV, { to: TO, amountSats: 2_000 }, 'a-2'));
    expect(err.errorCode).toBe('recipient_denied');
  });
});

describe('loadPolicy + evaluate integration sanity', () => {
  it('defaults policy evaluates exactly like the legacy limit', () => {
    const p = loadPolicy('main', { ...DEFAULT_CONFIG });
    expect(evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 99_999 })).toMatchObject({
      decision: 'allow',
    });
    expect(evaluateSpend(p, NO_USAGE, { to: TO, amountSats: 100_000 })).toMatchObject({
      decision: 'deny',
      errorCode: 'spend_limit_exceeded',
    });
  });
});
