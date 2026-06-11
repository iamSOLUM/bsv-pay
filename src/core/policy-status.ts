import { loadConfig } from '../config.js';
import { approvalSecretConfigured, listPendingApprovals } from '../policy/approvals.js';
import { readUsage } from '../policy/budget.js';
import { loadPolicy } from '../policy/policy.js';
import type { Network } from '../paths.js';
import type { CoreOptions } from './context.js';

export interface PendingApprovalStatus {
  approvalId: string;
  address: string;
  amountSats: number;
  memo?: string;
  confirmedOnly?: boolean;
  queuedAt: string;
}

/**
 * A point-in-time view of the active policy and how much headroom is left.
 * Limits that are not configured are absent (absent = unlimited, except the
 * per-tx pair where absent means "only the other one applies"). Remaining
 * values are clamped at 0 — they are planning hints, not promises: the
 * binding check is the policy gate at spend time.
 */
export interface PolicyStatusResult {
  source: 'defaults' | 'file';
  network: Network;
  /** Hard per-transaction cap (policy.toml). No override exists. */
  perTxLimitSats?: number;
  /** Legacy confirmable limit from config.toml (pre-policy behavior). */
  softPerTxLimitSats?: number;
  dailyBudgetSats?: number;
  dailyRemainingSats?: number;
  sessionBudgetSats?: number;
  sessionRemainingSats?: number;
  rateLimitPerMinute?: number;
  remainingThisMinute?: number;
  rateLimitPerHour?: number;
  remainingThisHour?: number;
  /** At/above this, spends queue for human approval instead of sending. */
  approvalThresholdSats?: number;
  /** False with a threshold set means queued payments cannot be approved. */
  approvalSecretConfigured: boolean;
  /** When non-empty, only these recipients are allowed. */
  allowlist: string[];
  /** Always wins over everything else. */
  denylist: string[];
  usage: {
    dailySpentSats: number;
    sessionSpentSats: number;
    sendsLastMinute: number;
    sendsLastHour: number;
  };
  pendingApprovals: PendingApprovalStatus[];
}

/**
 * Read the active policy, current usage (recomputed from the ledger), and
 * the pending-approval queue. No wallet unlock, no network I/O — works
 * before init and never touches keys. This is what agents should call to
 * plan within their allowance instead of discovering denials by failing.
 */
export function getPolicyStatus(opts: CoreOptions): PolicyStatusResult {
  const config = { ...loadConfig(), ...opts.config };
  const policy = loadPolicy(opts.network, config);
  const usage = readUsage(opts.network);
  const pending = listPendingApprovals(opts.network);

  const remaining = (budget: number | undefined, used: number): number | undefined =>
    budget === undefined ? undefined : Math.max(0, budget - used);

  return {
    source: policy.source,
    network: opts.network,
    perTxLimitSats: policy.perTxLimitSats,
    softPerTxLimitSats: policy.softPerTxLimitSats,
    dailyBudgetSats: policy.dailyBudgetSats,
    dailyRemainingSats: remaining(policy.dailyBudgetSats, usage.dailySpentSats),
    sessionBudgetSats: policy.sessionBudgetSats,
    sessionRemainingSats: remaining(policy.sessionBudgetSats, usage.sessionSpentSats),
    rateLimitPerMinute: policy.rateLimitPerMinute,
    remainingThisMinute: remaining(policy.rateLimitPerMinute, usage.sendsLastMinute),
    rateLimitPerHour: policy.rateLimitPerHour,
    remainingThisHour: remaining(policy.rateLimitPerHour, usage.sendsLastHour),
    approvalThresholdSats: policy.approvalThresholdSats,
    approvalSecretConfigured: approvalSecretConfigured(),
    allowlist: [...policy.allowlist],
    denylist: [...policy.denylist],
    usage: {
      dailySpentSats: usage.dailySpentSats,
      sessionSpentSats: usage.sessionSpentSats,
      sendsLastMinute: usage.sendsLastMinute,
      sendsLastHour: usage.sendsLastHour,
    },
    pendingApprovals: pending.map((p) => ({
      approvalId: p.approvalId,
      address: p.address,
      amountSats: p.amountSats,
      memo: p.memo,
      confirmedOnly: p.confirmedOnly,
      queuedAt: p.queuedAt,
    })),
  };
}
