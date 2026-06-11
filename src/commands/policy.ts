import chalk from 'chalk';
import { validateAddress } from '../address.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { policyPath } from '../paths.js';
import { approvalSecretConfigured, listPendingApprovals } from '../policy/approvals.js';
import { readUsage } from '../policy/budget.js';
import { evaluateSpend } from '../policy/engine.js';
import { loadPolicy } from '../policy/policy.js';
import { formatSats, parseAmount } from '../units.js';

export function cmdPolicyShow(ctx: Ctx): void {
  const policy = loadPolicy(ctx.network, ctx.config);
  const usage = readUsage(ctx.network);
  const pending = listPendingApprovals(ctx.network);
  const secretConfigured = approvalSecretConfigured();

  const fromFile = policy.source === 'file';
  ctx.out.info(
    chalk.bold(
      `Policy (${ctx.network === 'test' ? 'testnet' : 'mainnet'}) — ${fromFile ? policyPath() : 'defaults (no policy.toml)'}`,
    ),
  );
  if (policy.perTxLimitSats !== undefined) {
    ctx.out.info(
      `  Per-tx limit:        ${formatSats(policy.perTxLimitSats)} (hard — no override)`,
    );
  } else if (policy.softPerTxLimitSats !== undefined) {
    ctx.out.info(
      `  Per-tx limit:        ${formatSats(policy.softPerTxLimitSats)} (soft — interactive confirm / --allow-large)`,
    );
  }
  if (policy.dailyBudgetSats !== undefined) {
    ctx.out.info(
      `  Daily budget:        ${formatSats(policy.dailyBudgetSats)} (spent ${formatSats(usage.dailySpentSats)} in 24h, ${formatSats(Math.max(0, policy.dailyBudgetSats - usage.dailySpentSats))} left)`,
    );
  }
  if (policy.sessionBudgetSats !== undefined) {
    ctx.out.info(
      `  Session budget:      ${formatSats(policy.sessionBudgetSats)} (this process has spent ${formatSats(usage.sessionSpentSats)})`,
    );
  }
  if (policy.rateLimitPerMinute !== undefined || policy.rateLimitPerHour !== undefined) {
    ctx.out.info(
      `  Rate limit:          ${policy.rateLimitPerMinute ?? '∞'}/min, ${policy.rateLimitPerHour ?? '∞'}/hour (sent ${usage.sendsLastMinute} last min, ${usage.sendsLastHour} last hour)`,
    );
  }
  if (policy.approvalThresholdSats !== undefined) {
    ctx.out.info(
      `  Approval threshold:  ${formatSats(policy.approvalThresholdSats)} (secret ${secretConfigured ? 'configured' : chalk.red('NOT SET — queued payments cannot be approved')})`,
    );
  }
  if (policy.allowlist.length > 0)
    ctx.out.info(`  Allowlist:           ${policy.allowlist.length} address(es)`);
  if (policy.denylist.length > 0)
    ctx.out.info(`  Denylist:            ${policy.denylist.length} address(es)`);
  ctx.out.info(`  Pending approvals:   ${pending.length}`);
  if (!fromFile) {
    ctx.out.info('');
    ctx.out.info(
      `No policy.toml — only the legacy spend limit applies. Create ${policyPath()} to govern agents.`,
    );
  }
  if (policy.approvalThresholdSats !== undefined && !secretConfigured) {
    process.stderr.write(
      chalk.yellow(
        'WARNING: approval_threshold_sats is set but no approval secret exists. Run "bsv-pay approvals set-secret" or queued payments can never be approved.',
      ) + '\n',
    );
  }

  ctx.out.result({
    ok: true,
    source: policy.source,
    network: ctx.network,
    rules: {
      ...(policy.perTxLimitSats !== undefined && { per_tx_limit_sats: policy.perTxLimitSats }),
      ...(policy.softPerTxLimitSats !== undefined && {
        soft_spend_limit_sats: policy.softPerTxLimitSats,
      }),
      ...(policy.dailyBudgetSats !== undefined && { daily_budget_sats: policy.dailyBudgetSats }),
      ...(policy.sessionBudgetSats !== undefined && {
        session_budget_sats: policy.sessionBudgetSats,
      }),
      ...(policy.rateLimitPerMinute !== undefined && {
        rate_limit_per_minute: policy.rateLimitPerMinute,
      }),
      ...(policy.rateLimitPerHour !== undefined && {
        rate_limit_per_hour: policy.rateLimitPerHour,
      }),
      ...(policy.approvalThresholdSats !== undefined && {
        approval_threshold_sats: policy.approvalThresholdSats,
      }),
      allowlist: policy.allowlist,
      denylist: policy.denylist,
    },
    usage: {
      daily_spent_sats: usage.dailySpentSats,
      session_spent_sats: usage.sessionSpentSats,
      sends_last_minute: usage.sendsLastMinute,
      sends_last_hour: usage.sendsLastHour,
    },
    approval_secret_configured: secretConfigured,
    pending_approvals: pending.length,
  });
}

/**
 * Dry-run a policy decision: exit 0 = would allow, 8 = would deny,
 * 9 = would queue. Evaluates as an unattended spend (no soft-limit
 * confirmation) and persists nothing — what-ifs are not decisions.
 */
export function cmdPolicyTest(ctx: Ctx, address: string, amountArg: string): void {
  validateAddress(address, ctx.network);
  const amountSats = parseAmount(amountArg);
  const policy = loadPolicy(ctx.network, ctx.config);
  const verdict = evaluateSpend(policy, readUsage(ctx.network), { to: address, amountSats });

  if (verdict.decision === 'allow') {
    ctx.out.info(chalk.green(`ALLOW (${verdict.rule}): ${verdict.reason}.`));
    ctx.out.result({ ok: true, decision: 'allow', rule: verdict.rule, reason: verdict.reason });
    return;
  }
  if (verdict.decision === 'deny') {
    throw new CliError(
      EXIT.SPEND_LIMIT,
      verdict.errorCode,
      `Would be denied (${verdict.rule}): ${verdict.reason}.`,
      { decision: 'deny', rule: verdict.rule, ...verdict.data },
    );
  }
  throw new CliError(
    EXIT.PENDING_APPROVAL,
    'pending_approval',
    `Would be queued for approval (${verdict.rule}): ${verdict.reason}.`,
    { decision: 'queue', rule: verdict.rule, ...verdict.data },
  );
}
