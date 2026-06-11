import { Transaction, Utils } from '@bsv/sdk';
import { validateAddress } from '../address.js';
import { CliError, EXIT } from '../errors.js';
import type { Network } from '../paths.js';

/**
 * The BRC-105 header exchange, simplified profile (see DECISIONS.md M11):
 * same header names, flow, and version as the spec, with two documented
 * divergences until M12 brings BRC-100 custody — the payment destination
 * is a fresh server-wallet address advertised via `x-bsv-payment-address`
 * (instead of BRC-29 key derivation), and `transaction` in the retry
 * envelope is raw tx hex (instead of AtomicBEEF).
 */

export const PAYMENT_VERSION = '1.0';

export const HEADER = {
  version: 'x-bsv-payment-version',
  satoshisRequired: 'x-bsv-payment-satoshis-required',
  derivationPrefix: 'x-bsv-payment-derivation-prefix',
  address: 'x-bsv-payment-address',
  payment: 'x-bsv-payment',
  satoshisPaid: 'x-bsv-payment-satoshis-paid',
  error: 'x-bsv-payment-error',
} as const;

/** What a 402 response demands. */
export interface PaymentTerms {
  satoshisRequired: number;
  derivationPrefix: string;
  address: string;
}

/** What the client presents on retry (the `x-bsv-payment` header, JSON). */
export interface PaymentEnvelope {
  derivationPrefix: string;
  txid: string;
  /** Signed raw transaction hex — public data, already broadcast by the payer. */
  transaction: string;
}

function badTerms(message: string): never {
  // The server sent a 402 we must not pay: a remote-protocol failure
  // (exit 4), and crucially BEFORE any spend was attempted.
  throw new CliError(EXIT.NETWORK, 'invalid_payment_terms', message);
}

/**
 * Parse and validate the payment terms on a 402 response. Throws exit 4
 * without spending anything when the terms are unusable; per BRC-105, a
 * version we do not support means we MUST NOT pay.
 */
export function parsePaymentTerms(
  headers: { get(name: string): string | null },
  network: Network,
): PaymentTerms {
  const version = headers.get(HEADER.version);
  if (version !== PAYMENT_VERSION) {
    badTerms(
      `Server requested payment version "${version ?? '(missing)'}" but this client supports ${PAYMENT_VERSION}. Not paying.`,
    );
  }
  const satoshisRequired = Number(headers.get(HEADER.satoshisRequired));
  if (!Number.isSafeInteger(satoshisRequired) || satoshisRequired <= 0) {
    badTerms('Missing or invalid x-bsv-payment-satoshis-required header. Not paying.');
  }
  const derivationPrefix = headers.get(HEADER.derivationPrefix);
  if (typeof derivationPrefix !== 'string' || derivationPrefix.length < 1) {
    badTerms('Missing x-bsv-payment-derivation-prefix header. Not paying.');
  }
  const address = headers.get(HEADER.address);
  if (typeof address !== 'string' || address.length < 1) {
    badTerms('Missing x-bsv-payment-address header. Not paying.');
  }
  try {
    validateAddress(address, network); // wrong-network terms are never payable
  } catch {
    badTerms(`Payment address "${address}" is not valid for this network. Not paying.`);
  }
  return { satoshisRequired, derivationPrefix, address };
}

export function buildTermsHeaders(terms: PaymentTerms): Record<string, string> {
  return {
    [HEADER.version]: PAYMENT_VERSION,
    [HEADER.satoshisRequired]: String(terms.satoshisRequired),
    [HEADER.derivationPrefix]: terms.derivationPrefix,
    [HEADER.address]: terms.address,
  };
}

export function encodePaymentEnvelope(envelope: PaymentEnvelope): string {
  return JSON.stringify(envelope);
}

/** Parse the retry envelope; null means "treat as an unpaid request". */
export function parsePaymentEnvelope(raw: string | undefined | null): PaymentEnvelope | null {
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof doc.derivationPrefix === 'string' &&
      typeof doc.txid === 'string' &&
      typeof doc.transaction === 'string'
    ) {
      return {
        derivationPrefix: doc.derivationPrefix,
        txid: doc.txid,
        transaction: doc.transaction,
      };
    }
  } catch {
    // malformed JSON falls through to null
  }
  return null;
}

const P2PKH_PREFIX: Record<Network, number> = { main: 0x00, test: 0x6f };

/**
 * Structural check of a presented payment: does this transaction pay at
 * least `satoshisRequired` to `address`? Read-only over public data — the
 * authoritative confirmation is the seller's own chain view.
 */
export function transactionPays(
  rawTxHex: string,
  address: string,
  satoshisRequired: number,
  network: Network,
): boolean {
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(rawTxHex);
  } catch {
    return false;
  }
  let paid = 0;
  for (const out of tx.outputs) {
    const m = /^76a914([0-9a-f]{40})88ac$/.exec(out.lockingScript.toHex());
    if (!m) continue;
    const bytes = m[1]!.match(/../g)!.map((b) => parseInt(b, 16));
    if (Utils.toBase58Check(bytes, [P2PKH_PREFIX[network]]) === address) {
      paid += out.satoshis ?? 0;
    }
  }
  return paid >= satoshisRequired;
}
