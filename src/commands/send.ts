import chalk from 'chalk';
import { validateAddress } from '../address.js';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { executeSend, explorerTxUrl, planSend } from '../core/send.js';
import { openWallet } from '../core/wallet.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { ask, confirm, isInteractive } from '../prompt.js';
import { formatSats, parseAmount } from '../units.js';
import { obtainPassphrase } from '../wallet/wallet.js';

export { explorerTxUrl };

export interface SendOptions {
  yes?: boolean;
  allowLarge?: boolean;
  dryRun?: boolean;
  confirmedOnly?: boolean;
}

/**
 * Spend-limit policy (invariant 4): at/above the limit, an explicit
 * interactive confirmation is required; scripts need --yes --allow-large.
 */
async function enforceSpendLimit(ctx: Ctx, amountSats: number, opts: SendOptions): Promise<void> {
  const limit = ctx.config.spendLimitSats;
  if (amountSats < limit) return;
  if (opts.yes) {
    if (opts.allowLarge) return;
    throw new CliError(
      EXIT.SPEND_LIMIT,
      'spend_limit_exceeded',
      `Amount ${formatSats(amountSats)} is at/above your ${formatSats(limit)} per-transaction limit. ` +
        'Add --allow-large alongside --yes, or raise spend_limit_sats in config.toml.',
      { limit_sats: limit, amount_sats: amountSats },
    );
  }
  if (!isInteractive()) {
    throw new CliError(
      EXIT.SPEND_LIMIT,
      'spend_limit_exceeded',
      `Amount ${formatSats(amountSats)} is at/above your ${formatSats(limit)} limit and there is no terminal to confirm. Use --yes --allow-large in scripts.`,
      { limit_sats: limit, amount_sats: amountSats },
    );
  }
  process.stderr.write(
    chalk.yellow(`This send is at/above your spend limit of ${formatSats(limit)}.`) + '\n',
  );
  const typed = await ask(`Type the amount in sats (${amountSats}) to proceed: `);
  if (typed.trim() !== String(amountSats)) {
    throw new CliError(
      EXIT.SPEND_LIMIT,
      'spend_limit_exceeded',
      'Confirmation did not match; nothing was sent.',
    );
  }
}

export async function cmdSend(
  ctx: Ctx,
  address: string,
  amountArg: string,
  memo: string | undefined,
  opts: SendOptions,
  provider?: ChainProvider,
): Promise<void> {
  // 1. Validate everything local BEFORE unlocking or touching the network
  //    (invariant 4): address, amount, then the spend limit — a script that
  //    is over the limit fails fast with exit 8, not after network calls.
  validateAddress(address, ctx.network);
  const amountSats = parseAmount(amountArg);
  await enforceSpendLimit(ctx, amountSats, opts);

  const core = { network: ctx.network, config: ctx.config, provider };
  const wallet = await openWallet({
    ...core,
    passphrase: () => obtainPassphrase(), // env var, then interactive prompt
    onWarning: (text) => process.stderr.write(text + '\n'),
  });

  // 2. Gather funds and plan the transaction. The CLI enforced its limit
  //    above (interactively when needed), so the core guard is satisfied.
  const plan = await planSend(wallet, core, {
    to: address,
    amountSats,
    memo,
    confirmedOnly: opts.confirmedOnly,
    allowAboveLimit: true,
    dryRun: opts.dryRun,
  });

  // 3. Per-send confirmation (always shows recipient, amount, fee, and
  //    resulting balance before broadcast).
  if (opts.dryRun) {
    process.stderr.write(chalk.bold('Dry run — nothing will be broadcast.') + '\n');
  }
  const summaryLines = [
    `  Recipient:        ${address}`,
    `  Amount:           ${formatSats(amountSats)}`,
    plan.external
      ? `  Fee:              ~${plan.feeSats} sats estimated (the external wallet sets the real fee)`
      : `  Fee:              ${plan.feeSats} sats (${ctx.config.feeRateSatsPerKb} sats/KB, ${plan.inputCount} input${plan.inputCount === 1 ? '' : 's'})`,
    `  Balance after:    ${plan.external ? '~' : ''}${formatSats(plan.balanceAfterSats)}`,
  ];
  if (plan.external) {
    summaryLines.push(
      '  Custody:          external BRC-100 wallet app (it may ask you to approve)',
    );
  }
  if (memo) summaryLines.push(`  Memo (local):     ${memo}`);
  for (const line of summaryLines) process.stderr.write(line + '\n');

  if (!opts.yes && !opts.dryRun) {
    if (!isInteractive()) {
      throw usageError(
        'confirmation_required',
        'send needs a confirmation prompt but no terminal is available. Pass --yes in scripts.',
      );
    }
    if (!(await confirm('Send it?'))) {
      throw usageError('aborted', 'Send cancelled; nothing was broadcast.');
    }
  }

  // 4. Sign, broadcast, and record via core (ledger writes live there).
  const result = await executeSend(wallet, core, plan, { dryRun: opts.dryRun });

  if (result.dryRun) {
    ctx.out.info(chalk.bold('Dry run complete (not broadcast).'));
    if (result.external) {
      ctx.out.info('  Txid (if sent):   decided by the external wallet');
    } else {
      ctx.out.info(`  Txid (if sent):   ${result.txid}`);
      ctx.out.info(`  Size:             ${result.sizeBytes} bytes`);
    }
    ctx.out.result({
      ok: true,
      dry_run: true,
      txid: result.txid,
      recipient: address,
      amount_sats: result.amountSats,
      fee_sats: result.feeSats,
      change_sats: result.changeSats,
      balance_after_sats: result.balanceAfterSats,
      ...(result.feeEstimated ? { fee_estimated: true } : {}),
      ...(result.external ? { backend: 'brc100' } : {}),
    });
    return;
  }

  ctx.out.info(chalk.green('Sent.'));
  ctx.out.info(`  Txid:           ${result.txid}`);
  ctx.out.info(`  Explorer:       ${result.explorerUrl}`);
  ctx.out.info(`  New balance:    ~${formatSats(result.balanceAfterSats)} (pending confirmation)`);
  ctx.out.result({
    ok: true,
    txid: result.txid,
    recipient: address,
    amount_sats: result.amountSats,
    fee_sats: result.feeSats,
    change_sats: result.changeSats,
    balance_after_sats: result.balanceAfterSats,
    explorer_url: result.explorerUrl,
    ...(result.feeEstimated ? { fee_estimated: true } : {}),
    ...(result.external ? { backend: 'brc100' } : {}),
  });
}
