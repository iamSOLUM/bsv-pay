import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { cmdPolicyShow, cmdPolicyTest } from '../src/commands/policy.js';
import { Output } from '../src/output.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { EXIT, type CliError } from '../src/errors.js';
import { readLedger } from '../src/ledger.js';
import { policyPath } from '../src/paths.js';
import { storeApprovalSecret } from '../src/policy/approvals.js';
import { resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import type { Ctx } from '../src/context.js';

let tmpDir: string;
const ADDR = PrivateKey.fromRandom().toAddress();
const DENIED = PrivateKey.fromRandom().toAddress();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-policy-cli-'));
  process.env.BSV_PAY_HOME = tmpDir;
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeCtx(): Ctx {
  return { out: new Output(true), json: true, network: 'main', config: { ...DEFAULT_CONFIG } };
}

function jsonOut(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
  return { stdout, stderr };
}

describe('policy show', () => {
  it('reports defaults when no policy.toml exists', () => {
    const { stdout } = jsonOut();
    cmdPolicyShow(makeCtx());
    const result = JSON.parse(stdout.join(''));
    expect(result).toMatchObject({
      ok: true,
      source: 'defaults',
      rules: { soft_spend_limit_sats: 100_000, allowlist: [], denylist: [] },
      pending_approvals: 0,
      approval_secret_configured: false,
    });
  });

  it('reports file rules, usage, and warns when the threshold has no secret', () => {
    fs.writeFileSync(
      policyPath(),
      [
        'per_tx_limit_sats = 50000',
        'daily_budget_sats = 200000',
        'approval_threshold_sats = 25000',
      ].join('\n'),
    );
    resetPolicyCacheForTests();
    const { stdout, stderr } = jsonOut();
    cmdPolicyShow(makeCtx());
    const result = JSON.parse(stdout.join(''));
    expect(result.source).toBe('file');
    expect(result.rules).toMatchObject({
      per_tx_limit_sats: 50_000,
      daily_budget_sats: 200_000,
      approval_threshold_sats: 25_000,
    });
    expect(result.rules.soft_spend_limit_sats).toBeUndefined(); // hard limit replaces it
    expect(stderr.join('')).toMatch(/no approval secret exists/i);
  });

  it('does not warn once the secret is configured', () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 25000');
    resetPolicyCacheForTests();
    storeApprovalSecret('s3cret');
    const { stdout, stderr } = jsonOut();
    cmdPolicyShow(makeCtx());
    expect(JSON.parse(stdout.join('')).approval_secret_configured).toBe(true);
    expect(stderr.join('')).not.toMatch(/no approval secret/i);
  });
});

describe('policy test', () => {
  it('exit 0 with decision allow inside policy', () => {
    const { stdout } = jsonOut();
    cmdPolicyTest(makeCtx(), ADDR, '5000');
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: true, decision: 'allow' });
  });

  it('throws exit 8 with the rule for a would-deny', () => {
    fs.writeFileSync(policyPath(), `denylist = ["${DENIED}"]`);
    resetPolicyCacheForTests();
    jsonOut();
    try {
      cmdPolicyTest(makeCtx(), DENIED, '5000');
      expect.unreachable();
    } catch (e) {
      const err = e as CliError;
      expect(err.exitCode).toBe(EXIT.SPEND_LIMIT);
      expect(err.errorCode).toBe('recipient_denied');
      expect(err.data).toMatchObject({ decision: 'deny', rule: 'denylist' });
    }
  });

  it('throws exit 9 for a would-queue', () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 1000');
    resetPolicyCacheForTests();
    jsonOut();
    try {
      cmdPolicyTest(makeCtx(), ADDR, '2000');
      expect.unreachable();
    } catch (e) {
      const err = e as CliError;
      expect(err.exitCode).toBe(EXIT.PENDING_APPROVAL);
      expect(err.data).toMatchObject({ decision: 'queue' });
    }
  });

  it('persists nothing — what-ifs are not decisions', () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 1000');
    resetPolicyCacheForTests();
    jsonOut();
    try {
      cmdPolicyTest(makeCtx(), ADDR, '2000');
    } catch {
      // expected
    }
    cmdPolicyTest(makeCtx(), ADDR, '500');
    expect(readLedger('main')).toEqual([]);
  });

  it('validates address and amount first (exit 2)', () => {
    jsonOut();
    try {
      cmdPolicyTest(makeCtx(), 'garbage', '5000');
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });
});
