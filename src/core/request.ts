import { CliError, EXIT } from '../errors.js';
import { appendLedger } from '../ledger.js';
import type { Network } from '../paths.js';
import { satsToBsvString } from '../units.js';
import { brc100ReceiveNotSupported } from '../wallet/brc100.js';
import { resolveCore, type CoreOptions } from './context.js';
import { unwrapWallet } from './internal.js';
import type { CoreWallet } from './wallet.js';

/** BIP-21-style URI with the BSV `sv` discriminator. Amount is in BSV. */
export function buildPaymentUri(address: string, amountSats: number, memo?: string): string {
  let uri = `bitcoin:${address}?sv&amount=${satsToBsvString(amountSats)}`;
  if (memo) uri += `&label=${encodeURIComponent(memo)}`;
  return uri;
}

export interface RequestParams {
  amountSats: number;
  memo?: string;
}

export interface RequestResult {
  address: string;
  amountSats: number;
  memo?: string;
  uri: string;
  network: Network;
}

/**
 * Issue a fresh receiving address (one per request, so matching is
 * unambiguous) and build the BIP-21 URI. The address is persisted to the
 * wallet counter and ledger immediately.
 */
export function createRequest(wallet: CoreWallet, params: RequestParams): RequestResult {
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new CliError(
      EXIT.USAGE,
      'invalid_amount',
      `amountSats must be a positive integer of satoshis (got ${params.amountSats}).`,
    );
  }
  if (wallet.backend === 'brc100') throw brc100ReceiveNotSupported();
  const inner = unwrapWallet(wallet);
  const { address } = inner.issueAddress('request', params.memo);
  return {
    address,
    amountSats: params.amountSats,
    memo: params.memo,
    uri: buildPaymentUri(address, params.amountSats, params.memo),
    network: wallet.network,
  };
}

export interface AwaitPaymentParams {
  address: string;
  timeoutMs: number;
  /** Default: config poll_interval_secs. */
  pollIntervalMs?: number;
  /** Recorded on the ledger receive entry (memos are local-only). */
  memo?: string;
}

export interface PaymentResult {
  address: string;
  txid: string;
  receivedSats: number;
  confirmed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll an address until the first incoming payment appears at 0-conf, then
 * record the receive in the ledger (invariant 6) and return it. Transient
 * chain failures keep polling until the deadline. Timeout throws code 4
 * `request_timeout`.
 */
export async function awaitPayment(
  opts: CoreOptions,
  params: AwaitPaymentParams,
): Promise<PaymentResult> {
  const { network, config, provider } = resolveCore(opts);
  const pollIntervalMs = params.pollIntervalMs ?? config.pollIntervalSecs * 1000;
  const deadlineMs = Date.now() + params.timeoutMs;

  for (;;) {
    try {
      const utxos = await provider.getUtxos(params.address);
      if (utxos.length > 0) {
        const txid = utxos[0]!.txid;
        const receivedSats = utxos
          .filter((u) => u.txid === txid)
          .reduce((s, u) => s + u.satoshis, 0);
        const confirmed = (utxos[0]!.height ?? 0) > 0;
        appendLedger(network, {
          type: 'receive',
          txid,
          amount_sats: receivedSats,
          address: params.address,
          memo: params.memo,
          timestamp: new Date().toISOString(),
          status: confirmed ? 'confirmed' : 'pending',
        });
        return { address: params.address, txid, receivedSats, confirmed };
      }
    } catch {
      // transient network/rate-limit failure: keep polling until the deadline
    }
    if (Date.now() >= deadlineMs) {
      throw new CliError(
        EXIT.NETWORK,
        'request_timeout',
        `No payment seen on ${params.address} within ${Math.round(params.timeoutMs / 1000)}s.`,
        { address: params.address, timeout_ms: params.timeoutMs },
      );
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  }
}
