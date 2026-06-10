import { readLedger, type LedgerEntry } from '../ledger.js';
import { readWalletFile } from '../wallet/wallet.js';
import type { CoreOptions } from './context.js';

export type MoneyMovement = Extract<LedgerEntry, { type: 'send' | 'receive' }>;

export interface HistoryParams {
  /** Maximum entries to return (after filtering), newest first. */
  limit?: number;
  /** Restrict to sends or receives; default both. */
  type?: 'send' | 'receive';
}

/**
 * Money movements from the local append-only ledger, newest first. This is
 * deliberately ledger-backed — no chain scan — so it is fast, offline, and
 * reflects exactly what this wallet recorded (including memos, which exist
 * only locally). Throws code 2 `no_wallet` when no wallet exists.
 */
export function getHistory(opts: CoreOptions, params: HistoryParams = {}): MoneyMovement[] {
  readWalletFile(opts.network); // throws no_wallet with guidance when absent
  const movements = readLedger(opts.network).filter(
    (e): e is MoneyMovement => e.type === 'send' || e.type === 'receive',
  );
  const filtered = params.type ? movements.filter((e) => e.type === params.type) : movements;
  filtered.reverse(); // ledger is append-only, so reversed = newest first
  return params.limit !== undefined ? filtered.slice(0, params.limit) : filtered;
}
