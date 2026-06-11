import { CliError, EXIT, networkError } from '../errors.js';
import { send } from '../core/send.js';
import type { CoreOptions } from '../core/context.js';
import type { CoreWallet } from '../core/wallet.js';
import { encodePaymentEnvelope, parsePaymentTerms, HEADER } from './protocol.js';

/**
 * The paying side of the 402 flow (BRC-105 simplified profile — see
 * src/http402/protocol.ts and DECISIONS.md M11). The payment itself goes
 * through core send(): the policy gate decides and ledgers it, the
 * single-flight lock serializes it, and `maxPriceSats` additionally caps
 * this one fetch regardless of policy headroom. This module is the ONLY
 * core file allowed to call fetch() besides the chain provider — it can
 * talk HTTP, but it cannot sign or broadcast anything itself.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const MEMO_MAX_CHARS = 120;

export interface PaidFetchParams {
  url: string;
  /** Hard cap for THIS fetch, checked before any spend. Exit 8 when exceeded. */
  maxPriceSats?: number;
}

export interface PaidFetchPayment {
  txid: string;
  amountSats: number;
  feeSats: number;
  address: string;
  derivationPrefix: string;
}

export interface PaidFetchResult {
  /** HTTP status of the final response (after payment, if one was made). */
  status: number;
  body: string;
  contentType?: string;
  /** False when the resource came back without requiring payment. */
  paid: boolean;
  payment?: PaidFetchPayment;
}

async function httpGet(url: string, headers?: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw networkError(`Cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}.`, {
      url,
    });
  }
}

/**
 * GET a URL, automatically paying a BRC-105 402 challenge within policy.
 * Free resources return with `paid: false` and no spend. Throws exit 8 on
 * `max_price_exceeded` (before the gate) or any policy denial (from the
 * gate, ledgered), exit 9 when the payment queued for human approval, and
 * exit 10 `payment_not_redeemed` when the payment broadcast but the server
 * still refused the content (the txid is in the error data — money moved).
 */
export async function paidFetch(
  wallet: CoreWallet,
  opts: CoreOptions,
  params: PaidFetchParams,
): Promise<PaidFetchResult> {
  if (!/^https?:\/\//i.test(params.url)) {
    throw new CliError(
      EXIT.USAGE,
      'invalid_url',
      `fetch needs an http(s) URL (got "${params.url}").`,
    );
  }

  const first = await httpGet(params.url);
  if (first.status !== 402) {
    return {
      status: first.status,
      body: await first.text(),
      contentType: first.headers.get('content-type') ?? undefined,
      paid: false,
    };
  }

  const terms = parsePaymentTerms(first.headers, opts.network);
  if (params.maxPriceSats !== undefined && terms.satoshisRequired > params.maxPriceSats) {
    throw new CliError(
      EXIT.SPEND_LIMIT,
      'max_price_exceeded',
      `Server asks ${terms.satoshisRequired} sats but --max-price caps this fetch at ${params.maxPriceSats} sats. Nothing was paid.`,
      { url: params.url, price_sats: terms.satoshisRequired, max_price_sats: params.maxPriceSats },
    );
  }

  // The actual spend: policy gate, single-flight lock, ledger — all in core.
  const payment = await send(wallet, opts, {
    to: terms.address,
    amountSats: terms.satoshisRequired,
    memo: `402 ${params.url}`.slice(0, MEMO_MAX_CHARS),
  });

  const retry = await httpGet(params.url, {
    [HEADER.payment]: encodePaymentEnvelope({
      derivationPrefix: terms.derivationPrefix,
      txid: payment.txid,
      transaction: payment.rawTxHex,
    }),
  });
  if (!retry.ok) {
    throw new CliError(
      EXIT.PAYMENT_NOT_REDEEMED,
      'payment_not_redeemed',
      `Paid ${terms.satoshisRequired} sats (txid ${payment.txid}) but the server still responded ${retry.status}. The payment is on-chain and in your ledger; take it up with the seller.`,
      {
        url: params.url,
        status: retry.status,
        txid: payment.txid,
        amount_sats: terms.satoshisRequired,
        address: terms.address,
      },
    );
  }

  return {
    status: retry.status,
    body: await retry.text(),
    contentType: retry.headers.get('content-type') ?? undefined,
    paid: true,
    payment: {
      txid: payment.txid,
      amountSats: payment.amountSats,
      feeSats: payment.feeSats,
      address: terms.address,
      derivationPrefix: terms.derivationPrefix,
    },
  };
}
