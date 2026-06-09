import fs from 'node:fs';
import path from 'node:path';
import { ledgerPath, type Network } from './paths.js';

/**
 * Append-only local ledger (~/.bsv-pay/ledger.jsonl). Records sends,
 * receives, and issued addresses. Memos are local-only — never on-chain.
 * Never contains key material.
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
    }
  | {
      type: 'address_issued';
      address: string;
      derivation_index: number;
      purpose: 'receive' | 'change' | 'request';
      memo?: string;
      timestamp: string;
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
