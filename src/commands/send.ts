import chalk from 'chalk';
import { validateAddress } from '../address.js';
import type { ChainProvider } from '../chain/provider.js';
import { WhatsOnChainProvider } from '../chain/whatsonchain.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { appendLedger } from '../ledger.js';
import { ask, confirm, isInteractive } from '../prompt.js';
import { buildSignedTx, selectUtxos, type SpendableUtxo } from '../tx.js';
import { formatSats, parseAmount } from '../units.js';
import { Wallet } from '../wallet/wallet.js';

export interface SendOptions {
  yes?: boolean;
  allowLarge?: boolean;
  dryRun?: boolean;
  confirmedOnly?: boolean;
}

export function explorerTxUrl(network: 'main' | 'test', txid: string): string {
  return network === 'test'
    ? `https://test.whatsonchain.com/tx/${txid}`
    : `https://whatsonchain.com/tx/${txid}`;
}

async function gatherSpendableUtxos(
  wallet: Wallet,
  chain: ChainProvider,
  confirmedOnly: boolean,
): Promise<SpendableUtxo[]> {
  const utxos: SpendableUtxo[] = [];
  for (const tracked of wallet.trackedAddresses()) {
    const rows = await chain.getUtxos(tracked.address);
    for (const u of rows) {
      // spend unconfirmed change by default; --confirmed-only restricts
      if (confirmedOnly && (u.height === undefined || u.height <= 0)) continue;
      utxos.push({ ...u, address: tracked.address });
    }
  }
  return utxos;
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
  const chain = provider ?? new WhatsOnChainProvider(ctx.network);

  // 1. Validate everything local BEFORE touching the network (invariant 4).
  validateAddress(address, ctx.network);
  const amountSats = parseAmount(amountArg);
  const wallet = await Wallet.unlock(ctx.network);

  // 2. Gather funds and plan the transaction.
  const utxos = await gatherSpendableUtxos(wallet, chain, Boolean(opts.confirmedOnly));
  const selection = selectUtxos(utxos, amountSats, ctx.config.feeRateSatsPerKb);
  const totalAvailable = utxos.reduce((s, u) => s + u.satoshis, 0);
  const balanceAfter = totalAvailable - amountSats - selection.fee;
  const change = wallet.peekAddress('change');

  // 3. Spend limit, then per-send confirmation (always shows recipient,
  //    amount, fee, and resulting balance before broadcast).
  await enforceSpendLimit(ctx, amountSats, opts);

  if (opts.dryRun) {
    process.stderr.write(chalk.bold('Dry run — nothing will be broadcast.') + '\n');
  }
  const summaryLines = [
    `  Recipient:        ${address}`,
    `  Amount:           ${formatSats(amountSats)}`,
    `  Fee:              ${selection.fee} sats (${ctx.config.feeRateSatsPerKb} sats/KB, ${selection.selected.length} input${selection.selected.length === 1 ? '' : 's'})`,
    `  Balance after:    ${formatSats(balanceAfter)}`,
  ];
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

  // 4. Build + sign.
  const tx = await buildSignedTx(wallet, selection, address, amountSats, change.address);
  const txid = tx.id('hex');

  if (opts.dryRun) {
    ctx.out.info(chalk.bold('Dry run complete (not broadcast).'));
    ctx.out.info(`  Txid (if sent):   ${txid}`);
    ctx.out.info(`  Size:             ${tx.toHex().length / 2} bytes`);
    ctx.out.result({
      ok: true,
      dry_run: true,
      txid,
      recipient: address,
      amount_sats: amountSats,
      fee_sats: selection.fee,
      change_sats: selection.changeSats,
      balance_after_sats: balanceAfter,
    });
    return;
  }

  // 5. Persist the change address only on a real broadcast path.
  if (selection.changeSats > 0) wallet.issueAddress('change', `change for ${txid.slice(0, 12)}`);

  try {
    const result = await chain.broadcast(tx.toHex());
    if (!result.ok) {
      throw new CliError(
        EXIT.BROADCAST_REJECTED,
        'broadcast_rejected',
        `The network rejected the transaction: ${result.error ?? 'no reason given'}. ` +
          'Nothing was spent. Check the fee rate in config.toml or retry shortly.',
        { txid },
      );
    }
  } catch (e) {
    if (e instanceof CliError && e.exitCode === EXIT.BROADCAST_REJECTED) throw e;
    // Ambiguous network failure: the tx may have propagated. Exit 6, still print txid.
    appendLedger(ctx.network, {
      type: 'send',
      txid,
      amount_sats: amountSats,
      address,
      memo,
      timestamp: new Date().toISOString(),
      status: 'unknown',
      fee_sats: selection.fee,
    });
    throw new CliError(
      EXIT.BROADCAST_UNKNOWN,
      'broadcast_status_unknown',
      `Broadcast status unknown (network failure mid-send). txid ${txid} — check ${explorerTxUrl(ctx.network, txid)} before retrying; the funds may already have moved.`,
      { txid, explorer_url: explorerTxUrl(ctx.network, txid) },
    );
  }

  appendLedger(ctx.network, {
    type: 'send',
    txid,
    amount_sats: amountSats,
    address,
    memo,
    timestamp: new Date().toISOString(),
    status: 'pending',
    fee_sats: selection.fee,
  });

  ctx.out.info(chalk.green('Sent.'));
  ctx.out.info(`  Txid:           ${txid}`);
  ctx.out.info(`  Explorer:       ${explorerTxUrl(ctx.network, txid)}`);
  ctx.out.info(`  New balance:    ~${formatSats(balanceAfter)} (pending confirmation)`);
  ctx.out.result({
    ok: true,
    txid,
    recipient: address,
    amount_sats: amountSats,
    fee_sats: selection.fee,
    change_sats: selection.changeSats,
    balance_after_sats: balanceAfter,
    explorer_url: explorerTxUrl(ctx.network, txid),
  });
}
