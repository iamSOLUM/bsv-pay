import { baseDir, type Network } from '../paths.js';

/**
 * Single-flight for the spend critical section (decide → sign → broadcast →
 * ledger). Budgets and rate limits are recomputed from the ledger when the
 * policy gate decides, but the send entry that consumes them is appended
 * only after broadcast — so two spends in flight at once could BOTH pass a
 * budget check before either is recorded. Any long-running process that can
 * receive concurrent spend calls (the MCP server, library embedders using
 * send()) must serialize the whole span; a CLI invocation is one spend per
 * process, where the lock is a no-op.
 *
 * Keyed by state dir + network, matching how budgets are scoped. A spend
 * that throws (denied, insufficient funds, broadcast failure) releases the
 * lock; the next spend in line re-reads usage from the ledger and is decided
 * on the true state. Deliberately module-private to core: not exported from
 * bsv-pay/core, no timeout, no reentrancy.
 */
const tails = new Map<string, Promise<void>>();

export function withSpendLock<T>(network: Network, fn: () => Promise<T>): Promise<T> {
  const key = `${baseDir()}::${network}`;
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined, // a failed spend must not poison the chain
    ),
  );
  return run;
}
