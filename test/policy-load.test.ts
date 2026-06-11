import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { DEFAULT_CONFIG } from '../src/config.js';
import { EXIT, type CliError } from '../src/errors.js';
import { appendLedger } from '../src/ledger.js';
import { policyPath } from '../src/paths.js';
import { addSessionSpent, readUsage, resetSessionSpentForTests } from '../src/policy/budget.js';
import { loadPolicy, resetPolicyCacheForTests } from '../src/policy/policy.js';

let tmpDir: string;
const ADDR = PrivateKey.fromRandom().toAddress();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-policy-load-'));
  process.env.BSV_PAY_HOME = tmpDir;
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePolicy(toml: string): void {
  fs.writeFileSync(policyPath(), toml);
  resetPolicyCacheForTests();
}

function loadErr(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected loadPolicy to throw');
}

describe('loadPolicy', () => {
  it('with no policy.toml: defaults = legacy soft limit only', () => {
    const policy = loadPolicy('main', { ...DEFAULT_CONFIG });
    expect(policy).toEqual({
      source: 'defaults',
      softPerTxLimitSats: 100_000,
      allowlist: [],
      denylist: [],
    });
  });

  it('defaults track config.spendLimitSats (config fallback keeps working)', () => {
    const policy = loadPolicy('main', { ...DEFAULT_CONFIG, spendLimitSats: 42_000 });
    expect(policy.softPerTxLimitSats).toBe(42_000);
    expect(policy.perTxLimitSats).toBeUndefined();
  });

  it('parses a full policy file; per_tx_limit_sats is hard (no soft limit)', () => {
    writePolicy(
      [
        'per_tx_limit_sats = 50000',
        'daily_budget_sats = 200000',
        'session_budget_sats = 100000',
        'rate_limit_per_minute = 6',
        'rate_limit_per_hour = 60',
        'approval_threshold_sats = 25000',
        `allowlist = ["${ADDR}"]`,
        'denylist = []',
      ].join('\n'),
    );
    const policy = loadPolicy('main', { ...DEFAULT_CONFIG });
    expect(policy.source).toBe('file');
    expect(policy.perTxLimitSats).toBe(50_000);
    expect(policy.softPerTxLimitSats).toBeUndefined(); // hard limit replaces soft
    expect(policy.dailyBudgetSats).toBe(200_000);
    expect(policy.approvalThresholdSats).toBe(25_000);
    expect(policy.allowlist).toEqual([ADDR]);
  });

  it('keeps the config soft limit when the file omits per_tx_limit_sats', () => {
    writePolicy('daily_budget_sats = 200000');
    const policy = loadPolicy('main', { ...DEFAULT_CONFIG });
    expect(policy.perTxLimitSats).toBeUndefined();
    expect(policy.softPerTxLimitSats).toBe(100_000);
  });

  it('applies [network.test] overrides only on testnet', () => {
    writePolicy(
      ['daily_budget_sats = 1000', '[network.test]', 'daily_budget_sats = 999999'].join('\n'),
    );
    expect(loadPolicy('main', { ...DEFAULT_CONFIG }).dailyBudgetSats).toBe(1_000);
    resetPolicyCacheForTests();
    expect(loadPolicy('test', { ...DEFAULT_CONFIG }).dailyBudgetSats).toBe(999_999);
  });

  it('rejects unknown keys loudly (a typo must not mean "no budget")', () => {
    writePolicy('daily_budget_stas = 1000');
    const err = loadErr(() => loadPolicy('main', { ...DEFAULT_CONFIG }));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.errorCode).toBe('invalid_policy');
    expect(err.message).toContain('daily_budget_stas');
  });

  it('rejects bad values: negative sats, fractional sats, non-array lists, bad addresses', () => {
    writePolicy('daily_budget_sats = -5');
    expect(loadErr(() => loadPolicy('main', { ...DEFAULT_CONFIG })).errorCode).toBe(
      'invalid_policy',
    );
    writePolicy('per_tx_limit_sats = 10.5');
    expect(loadErr(() => loadPolicy('main', { ...DEFAULT_CONFIG })).errorCode).toBe(
      'invalid_policy',
    );
    writePolicy('allowlist = "not-an-array"');
    expect(loadErr(() => loadPolicy('main', { ...DEFAULT_CONFIG })).errorCode).toBe(
      'invalid_policy',
    );
    writePolicy('denylist = ["notanaddress"]');
    expect(loadErr(() => loadPolicy('main', { ...DEFAULT_CONFIG })).errorCode).toBe(
      'invalid_policy',
    );
  });

  it('caches per process: live edits do not apply until restart (invariant 2)', () => {
    writePolicy('daily_budget_sats = 1000');
    expect(loadPolicy('main', { ...DEFAULT_CONFIG }).dailyBudgetSats).toBe(1_000);
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 999999'); // no cache reset
    expect(loadPolicy('main', { ...DEFAULT_CONFIG }).dailyBudgetSats).toBe(1_000);
  });
});

describe('readUsage (ledger-derived budgets)', () => {
  function seedSend(
    amountSats: number,
    ageMs: number,
    status: 'pending' | 'confirmed' | 'unknown' = 'pending',
  ): void {
    appendLedger('main', {
      type: 'send',
      txid: 'ab'.repeat(32),
      amount_sats: amountSats,
      address: ADDR,
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      status,
    });
  }

  it('sums sends in the trailing 24h, excluding older ones', () => {
    seedSend(5_000, 1_000); // just now
    seedSend(3_000, 23 * 3_600_000); // 23h ago — counts
    seedSend(50_000, 25 * 3_600_000); // 25h ago — expired
    const usage = readUsage('main');
    expect(usage.dailySpentSats).toBe(8_000);
  });

  it('counts unknown-status sends as spent (conservative)', () => {
    seedSend(7_000, 1_000, 'unknown');
    expect(readUsage('main').dailySpentSats).toBe(7_000);
  });

  it('ignores receives and other entry types', () => {
    appendLedger('main', {
      type: 'receive',
      txid: 'cd'.repeat(32),
      amount_sats: 99_999,
      address: ADDR,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });
    expect(readUsage('main').dailySpentSats).toBe(0);
  });

  it('counts send rates per minute and per hour', () => {
    seedSend(1, 10_000); // 10s ago: minute + hour
    seedSend(1, 30 * 60_000); // 30m ago: hour only
    seedSend(1, 2 * 3_600_000); // 2h ago: neither
    const usage = readUsage('main');
    expect(usage.sendsLastMinute).toBe(1);
    expect(usage.sendsLastHour).toBe(2);
  });

  it('session spend is in-memory and per-network', () => {
    addSessionSpent('main', 4_000);
    addSessionSpent('main', 1_000);
    addSessionSpent('test', 7_777);
    expect(readUsage('main').sessionSpentSats).toBe(5_000);
    expect(readUsage('test').sessionSpentSats).toBe(7_777);
  });
});
