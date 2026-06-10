import { validateAddress } from '../address.js';
import type { ChainProvider } from '../chain/provider.js';
import { CliError, EXIT } from '../errors.js';
import { appendLedger } from '../ledger.js';
import type { Network } from '../paths.js';
import { buildSignedTx, selectUtxos, type SpendableUtxo } from '../tx.js';
import { formatSats } from '../units.js';
import type { Wallet } from '../wallet/wallet.js';
import { resolveCore, type CoreOptions } from './context.js';
import { unwrapWallet } from './internal.js';
import type { CoreWallet } from './wallet.js';

export function explorerTxUrl(network: Network, txid: string): string {
  return network === 'test'
    ? `https://test.whatsonchain.com/tx/${txid}`
    : `https://whatsonchain.com/tx/${txid}`;
}

export interface SendParams {
  to: string;
  amountSats: number;
  memo?: string;
  /** Spend only confirmed UTXOs (unconfirmed are spendable by default). */
  confirmedOnly?: boolean;
  /**
   * Permit amounts at/above the config spend limit (the CLI sets this after
   * its own interactive confirmation / --allow-large). Until M9's policy
   * engine subsumes it, this mirrors the --allow-large semantic.
   */
  allowAboveLimit?: boolean;
}

/** A fully planned, not-yet-signed spend. Carries addresses and txids only. */
export interface SendPlan {
  to: string;
  amountSats: number;
  memo?: string;
  feeSats: number;
  /** 0 when sub-dust change was folded into the fee. */
  changeSats: number;
  balanceAfterSats: number;
  inputCount: number;
  /** UTXOs the transaction will spend. */
  inputs: SpendableUtxo[];
  /** Where change will go (derived but not persisted until execution). */
  changeAddress: string;
}

export interface SendResult {
  txid: string;
  to: string;
  amountSats: number;
  feeSats: number;
  changeSats: number;
  balanceAfterSats: number;
  sizeBytes: number;
  dryRun: boolean;
  explorerUrl: string;
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
      // spend unconfirmed change by default; confirmedOnly restricts
      if (confirmedOnly && (u.height === undefined || u.height <= 0)) continue;
      utxos.push({ ...u, address: tracked.address });
    }
  }
  return utxos;
}

/**
 * Validate and plan a spend: address check, spend-limit guard, UTXO
 * selection, and fee calculation. Persists nothing. Throws code 2 (bad
 * address/amount), 8 (over the spend limit without allowAboveLimit), or
 * 3 (insufficient funds).
 */
export async function planSend(
  wallet: CoreWallet,
  opts: CoreOptions,
  params: SendParams,
): Promise<SendPlan> {
  const { network, config, provider } = resolveCore(opts);
  validateAddress(params.to, network);
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new CliError(
      EXIT.USAGE,
      'invalid_amount',
      `amountSats must be a positive integer of satoshis (got ${params.amountSats}).`,
    );
  }
  if (params.amountSats >= config.spendLimitSats && !params.allowAboveLimit) {
    throw new CliError(
      EXIT.SPEND_LIMIT,
      'spend_limit_exceeded',
      `Amount ${formatSats(params.amountSats)} is at/above the ${formatSats(config.spendLimitSats)} per-transaction limit. ` +
        'Pass allowAboveLimit, or raise spend_limit_sats in config.toml.',
      { limit_sats: config.spendLimitSats, amount_sats: params.amountSats },
    );
  }

  const inner = unwrapWallet(wallet);
  const utxos = await gatherSpendableUtxos(inner, provider, Boolean(params.confirmedOnly));
  const selection = selectUtxos(utxos, params.amountSats, config.feeRateSatsPerKb);
  const totalAvailable = utxos.reduce((s, u) => s + u.satoshis, 0);

  return {
    to: params.to,
    amountSats: params.amountSats,
    memo: params.memo,
    feeSats: selection.fee,
    changeSats: selection.changeSats,
    balanceAfterSats: totalAvailable - params.amountSats - selection.fee,
    inputCount: selection.selected.length,
    inputs: selection.selected,
    changeAddress: inner.peekAddress('change').address,
  };
}

/**
 * Sign and (unless dryRun) broadcast a planned spend, recording it in the
 * ledger (invariant 6). dryRun persists nothing — no ledger entry, no
 * change-address counter bump. An ambiguous broadcast failure appends a
 * `status: "unknown"` entry and throws code 6 carrying the txid; a definite
 * rejection throws code 5 with nothing spent or recorded.
 */
export async function executeSend(
  wallet: CoreWallet,
  opts: CoreOptions,
  plan: SendPlan,
  exec: { dryRun?: boolean } = {},
): Promise<SendResult> {
  const { network, provider } = resolveCore(opts);
  const inner = unwrapWallet(wallet);

  const tx = await buildSignedTx(
    inner,
    { selected: plan.inputs, fee: plan.feeSats, changeSats: plan.changeSats },
    plan.to,
    plan.amountSats,
    plan.changeAddress,
  );
  const txid = tx.id('hex');
  const result: SendResult = {
    txid,
    to: plan.to,
    amountSats: plan.amountSats,
    feeSats: plan.feeSats,
    changeSats: plan.changeSats,
    balanceAfterSats: plan.balanceAfterSats,
    sizeBytes: tx.toHex().length / 2,
    dryRun: Boolean(exec.dryRun),
    explorerUrl: explorerTxUrl(network, txid),
  };
  if (exec.dryRun) return result;

  // Persist the change address only on a real broadcast path.
  if (plan.changeSats > 0) inner.issueAddress('change', `change for ${txid.slice(0, 12)}`);

  try {
    const broadcast = await provider.broadcast(tx.toHex());
    if (!broadcast.ok) {
      throw new CliError(
        EXIT.BROADCAST_REJECTED,
        'broadcast_rejected',
        `The network rejected the transaction: ${broadcast.error ?? 'no reason given'}. ` +
          'Nothing was spent. Check the fee rate in config.toml or retry shortly.',
        { txid },
      );
    }
  } catch (e) {
    if (e instanceof CliError && e.exitCode === EXIT.BROADCAST_REJECTED) throw e;
    // Ambiguous network failure: the tx may have propagated. Code 6, txid included.
    appendLedger(network, {
      type: 'send',
      txid,
      amount_sats: plan.amountSats,
      address: plan.to,
      memo: plan.memo,
      timestamp: new Date().toISOString(),
      status: 'unknown',
      fee_sats: plan.feeSats,
    });
    throw new CliError(
      EXIT.BROADCAST_UNKNOWN,
      'broadcast_status_unknown',
      `Broadcast status unknown (network failure mid-send). txid ${txid} — check ${explorerTxUrl(network, txid)} before retrying; the funds may already have moved.`,
      { txid, explorer_url: explorerTxUrl(network, txid) },
    );
  }

  appendLedger(network, {
    type: 'send',
    txid,
    amount_sats: plan.amountSats,
    address: plan.to,
    memo: plan.memo,
    timestamp: new Date().toISOString(),
    status: 'pending',
    fee_sats: plan.feeSats,
  });
  return result;
}

/** Plan and execute in one call. Never prompts; spend-limit guard applies. */
export async function send(
  wallet: CoreWallet,
  opts: CoreOptions,
  params: SendParams,
): Promise<SendResult> {
  const plan = await planSend(wallet, opts, params);
  return executeSend(wallet, opts, plan);
}
