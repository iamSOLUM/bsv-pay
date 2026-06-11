import { readLedger } from '../ledger.js';
import type { Network } from '../paths.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Session spend is the ONLY in-memory accounting: by definition it covers
 * this process's lifetime (an MCP server session; each CLI invocation is its
 * own session). Everything else below is recomputed from the append-only
 * ledger at every decision, so restarting a process never resets a budget.
 */
const sessionSpentByNetwork = new Map<Network, number>();

export function addSessionSpent(network: Network, amountSats: number): void {
  sessionSpentByNetwork.set(network, (sessionSpentByNetwork.get(network) ?? 0) + amountSats);
}

export function resetSessionSpentForTests(): void {
  sessionSpentByNetwork.clear();
}

export interface SpendUsage {
  /** Sum of send amounts (pending, confirmed, AND unknown) in the last 24h. */
  dailySpentSats: number;
  sessionSpentSats: number;
  sendsLastMinute: number;
  sendsLastHour: number;
}

/**
 * Read current spend usage from the ledger. Amounts are amount_sats only
 * (fees excluded); `unknown` broadcasts count as spent — conservative, the
 * funds may have moved.
 */
export function readUsage(network: Network, now = Date.now()): SpendUsage {
  let dailySpentSats = 0;
  let sendsLastMinute = 0;
  let sendsLastHour = 0;
  for (const entry of readLedger(network)) {
    if (entry.type !== 'send') continue;
    const t = Date.parse(entry.timestamp);
    if (!Number.isFinite(t)) continue;
    // Future-dated entries (clock skew) count as "just now" — conservative.
    if (now - t < DAY_MS) dailySpentSats += entry.amount_sats;
    if (now - t < HOUR_MS) sendsLastHour += 1;
    if (now - t < MINUTE_MS) sendsLastMinute += 1;
  }
  return {
    dailySpentSats,
    sessionSpentSats: sessionSpentByNetwork.get(network) ?? 0,
    sendsLastMinute,
    sendsLastHour,
  };
}
