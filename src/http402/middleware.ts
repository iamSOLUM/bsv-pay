import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CoreOptions } from '../core/context.js';
import { awaitPayment, createRequest } from '../core/request.js';
import type { CoreWallet } from '../core/wallet.js';
import { brc100ReceiveNotSupported } from '../wallet/brc100.js';
import { buildTermsHeaders, parsePaymentEnvelope, transactionPays, HEADER } from './protocol.js';

/**
 * The selling side of the 402 flow (BRC-105 simplified profile — see
 * src/http402/protocol.ts). Express-compatible `(req, res, next)` handler
 * with zero framework dependencies: it types req/res structurally against
 * node's http primitives, so it drops into Express, plain node:http
 * (`bsv-pay serve`), or anything shaped like them.
 *
 * Money flow: every quote issues a fresh wallet address (the bsv-pay
 * `request` model — unambiguous matching, funds land tracked and
 * spendable). The buyer broadcasts; this side only READS its chain view
 * to confirm (awaitPayment, which also ledgers the receive, invariant 6).
 * No signing, no broadcasting, no fetch — the choke points are untouched.
 */

export interface RequirePaymentOptions extends CoreOptions {
  wallet: CoreWallet;
  /** Price per paid request, in satoshis. */
  priceSats: number;
  /** How long a quoted prefix stays payable (default 10 minutes). */
  quoteTtlMs?: number;
  /** How long to wait for the presented payment on-chain (default 20 s). */
  confirmTimeoutMs?: number;
}

export interface PaymentReceipt {
  txid: string;
  amountSats: number;
  address: string;
  derivationPrefix: string;
}

/** A request that passed the paywall carries its receipt. */
export type PaidRequest = IncomingMessage & { bsvPayment?: PaymentReceipt };

export type PaidRequestHandler = (
  req: PaidRequest,
  res: ServerResponse,
  next?: () => void,
) => Promise<void>;

interface Quote {
  address: string;
  satoshisRequired: number;
  expiresAt: number;
  used: boolean;
}

export function requirePayment(opts: RequirePaymentOptions): PaidRequestHandler {
  // Selling means issuing receive addresses, which BRC-100 custody cannot do
  // (the wallet app would never see the funds). Fail at construction, not on
  // the first customer.
  if (opts.wallet.backend === 'brc100') throw brc100ReceiveNotSupported();
  const quoteTtlMs = opts.quoteTtlMs ?? 600_000;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 20_000;
  const core: CoreOptions = {
    network: opts.network,
    config: opts.config,
    provider: opts.provider,
  };
  /** prefix → quote. In-memory and single-use: a restart simply re-quotes. */
  const quotes = new Map<string, Quote>();

  function respond402(res: ServerResponse, error?: string): void {
    const now = Date.now();
    for (const [prefix, quote] of quotes) {
      if (quote.used || quote.expiresAt < now) quotes.delete(prefix);
    }
    const derivationPrefix = crypto.randomBytes(16).toString('base64');
    const request = createRequest(opts.wallet, {
      amountSats: opts.priceSats,
      memo: '402 quote',
    });
    quotes.set(derivationPrefix, {
      address: request.address,
      satoshisRequired: opts.priceSats,
      expiresAt: now + quoteTtlMs,
      used: false,
    });
    res.writeHead(402, {
      'content-type': 'application/json',
      ...buildTermsHeaders({
        satoshisRequired: opts.priceSats,
        derivationPrefix,
        address: request.address,
      }),
      ...(error ? { [HEADER.error]: error } : {}),
    });
    res.end(
      JSON.stringify({
        ok: false,
        error: error ?? 'payment_required',
        satoshis_required: opts.priceSats,
      }),
    );
  }

  return async (req, res, next) => {
    const envelope = parsePaymentEnvelope(req.headers[HEADER.payment] as string | undefined);
    if (!envelope) {
      respond402(res);
      return;
    }
    const quote = quotes.get(envelope.derivationPrefix);
    if (!quote || quote.used || quote.expiresAt < Date.now()) {
      respond402(res, 'unknown_or_expired_prefix');
      return;
    }
    // Structural pre-check on the presented hex (public data) before
    // touching the chain: does it even pay this quote?
    if (
      !transactionPays(envelope.transaction, quote.address, quote.satoshisRequired, opts.network)
    ) {
      respond402(res, 'payment_insufficient');
      return;
    }
    // Claim the quote BEFORE confirming so two concurrent retries with the
    // same prefix can never both redeem (released again if not found).
    quote.used = true;
    let payment;
    try {
      payment = await awaitPayment(core, {
        address: quote.address,
        timeoutMs: confirmTimeoutMs,
        memo: `402 sale ${req.url ?? ''}`.trim(),
      });
    } catch {
      quote.used = false; // still payable until the TTL
      respond402(res, 'payment_not_found');
      return;
    }
    const receipt: PaymentReceipt = {
      txid: payment.txid,
      amountSats: payment.receivedSats,
      address: quote.address,
      derivationPrefix: envelope.derivationPrefix,
    };
    (req as PaidRequest).bsvPayment = receipt;
    res.setHeader(HEADER.satoshisPaid, String(payment.receivedSats));
    if (next) next();
  };
}
