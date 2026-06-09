import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import { WhatsOnChainProvider } from '../chain/whatsonchain.js';
import type { Ctx } from '../context.js';
import { usageError } from '../errors.js';
import { appendLedger, readLedger, trackedAddressesFromLedger } from '../ledger.js';
import { formatSats } from '../units.js';
import { readWalletFile } from '../wallet/wallet.js';
import { explorerTxUrl } from './send.js';

export interface WatchOptions {
  interval?: string;
}

const MIN_INTERVAL_SECS = 5;
const MAX_BACKOFF_MULTIPLIER = 8;

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** memo per request address, from the ledger (memos are local-only). */
function memosByAddress(network: 'main' | 'test'): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of readLedger(network)) {
    if (e.type === 'address_issued' && e.memo) map.set(e.address, e.memo);
  }
  return map;
}

function receivedTxids(network: 'main' | 'test'): Set<string> {
  const set = new Set<string>();
  for (const e of readLedger(network)) {
    if (e.type === 'receive') set.add(`${e.txid}:${e.address}`);
  }
  return set;
}

/**
 * Poll all tracked addresses; emit one event per incoming payment (pending at
 * 0-conf, then a confirmation event). `maxCycles` exists for tests.
 */
export async function cmdWatch(
  ctx: Ctx,
  opts: WatchOptions,
  provider?: ChainProvider,
  maxCycles = Infinity,
): Promise<void> {
  const chain = provider ?? new WhatsOnChainProvider(ctx.network);
  readWalletFile(ctx.network); // exit 2 with guidance when no wallet

  let intervalSecs = ctx.config.pollIntervalSecs;
  if (opts.interval !== undefined) {
    const n = Number(opts.interval);
    if (!Number.isFinite(n) || n <= 0) {
      throw usageError(
        'invalid_interval',
        `--interval must be a positive number of seconds (got "${opts.interval}").`,
      );
    }
    intervalSecs = n;
  }
  if (intervalSecs < MIN_INTERVAL_SECS) {
    process.stderr.write(
      chalk.yellow(`Interval raised to the ${MIN_INTERVAL_SECS}s floor (public API rate limits).`) +
        '\n',
    );
    intervalSecs = MIN_INTERVAL_SECS;
  }

  // Clean Ctrl-C: abort the current sleep, then fall through to the summary.
  const abort = new AbortController();
  let stopping = false;
  const onSigint = (): void => {
    stopping = true;
    abort.abort();
  };
  process.once('SIGINT', onSigint);

  /** address -> txid -> confirmed? */
  const known = new Map<string, Map<string, boolean>>();
  const alreadyLedgered = receivedTxids(ctx.network);
  let sessionTotal = 0;
  let baselined = false;
  let backoff = 1;

  ctx.out.info(
    chalk.bold(
      `Watching ${ctx.network === 'test' ? 'testnet' : 'mainnet'} wallet (every ${intervalSecs}s) — Ctrl-C to stop.`,
    ),
  );

  const emit = (obj: Record<string, unknown>, human: string): void => {
    ctx.out.info(human);
    if (ctx.json) process.stdout.write(JSON.stringify(obj) + '\n');
  };

  for (let cycle = 0; cycle < maxCycles && !stopping; cycle++) {
    try {
      const memos = memosByAddress(ctx.network);
      // refresh each cycle: requests issued mid-session get watched too
      for (const address of trackedAddressesFromLedger(ctx.network)) {
        if (stopping) break;
        const utxos = await chain.getUtxos(address);
        const forAddr = known.get(address) ?? new Map<string, boolean>();
        known.set(address, forAddr);

        // group this address's UTXOs by txid
        const byTxid = new Map<string, { sats: number; confirmed: boolean }>();
        for (const u of utxos) {
          const cur = byTxid.get(u.txid) ?? { sats: 0, confirmed: false };
          cur.sats += u.satoshis;
          cur.confirmed = (u.height ?? 0) > 0;
          byTxid.set(u.txid, cur);
        }

        for (const [txid, info] of byTxid) {
          const prior = forAddr.get(txid);
          if (prior === undefined) {
            forAddr.set(txid, info.confirmed);
            if (!baselined) continue; // pre-existing funds are not session events
            sessionTotal += info.sats;
            const memo = memos.get(address);
            const status = info.confirmed ? 'confirmed' : 'pending';
            emit(
              {
                event: 'payment',
                status,
                address,
                txid,
                amount_sats: info.sats,
                ...(memo ? { memo } : {}),
                session_total_sats: sessionTotal,
                explorer_url: explorerTxUrl(ctx.network, txid),
              },
              `${chalk.green('+' + formatSats(info.sats))} ${status === 'pending' ? chalk.yellow('[pending]') : chalk.green('[confirmed]')}` +
                `${memo ? ` "${memo}"` : ''}  ${explorerTxUrl(ctx.network, txid)}  (session total ${formatSats(sessionTotal)})`,
            );
            if (!alreadyLedgered.has(`${txid}:${address}`)) {
              appendLedger(ctx.network, {
                type: 'receive',
                txid,
                amount_sats: info.sats,
                address,
                memo,
                timestamp: new Date().toISOString(),
                status,
              });
              alreadyLedgered.add(`${txid}:${address}`);
            }
          } else if (prior === false && info.confirmed) {
            forAddr.set(txid, true);
            emit(
              {
                event: 'confirmed',
                address,
                txid,
                amount_sats: info.sats,
                session_total_sats: sessionTotal,
                explorer_url: explorerTxUrl(ctx.network, txid),
              },
              `${chalk.green('✓ confirmed')} ${formatSats(info.sats)}  ${explorerTxUrl(ctx.network, txid)}`,
            );
          }
        }
      }
      baselined = true;
      backoff = 1; // healthy cycle resets any rate-limit backoff
    } catch (e) {
      // Never crash the session on API trouble: back off and keep going.
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MULTIPLIER);
      process.stderr.write(
        chalk.yellow(
          `watch: chain query failed (${e instanceof Error ? e.message.split('.')[0] : String(e)}); backing off to ${intervalSecs * backoff}s.`,
        ) + '\n',
      );
    }
    if (cycle + 1 < maxCycles && !stopping) {
      await interruptibleSleep(intervalSecs * backoff * 1000, abort.signal);
    }
  }

  process.removeListener('SIGINT', onSigint);
  if (ctx.json) {
    process.stdout.write(
      JSON.stringify({ event: 'watch_stopped', session_total_sats: sessionTotal }) + '\n',
    );
  }
  ctx.out.info('');
  ctx.out.info(`Watch stopped. Session total received: ${formatSats(sessionTotal)}.`);
}
