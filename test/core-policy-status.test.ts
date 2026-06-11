import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { DEFAULT_CONFIG } from '../src/config.js';
import { appendLedger } from '../src/ledger.js';
import { policyPath } from '../src/paths.js';
import { storeApprovalSecret } from '../src/policy/approvals.js';
import { addSessionSpent, resetSessionSpentForTests } from '../src/policy/budget.js';
import { resetPolicyCacheForTests } from '../src/policy/policy.js';
import { getPolicyStatus } from '../src/core/index.js';

let tmpDir: string;
const TO = PrivateKey.fromRandom().toAddress();
const BLOCKED = PrivateKey.fromRandom().toAddress();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-policy-status-'));
  process.env.BSV_PAY_HOME = tmpDir;
  resetPolicyCacheForTests();
  resetSessionSpentForTests();
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ledgerSend(amountSats: number, agoMs: number): void {
  appendLedger('main', {
    type: 'send',
    txid: 'a'.repeat(64),
    amount_sats: amountSats,
    address: TO,
    timestamp: new Date(Date.now() - agoMs).toISOString(),
    status: 'confirmed',
  });
}

describe('getPolicyStatus', () => {
  it('defaults (no policy.toml): only the legacy soft limit, everything else open', () => {
    const status = getPolicyStatus({ network: 'main', config: { ...DEFAULT_CONFIG } });
    expect(status.source).toBe('defaults');
    expect(status.network).toBe('main');
    expect(status.softPerTxLimitSats).toBe(DEFAULT_CONFIG.spendLimitSats);
    expect(status.perTxLimitSats).toBeUndefined();
    expect(status.dailyBudgetSats).toBeUndefined();
    expect(status.dailyRemainingSats).toBeUndefined();
    expect(status.sessionRemainingSats).toBeUndefined();
    expect(status.remainingThisMinute).toBeUndefined();
    expect(status.approvalSecretConfigured).toBe(false);
    expect(status.allowlist).toEqual([]);
    expect(status.denylist).toEqual([]);
    expect(status.pendingApprovals).toEqual([]);
  });

  it('file policy: budgets and rates with remaining recomputed from the ledger', () => {
    fs.writeFileSync(
      policyPath(),
      [
        'per_tx_limit_sats = 50000',
        'daily_budget_sats = 10000',
        'session_budget_sats = 4000',
        'rate_limit_per_minute = 5',
        'rate_limit_per_hour = 20',
        `denylist = ["${BLOCKED}"]`,
      ].join('\n'),
    );
    ledgerSend(3000, 60_000); // counts: daily, hour, minute? 60s ago — minute window is < 60s, so hour only
    ledgerSend(1000, 10_000); // counts: daily, hour, minute
    ledgerSend(9999, 25 * 3_600_000); // >24h old: ignored everywhere
    addSessionSpent('main', 1500);

    const status = getPolicyStatus({ network: 'main', config: { ...DEFAULT_CONFIG } });
    expect(status.source).toBe('file');
    expect(status.perTxLimitSats).toBe(50_000);
    expect(status.softPerTxLimitSats).toBeUndefined(); // hard limit displaces the legacy one
    expect(status.dailyBudgetSats).toBe(10_000);
    expect(status.dailyRemainingSats).toBe(6_000);
    expect(status.sessionBudgetSats).toBe(4_000);
    expect(status.sessionRemainingSats).toBe(2_500);
    expect(status.usage).toEqual({
      dailySpentSats: 4_000,
      sessionSpentSats: 1_500,
      sendsLastMinute: 1,
      sendsLastHour: 2,
    });
    expect(status.remainingThisMinute).toBe(4);
    expect(status.remainingThisHour).toBe(18);
    expect(status.denylist).toEqual([BLOCKED]);
  });

  it('remaining clamps at 0 when the ledger already exceeds the budget', () => {
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 1000');
    ledgerSend(2500, 10_000);
    const status = getPolicyStatus({ network: 'main', config: { ...DEFAULT_CONFIG } });
    expect(status.usage.dailySpentSats).toBe(2_500);
    expect(status.dailyRemainingSats).toBe(0);
  });

  it('pending approvals: queued minus resolved, with the secret flag', () => {
    fs.writeFileSync(policyPath(), 'approval_threshold_sats = 5000');
    appendLedger('main', {
      type: 'policy_decision',
      decision: 'queue',
      rule: 'approval_threshold_sats',
      reason: 'at/above the approval threshold',
      address: TO,
      amount_sats: 7000,
      memo: 'server invoice',
      timestamp: new Date().toISOString(),
      decision_id: 'd-1',
      approval_id: 'appr-1',
    });
    appendLedger('main', {
      type: 'policy_decision',
      decision: 'queue',
      rule: 'approval_threshold_sats',
      reason: 'at/above the approval threshold',
      address: TO,
      amount_sats: 9000,
      timestamp: new Date().toISOString(),
      decision_id: 'd-2',
      approval_id: 'appr-2',
    });
    appendLedger('main', {
      type: 'approval_resolved',
      approval_id: 'appr-2',
      resolution: 'rejected',
      timestamp: new Date().toISOString(),
    });

    let status = getPolicyStatus({ network: 'main', config: { ...DEFAULT_CONFIG } });
    expect(status.approvalThresholdSats).toBe(5_000);
    expect(status.approvalSecretConfigured).toBe(false);
    expect(status.pendingApprovals).toHaveLength(1);
    expect(status.pendingApprovals[0]).toMatchObject({
      approvalId: 'appr-1',
      address: TO,
      amountSats: 7000,
      memo: 'server invoice',
    });

    storeApprovalSecret('a-secret-the-status-must-never-echo');
    status = getPolicyStatus({ network: 'main', config: { ...DEFAULT_CONFIG } });
    expect(status.approvalSecretConfigured).toBe(true);
    // the status carries a flag only — never the secret or its hash
    expect(JSON.stringify(status)).not.toMatch(/secret-the-status|hash|argon/i);
  });

  it('networks stay separate: testnet status reads the testnet ledger only', () => {
    ledgerSend(3000, 10_000); // mainnet ledger
    fs.writeFileSync(policyPath(), 'daily_budget_sats = 10000');
    const status = getPolicyStatus({ network: 'test', config: { ...DEFAULT_CONFIG } });
    expect(status.usage.dailySpentSats).toBe(0);
    expect(status.dailyRemainingSats).toBe(10_000);
  });
});
