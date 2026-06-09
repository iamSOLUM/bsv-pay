import { usageError } from './errors.js';

export const SATS_PER_BSV = 100_000_000;

/**
 * Parse a user-supplied amount into satoshis.
 *
 * Rules (invariant 1): bare integers are satoshis; `sats` and `bsv` suffixes
 * are accepted (case-insensitive, optional space before suffix). Anything
 * ambiguous or unparseable throws a usage error (exit 2) — never guess.
 */
export function parseAmount(input: string): number {
  const raw = input.trim();
  if (raw === '')
    throw usageError(
      'invalid_amount',
      'Amount is empty. Pass satoshis (e.g. 5000), 5000sats, or 0.0001bsv.',
    );

  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(sats?|bsv)?$/i.exec(raw);
  if (!m || !m[1]) {
    throw usageError(
      'invalid_amount',
      `Cannot parse amount "${input}". Use bare satoshis (5000), a sats suffix (5000sats), or a bsv suffix (0.0001bsv).`,
    );
  }
  const numberPart = m[1];
  const suffix = (m[2] ?? '').toLowerCase();

  let sats: number;
  if (suffix === 'bsv') {
    const [whole = '0', frac = ''] = numberPart.split('.');
    if (frac.length > 8) {
      throw usageError(
        'invalid_amount',
        `"${input}" has more than 8 decimal places — BSV is divisible to 8 places (1 satoshi). Reduce the precision.`,
      );
    }
    sats = Number(whole) * SATS_PER_BSV + Number(frac.padEnd(8, '0') || '0');
  } else {
    // bare or sats suffix: must be an integer count of satoshis
    if (numberPart.includes('.')) {
      throw usageError(
        'invalid_amount',
        `"${input}" is fractional but satoshis are indivisible. Use a whole number of sats or a bsv suffix (e.g. 0.0001bsv).`,
      );
    }
    sats = Number(numberPart);
  }

  if (!Number.isSafeInteger(sats)) {
    throw usageError('invalid_amount', `Amount "${input}" is too large to represent safely.`);
  }
  if (sats <= 0) {
    throw usageError('invalid_amount', `Amount must be greater than zero (got "${input}").`);
  }
  return sats;
}

/** Format satoshis for human output, e.g. "5,000 sats (0.00005 BSV)". */
export function formatSats(sats: number): string {
  const bsv = (sats / SATS_PER_BSV).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return `${sats.toLocaleString('en-US')} sats (${bsv} BSV)`;
}

/** Satoshis -> BSV decimal string (for BIP-21 URIs). */
export function satsToBsvString(sats: number): string {
  const whole = Math.floor(sats / SATS_PER_BSV);
  const frac = (sats % SATS_PER_BSV).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
