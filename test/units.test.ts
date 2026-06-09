import { describe, expect, it } from 'vitest';
import { parseAmount, satsToBsvString, formatSats } from '../src/units.js';
import { CliError, EXIT } from '../src/errors.js';

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof CliError ? e.exitCode : undefined;
  }
}

describe('parseAmount', () => {
  it('treats bare integers as satoshis', () => {
    expect(parseAmount('5000')).toBe(5000);
    expect(parseAmount('1')).toBe(1);
  });

  it('accepts the sats suffix, case-insensitive, singular and plural, with optional space', () => {
    expect(parseAmount('5000sats')).toBe(5000);
    expect(parseAmount('5000sat')).toBe(5000);
    expect(parseAmount('5000 sats')).toBe(5000);
    expect(parseAmount('5000SATS')).toBe(5000);
  });

  it('accepts the bsv suffix and converts at 1e8', () => {
    expect(parseAmount('0.0001bsv')).toBe(10_000);
    expect(parseAmount('1bsv')).toBe(100_000_000);
    expect(parseAmount('0.00000001bsv')).toBe(1);
    expect(parseAmount('1.5 BSV')).toBe(150_000_000);
  });

  it('rejects fractional satoshis with exit 2', () => {
    expect(exitCodeOf(() => parseAmount('5000.5'))).toBe(EXIT.USAGE);
    expect(exitCodeOf(() => parseAmount('0.5sats'))).toBe(EXIT.USAGE);
  });

  it('rejects sub-satoshi bsv precision with exit 2', () => {
    expect(exitCodeOf(() => parseAmount('0.000000001bsv'))).toBe(EXIT.USAGE);
  });

  it('rejects zero, negatives, garbage, and ambiguous units with exit 2', () => {
    for (const bad of [
      '0',
      '0sats',
      '-5',
      '-5sats',
      '',
      '  ',
      'abc',
      '5000 satoshis',
      '5000btc',
      '5,000',
      '1e3',
      'NaN',
      'Infinity',
      '5000sats extra',
    ]) {
      expect(
        exitCodeOf(() => parseAmount(bad)),
        `input: "${bad}"`,
      ).toBe(EXIT.USAGE);
    }
  });

  it('rejects unsafe magnitudes', () => {
    expect(exitCodeOf(() => parseAmount('99999999999999999999'))).toBe(EXIT.USAGE);
  });
});

describe('satsToBsvString', () => {
  it('converts without float artifacts', () => {
    expect(satsToBsvString(10_000)).toBe('0.0001');
    expect(satsToBsvString(100_000_000)).toBe('1');
    expect(satsToBsvString(1)).toBe('0.00000001');
    expect(satsToBsvString(150_000_000)).toBe('1.5');
  });
});

describe('formatSats', () => {
  it('shows both units', () => {
    expect(formatSats(5000)).toBe('5,000 sats (0.00005 BSV)');
  });
});
