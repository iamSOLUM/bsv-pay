import { describe, expect, it } from 'vitest';
import {
  DUST_LIMIT_SATS,
  estimateTxSizeBytes,
  feeForTx,
  selectUtxos,
  type SpendableUtxo,
} from '../src/tx.js';
import { CliError, EXIT } from '../src/errors.js';

function utxo(satoshis: number, height?: number, n = 0): SpendableUtxo {
  return { txid: 'ab'.repeat(32), vout: n, satoshis, height, address: '1addr' };
}

describe('fee calculation', () => {
  it('estimates standard P2PKH sizes', () => {
    expect(estimateTxSizeBytes(1, 2)).toBe(226);
    expect(estimateTxSizeBytes(2, 1)).toBe(340);
  });

  it('rounds fees up and enforces a 1-sat minimum', () => {
    // 226 bytes at 50 sats/KB = 11.3 -> 12
    expect(feeForTx(1, 2, 50)).toBe(12);
    // tiny rate still pays at least 1 sat
    expect(feeForTx(1, 1, 1)).toBe(1);
    // 1000 sats/KB = 1 sat/byte
    expect(feeForTx(1, 2, 1000)).toBe(226);
  });
});

describe('selectUtxos', () => {
  it('selects a single sufficient UTXO and computes change', () => {
    const sel = selectUtxos([utxo(10_000)], 5_000, 50);
    expect(sel.selected).toHaveLength(1);
    expect(sel.fee).toBe(feeForTx(1, 2, 50));
    expect(sel.changeSats).toBe(10_000 - 5_000 - sel.fee);
  });

  it('prefers larger UTXOs first to minimize inputs', () => {
    const sel = selectUtxos([utxo(1_000), utxo(20_000), utxo(2_000)], 5_000, 50);
    expect(sel.selected).toHaveLength(1);
    expect(sel.selected[0]!.satoshis).toBe(20_000);
  });

  it('combines multiple UTXOs when needed, fee scales with inputs', () => {
    const sel = selectUtxos([utxo(3_000), utxo(2_500), utxo(2_000)], 5_000, 50);
    expect(sel.selected.length).toBeGreaterThan(1);
    expect(sel.fee).toBe(feeForTx(sel.selected.length, 2, 50));
    const total = sel.selected.reduce((s, u) => s + u.satoshis, 0);
    expect(total).toBeGreaterThanOrEqual(5_000 + sel.fee);
    expect(sel.changeSats).toBe(total - 5_000 - sel.fee);
  });

  it('folds sub-dust change into the fee', () => {
    const fee2out = feeForTx(1, 2, 50);
    // leave change just below the dust limit
    const amount = 10_000 - fee2out - (DUST_LIMIT_SATS - 1);
    const sel = selectUtxos([utxo(10_000)], amount, 50);
    expect(sel.changeSats).toBe(0);
    expect(sel.fee).toBe(10_000 - amount);
  });

  it('throws insufficient_funds (exit 3) when funds cannot cover amount + fee', () => {
    try {
      selectUtxos([utxo(4_000)], 5_000, 50);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(EXIT.INSUFFICIENT_FUNDS);
      expect((e as CliError).errorCode).toBe('insufficient_funds');
    }
  });

  it('throws insufficient_funds when the amount alone is covered but the fee is not', () => {
    try {
      selectUtxos([utxo(5_005)], 5_000, 50);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.INSUFFICIENT_FUNDS);
    }
  });

  it('throws insufficient_funds with an empty pool', () => {
    try {
      selectUtxos([], 1, 50);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.INSUFFICIENT_FUNDS);
    }
  });
});
