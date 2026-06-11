import { validateAddress } from '../address.js';
import type { ChainProvider } from '../chain/provider.js';
import { CliError, EXIT } from '../errors.js';
import { appendLedger } from '../ledger.js';
import type { Network } from '../paths.js';
import { addSessionSpent } from '../policy/budget.js';
import {
  authorizeApprovedSpend,
  authorizeSpend,
  registerAuthorizedPlan,
  takeAuthorizedPlan,
} from '../policy/engine.js';
import { buildSignedTx, selectUtxos, type SpendableUtxo } from '../tx.js';
import type { Wallet } from '../wallet/wallet.js';
import { resolveCore, type CoreOptions, type ResolvedCore } from './context.js';
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
   * The human confirmed the legacy soft spend limit (interactive prompt /
   * --allow-large). Satisfies ONLY that confirmable limit — it can never
   * cross a policy.toml rule (hard per-tx limit, budgets, lists, threshold).
   */
  allowAboveLimit?: boolean;
  /**
   * Authorize in evaluate-only mode: same policy verdicts, but nothing is
   * persisted and the resulting plan can never be executed for real.
   */
  dryRun?: boolean;
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

function validateSpendInput(to: string, amountSats: number, network: Network): void {
  validateAddress(to, network);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new CliError(
      EXIT.USAGE,
      'invalid_amount',
      `amountSats must be a positive integer of satoshis (got ${amountSats}).`,
    );
  }
}

/** Gather, select, and shape the plan. No policy, no persistence. */
async function buildPlan(
  wallet: CoreWallet,
  resolved: ResolvedCore,
  params: { to: string; amountSats: number; memo?: string; confirmedOnly?: boolean },
): Promise<SendPlan> {
  const inner = unwrapWallet(wallet);
  const utxos = await gatherSpendableUtxos(inner, resolved.provider, Boolean(params.confirmedOnly));
  const selection = selectUtxos(utxos, params.amountSats, resolved.config.feeRateSatsPerKb);
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
 * Validate and plan a spend. The policy gate (invariant 2) runs HERE, before
 * any network call: authorizeSpend ledgers the decision and throws exit 8 on
 * deny or exit 9 when queued for approval; on allow the returned plan is
 * registered as authorized for exactly this recipient and amount. Throws
 * code 2 (bad address/amount) or 3 (insufficient funds) otherwise.
 */
export async function planSend(
  wallet: CoreWallet,
  opts: CoreOptions,
  params: SendParams,
): Promise<SendPlan> {
  const resolved = resolveCore(opts);
  validateSpendInput(params.to, params.amountSats, resolved.network);
  const auth = authorizeSpend(
    { network: resolved.network, config: resolved.config },
    {
      to: params.to,
      amountSats: params.amountSats,
      memo: params.memo,
      softLimitConfirmed: params.allowAboveLimit,
      confirmedOnly: params.confirmedOnly,
    },
    { mode: params.dryRun ? 'evaluate' : 'enforce' },
  );
  const plan = await buildPlan(wallet, resolved, params);
  registerAuthorizedPlan(plan, auth);
  return plan;
}

/**
 * Plan a previously queued spend after the human passed the approval gate
 * (TTY + approval secret). Re-runs every policy rule except the threshold.
 * Internal: used by the approvals command, NOT exported from bsv-pay/core.
 */
export async function planApprovedSend(
  wallet: CoreWallet,
  opts: CoreOptions,
  params: { to: string; amountSats: number; memo?: string; confirmedOnly?: boolean },
  approvalId: string,
): Promise<SendPlan> {
  const resolved = resolveCore(opts);
  validateSpendInput(params.to, params.amountSats, resolved.network);
  const auth = authorizeApprovedSpend(
    { network: resolved.network, config: resolved.config },
    { to: params.to, amountSats: params.amountSats, memo: params.memo },
    approvalId,
  );
  const plan = await buildPlan(wallet, resolved, params);
  registerAuthorizedPlan(plan, auth);
  return plan;
}

/**
 * Sign and (unless dryRun) broadcast a planned spend, recording it in the
 * ledger (invariant 6). Refuses any plan the policy gate did not authorize:
 * hand-built, altered, already-executed, or planned with dryRun. dryRun
 * persists nothing — no ledger entry, no change-address counter bump. An
 * ambiguous broadcast failure appends a `status: "unknown"` entry and throws
 * code 6 carrying the txid; a definite rejection throws code 5 with nothing
 * spent or recorded.
 */
export async function executeSend(
  wallet: CoreWallet,
  opts: CoreOptions,
  plan: SendPlan,
  exec: { dryRun?: boolean } = {},
): Promise<SendResult> {
  const { network, provider } = resolveCore(opts);
  // The other half of the policy gate: no authorization, no broadcast.
  const auth = takeAuthorizedPlan(plan, { to: plan.to, amountSats: plan.amountSats }, !exec.dryRun);
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
      decision_id: auth.decisionId,
    });
    addSessionSpent(network, plan.amountSats); // may have moved: count it
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
    decision_id: auth.decisionId,
  });
  addSessionSpent(network, plan.amountSats);
  return result;
}

/** Plan and execute in one call. Never prompts; the policy gate applies. */
export async function send(
  wallet: CoreWallet,
  opts: CoreOptions,
  params: SendParams,
): Promise<SendResult> {
  const plan = await planSend(wallet, opts, params);
  return executeSend(wallet, opts, plan, { dryRun: params.dryRun });
}
