import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { executeSend, planApprovedSend } from '../core/send.js';
import { openWallet } from '../core/wallet.js';
import { usageError } from '../errors.js';
import {
  approvalSecretConfigured,
  badApprovalSecret,
  findPendingApproval,
  listPendingApprovals,
  resolveApproval,
  storeApprovalSecret,
  verifyApprovalSecret,
} from '../policy/approvals.js';
import { askHidden, isInteractive } from '../prompt.js';
import { formatSats } from '../units.js';
import { obtainPassphrase } from '../wallet/wallet.js';

/**
 * Test seam ONLY: lets unit tests inject the hidden prompts. There is no
 * CLI flag, env var, or config key that reaches these — the cli.ts wiring
 * never passes them, so the only way to supply a secret to the real binary
 * is typing it at a TTY.
 */
export interface ApprovalPromptDeps {
  promptSecret?: () => Promise<string>;
}

/** Approval verbs are human-only: a piped/agent shell has no TTY and stops here. */
function requireTty(action: string): void {
  if (!isInteractive()) {
    throw usageError(
      'tty_required',
      `${action} requires an interactive terminal. There is deliberately no flag or environment variable for it — a human must type the approval secret.`,
    );
  }
}

async function requireApprovalSecret(deps?: ApprovalPromptDeps): Promise<void> {
  if (!approvalSecretConfigured()) {
    throw usageError(
      'approval_secret_missing',
      'No approval secret is set. A human must run "bsv-pay approvals set-secret" (interactive) before queued payments can be approved or rejected.',
    );
  }
  const prompt = deps?.promptSecret ?? (() => askHidden('Approval secret: '));
  const secret = await prompt();
  if (!verifyApprovalSecret(secret)) throw badApprovalSecret();
}

export function cmdApprovalsList(ctx: Ctx): void {
  const pending = listPendingApprovals(ctx.network);
  if (pending.length === 0) {
    ctx.out.info('No pending approvals.');
  } else {
    ctx.out.info(
      chalk.bold(`Pending approvals (${ctx.network === 'test' ? 'testnet' : 'mainnet'})`),
    );
    for (const p of pending) {
      ctx.out.info(
        `  ${p.approvalId.slice(0, 8)}  ${formatSats(p.amountSats)}  -> ${p.address}` +
          `${p.memo ? `  "${p.memo}"` : ''}  (queued ${p.queuedAt})`,
      );
    }
    ctx.out.info('');
    ctx.out.info('Approve with: bsv-pay approvals approve <id>   (requires the approval secret)');
  }
  ctx.out.result({
    ok: true,
    approvals: pending.map((p) => ({
      id: p.approvalId,
      address: p.address,
      amount_sats: p.amountSats,
      ...(p.memo ? { memo: p.memo } : {}),
      queued_at: p.queuedAt,
    })),
  });
}

export async function cmdApprovalsApprove(
  ctx: Ctx,
  id: string,
  provider?: ChainProvider,
  deps?: ApprovalPromptDeps,
): Promise<void> {
  requireTty('Approving a payment');
  const pending = findPendingApproval(ctx.network, id);
  await requireApprovalSecret(deps);

  const core = { network: ctx.network, config: ctx.config, provider };
  const wallet = await openWallet({
    ...core,
    passphrase: () => obtainPassphrase(),
    onWarning: (text) => process.stderr.write(text + '\n'),
  });
  // Re-decided now, against today's ledger: every rule except the threshold
  // still applies. A deny here leaves the approval pending.
  const plan = await planApprovedSend(
    wallet,
    core,
    {
      to: pending.address,
      amountSats: pending.amountSats,
      memo: pending.memo,
      confirmedOnly: pending.confirmedOnly,
    },
    pending.approvalId,
  );
  const result = await executeSend(wallet, core, plan);
  resolveApproval(ctx.network, pending.approvalId, 'approved', result.txid);

  ctx.out.info(chalk.green('Approved and sent.'));
  ctx.out.info(`  Approval:       ${pending.approvalId}`);
  ctx.out.info(`  Txid:           ${result.txid}`);
  ctx.out.info(`  Explorer:       ${result.explorerUrl}`);
  ctx.out.result({
    ok: true,
    approval_id: pending.approvalId,
    txid: result.txid,
    recipient: pending.address,
    amount_sats: result.amountSats,
    fee_sats: result.feeSats,
    explorer_url: result.explorerUrl,
  });
}

export async function cmdApprovalsReject(
  ctx: Ctx,
  id: string,
  deps?: ApprovalPromptDeps,
): Promise<void> {
  requireTty('Rejecting a payment');
  const pending = findPendingApproval(ctx.network, id);
  await requireApprovalSecret(deps);
  resolveApproval(ctx.network, pending.approvalId, 'rejected');
  ctx.out.info(chalk.yellow(`Rejected ${pending.approvalId} — nothing was sent.`));
  ctx.out.result({ ok: true, approval_id: pending.approvalId, resolution: 'rejected' });
}

export interface SetSecretPromptDeps {
  promptOldSecret?: () => Promise<string>;
  promptNewSecret?: () => Promise<string>;
}

export async function cmdApprovalsSetSecret(ctx: Ctx, deps?: SetSecretPromptDeps): Promise<void> {
  requireTty('Setting the approval secret');
  if (approvalSecretConfigured()) {
    const promptOld = deps?.promptOldSecret ?? (() => askHidden('Current approval secret: '));
    if (!verifyApprovalSecret(await promptOld())) throw badApprovalSecret();
  }
  const promptNew = deps?.promptNewSecret ?? (() => askHidden('New approval secret: '));
  const first = await promptNew();
  if (first === '') {
    throw usageError('empty_approval_secret', 'The approval secret cannot be empty.');
  }
  const second = await (deps?.promptNewSecret
    ? deps.promptNewSecret()
    : askHidden('Repeat approval secret: '));
  if (first !== second) {
    throw usageError('approval_secret_mismatch', 'The secrets do not match; nothing was changed.');
  }
  storeApprovalSecret(first);
  process.stderr.write(
    chalk.yellow(
      'Approval secret set. Keep it in your head: never in a file, script, or environment variable — that separation is what stops an agent from approving its own payments.',
    ) + '\n',
  );
  ctx.out.result({ ok: true, approval_secret_configured: true });
}
