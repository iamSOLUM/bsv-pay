import fs from 'node:fs';
import path from 'node:path';
import { ledgerPath, type Network } from './paths.js';

/**
 * Append-only local ledger (~/.bsv-pay/ledger.jsonl). Records sends,
 * receives, issued addresses, and (Phase 2) every policy decision and
 * approval resolution. Memos are local-only — never on-chain.
 * Never contains key material. Entry types are additive-only.
 */
export type LedgerEntry =
  | {
      type: 'send' | 'receive';
      txid: string;
      amount_sats: number;
      address: string;
      memo?: string;
      timestamp: string;
      status: 'pending' | 'confirmed' | 'unknown';
      fee_sats?: number;
      /** Links a send to the policy decision that authorized it (Phase 2). */
      decision_id?: string;
    }
  | {
      type: 'address_issued';
      address: string;
      derivation_index: number;
      purpose: 'receive' | 'change' | 'request';
      memo?: string;
      timestamp: string;
    }
  | {
      type: 'policy_decision';
      decision: 'allow' | 'deny' | 'queue';
      /** Which policy rule decided, e.g. "daily_budget_sats" or "default". */
      rule: string;
      reason: string;
      address: string;
      amount_sats: number;
      memo?: string;
      timestamp: string;
      decision_id: string;
      /** Present when decision === "queue". */
      approval_id?: string;
      confirmed_only?: boolean;
    }
  | {
      type: 'approval_resolved';
      approval_id: string;
      resolution: 'approved' | 'rejected';
      timestamp: string;
      /** Present when resolution === "approved" and the send broadcast. */
      txid?: string;
    };

export function appendLedger(network: Network, entry: LedgerEntry): void {
  const file = ledgerPath(network);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

/** Unique addresses this wallet has issued, oldest first (no unlock needed). */
export function trackedAddressesFromLedger(network: Network): string[] {
  const seen = new Set<string>();
  for (const entry of readLedger(network)) {
    if (entry.type === 'address_issued') seen.add(entry.address);
  }
  return [...seen];
}

export function readLedger(network: Network): LedgerEntry[] {
  const file = ledgerPath(network);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEntry);
}
