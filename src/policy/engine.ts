import crypto from 'node:crypto';
import type { Config } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { appendLedger } from '../ledger.js';
import type { Network } from '../paths.js';
import { formatSats } from '../units.js';
import { readUsage, type SpendUsage } from './budget.js';
import { loadPolicy, type Policy } from './policy.js';

/**
 * THE policy gate (invariant 2). Every spend path — CLI send/donate, the
 * core library, the MCP server, the 402 client — reaches the network only
 * via core executeSend, and executeSend only accepts plans this module has
 * authorized. No flag, parameter, or tool argument can disable a policy.toml
 * rule; `softLimitConfirmed` satisfies only the legacy confirmable limit
 * that exists when no policy.toml hard limit is set (pre-Phase-2 behavior).
 */

export interface PolicyEnv {
  network: Network;
  config: Config;
}

export interface SpendRequest {
  to: string;
  amountSats: number;
  memo?: string;
  /** The human confirmed the legacy soft limit (interactive / --allow-large). */
  softLimitConfirmed?: boolean;
  confirmedOnly?: boolean;
}

export type Verdict =
  | { decision: 'allow'; rule: string; reason: string }
  | {
      decision: 'deny';
      rule: string;
      reason: string;
      errorCode: string;
      data: Record<string, unknown>;
    }
  | { decision: 'queue'; rule: string; reason: string; data: Record<string, unknown> };

/** Pure rule evaluation: deny wins, then queue, then allow. No I/O. */
export function evaluateSpend(policy: Policy, usage: SpendUsage, req: SpendRequest): Verdict {
  const { to, amountSats } = req;

  if (policy.denylist.includes(to)) {
    return {
      decision: 'deny',
      rule: 'denylist',
      reason: `recipient ${to} is denylisted`,
      errorCode: 'recipient_denied',
      data: { address: to },
    };
  }
  if (policy.allowlist.length > 0 && !policy.allowlist.includes(to)) {
    return {
      decision: 'deny',
      rule: 'allowlist',
      reason: `recipient ${to} is not on the allowlist`,
      errorCode: 'recipient_not_allowed',
      data: { address: to },
    };
  }
  if (policy.perTxLimitSats !== undefined && amountSats > policy.perTxLimitSats) {
    return {
      decision: 'deny',
      rule: 'per_tx_limit_sats',
      reason: `amount ${formatSats(amountSats)} exceeds the hard per-transaction limit of ${formatSats(policy.perTxLimitSats)}`,
      errorCode: 'per_tx_limit_exceeded',
      data: { limit_sats: policy.perTxLimitSats, amount_sats: amountSats },
    };
  }
  if (
    policy.softPerTxLimitSats !== undefined &&
    amountSats >= policy.softPerTxLimitSats &&
    !req.softLimitConfirmed
  ) {
    // Legacy confirmable limit — byte-compatible with pre-policy behavior.
    return {
      decision: 'deny',
      rule: 'spend_limit',
      reason: `amount ${formatSats(amountSats)} is at/above the ${formatSats(policy.softPerTxLimitSats)} per-transaction limit`,
      errorCode: 'spend_limit_exceeded',
      data: { limit_sats: policy.softPerTxLimitSats, amount_sats: amountSats },
    };
  }
  if (policy.sessionBudgetSats !== undefined) {
    const remaining = policy.sessionBudgetSats - usage.sessionSpentSats;
    if (amountSats > remaining) {
      return {
        decision: 'deny',
        rule: 'session_budget_sats',
        reason: `amount ${formatSats(amountSats)} exceeds the remaining session budget of ${formatSats(Math.max(0, remaining))}`,
        errorCode: 'session_budget_exceeded',
        data: {
          budget_sats: policy.sessionBudgetSats,
          spent_sats: usage.sessionSpentSats,
          remaining_sats: Math.max(0, remaining),
          amount_sats: amountSats,
        },
      };
    }
  }
  if (policy.dailyBudgetSats !== undefined) {
    const remaining = policy.dailyBudgetSats - usage.dailySpentSats;
    if (amountSats > remaining) {
      return {
        decision: 'deny',
        rule: 'daily_budget_sats',
        reason: `amount ${formatSats(amountSats)} exceeds the remaining 24h budget of ${formatSats(Math.max(0, remaining))}`,
        errorCode: 'daily_budget_exceeded',
        data: {
          budget_sats: policy.dailyBudgetSats,
          spent_sats: usage.dailySpentSats,
          remaining_sats: Math.max(0, remaining),
          amount_sats: amountSats,
        },
      };
    }
  }
  if (
    policy.rateLimitPerMinute !== undefined &&
    usage.sendsLastMinute >= policy.rateLimitPerMinute
  ) {
    return {
      decision: 'deny',
      rule: 'rate_limit_per_minute',
      reason: `rate limit reached: ${usage.sendsLastMinute} payment(s) in the last minute (max ${policy.rateLimitPerMinute})`,
      errorCode: 'rate_limit_exceeded',
      data: { limit: policy.rateLimitPerMinute, window: 'minute', sent: usage.sendsLastMinute },
    };
  }
  if (policy.rateLimitPerHour !== undefined && usage.sendsLastHour >= policy.rateLimitPerHour) {
    return {
      decision: 'deny',
      rule: 'rate_limit_per_hour',
      reason: `rate limit reached: ${usage.sendsLastHour} payment(s) in the last hour (max ${policy.rateLimitPerHour})`,
      errorCode: 'rate_limit_exceeded',
      data: { limit: policy.rateLimitPerHour, window: 'hour', sent: usage.sendsLastHour },
    };
  }
  if (policy.approvalThresholdSats !== undefined && amountSats >= policy.approvalThresholdSats) {
    return {
      decision: 'queue',
      rule: 'approval_threshold_sats',
      reason: `amount ${formatSats(amountSats)} is at/above the ${formatSats(policy.approvalThresholdSats)} approval threshold`,
      data: { threshold_sats: policy.approvalThresholdSats, amount_sats: amountSats },
    };
  }
  return { decision: 'allow', rule: 'default', reason: 'within policy' };
}

/** Proof an allow decision was made for exactly this recipient and amount. */
export interface SpendAuthorization {
  decisionId: string;
  to: string;
  amountSats: number;
  /** True when authorized in evaluate-only mode (dry runs): never executable for real. */
  evaluateOnly: boolean;
}

function throwVerdict(
  verdict: Exclude<Verdict, { decision: 'allow' }>,
  extra?: Record<string, unknown>,
): never {
  if (verdict.decision === 'deny') {
    throw new CliError(
      EXIT.SPEND_LIMIT,
      verdict.errorCode,
      `Denied by policy (${verdict.rule}): ${verdict.reason}.`,
      { rule: verdict.rule, ...verdict.data, ...extra },
    );
  }
  throw new CliError(
    EXIT.PENDING_APPROVAL,
    'pending_approval',
    `Queued for human approval (${verdict.rule}): ${verdict.reason}. Run "bsv-pay approvals list" to review.`,
    { rule: verdict.rule, ...verdict.data, ...extra },
  );
}

export interface AuthorizeOptions {
  /**
   * enforce: the decision is real — append it to the ledger (invariant 6),
   * queue approvals. evaluate: dry runs and `policy test` — same verdicts and
   * thrown errors, but nothing persisted and nothing queued.
   */
  mode: 'enforce' | 'evaluate';
}

/**
 * Decide a spend. Returns an authorization on allow; throws exit 8 on deny
 * and exit 9 on queue (after recording the decision — and, for queues, the
 * approval — in the ledger when mode is enforce).
 */
export function authorizeSpend(
  env: PolicyEnv,
  req: SpendRequest,
  opts: AuthorizeOptions,
): SpendAuthorization {
  const policy = loadPolicy(env.network, env.config);
  const verdict = evaluateSpend(policy, readUsage(env.network), req);
  return settle(env, req, verdict, opts.mode);
}

/**
 * Decide a previously queued spend in approval context: every rule except
 * the approval threshold still applies at approval time. Called ONLY by the
 * approvals command after the human passed the TTY + approval-secret gate;
 * not exported from the core public surface.
 */
export function authorizeApprovedSpend(
  env: PolicyEnv,
  req: SpendRequest,
  approvalId: string,
): SpendAuthorization {
  const policy = loadPolicy(env.network, env.config);
  const withoutThreshold: Policy = { ...policy, approvalThresholdSats: undefined };
  const verdict = evaluateSpend(withoutThreshold, readUsage(env.network), req);
  if (verdict.decision === 'allow') {
    return settle(
      env,
      req,
      { decision: 'allow', rule: 'approval', reason: `human-approved ${approvalId}` },
      'enforce',
    );
  }
  return settle(env, req, verdict, 'enforce', approvalId);
}

function settle(
  env: PolicyEnv,
  req: SpendRequest,
  verdict: Verdict,
  mode: 'enforce' | 'evaluate',
  approvalId?: string,
): SpendAuthorization {
  const decisionId = crypto.randomUUID();
  if (mode === 'evaluate') {
    if (verdict.decision !== 'allow') throwVerdict(verdict);
    return { decisionId, to: req.to, amountSats: req.amountSats, evaluateOnly: true };
  }

  const base = {
    type: 'policy_decision' as const,
    rule: verdict.rule,
    reason: verdict.reason,
    address: req.to,
    amount_sats: req.amountSats,
    memo: req.memo,
    timestamp: new Date().toISOString(),
    decision_id: decisionId,
  };
  if (verdict.decision === 'allow') {
    appendLedger(env.network, { ...base, decision: 'allow' });
    return { decisionId, to: req.to, amountSats: req.amountSats, evaluateOnly: false };
  }
  if (verdict.decision === 'deny') {
    appendLedger(env.network, { ...base, decision: 'deny' });
    throwVerdict(verdict);
  }
  const newApprovalId = approvalId ?? crypto.randomUUID();
  appendLedger(env.network, {
    ...base,
    decision: 'queue',
    approval_id: newApprovalId,
    confirmed_only: req.confirmedOnly,
  });
  throwVerdict(verdict, { approval_id: newApprovalId });
}

/**
 * Unforgeable plan registry: planSend records each authorized plan here;
 * executeSend refuses anything missing, mismatched, evaluate-only, or
 * already executed (one authorization = one broadcast). Module-private and
 * NOT exported from bsv-pay/core — a hand-built plan can never pass.
 */
const authorizedPlans = new WeakMap<object, SpendAuthorization>();

export function registerAuthorizedPlan(plan: object, auth: SpendAuthorization): void {
  authorizedPlans.set(plan, auth);
}

export function takeAuthorizedPlan(
  plan: object,
  expected: { to: string; amountSats: number },
  forBroadcast: boolean,
): SpendAuthorization {
  const auth = authorizedPlans.get(plan);
  if (!auth || auth.to !== expected.to || auth.amountSats !== expected.amountSats) {
    throw new CliError(
      EXIT.SPEND_LIMIT,
      'unauthorized_spend',
      'This spend was not authorized by the policy gate. Plans must come from planSend(); they cannot be constructed or altered by hand.',
    );
  }
  if (forBroadcast) {
    if (auth.evaluateOnly) {
      throw new CliError(
        EXIT.SPEND_LIMIT,
        'unauthorized_spend',
        'This plan was authorized for a dry run only. Re-plan without dryRun to broadcast.',
      );
    }
    authorizedPlans.delete(plan); // consumed: one authorization, one broadcast
  }
  return auth;
}
