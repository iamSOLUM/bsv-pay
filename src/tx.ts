import { P2PKH, Transaction } from '@bsv/sdk';
import type { Utxo } from './chain/provider.js';
import { CliError, EXIT } from './errors.js';
import { formatSats } from './units.js';
import type { Wallet } from './wallet/wallet.js';

/** A UTXO annotated with the wallet address that owns it. */
export interface SpendableUtxo extends Utxo {
  address: string;
}

/**
 * Outputs below this are not worth creating as change — spending a P2PKH
 * input costs ~148 bytes, so tiny change is folded into the fee instead.
 */
export const DUST_LIMIT_SATS = 135;

/** Standard P2PKH size estimate: 10 overhead + 148/input + 34/output. */
export function estimateTxSizeBytes(nIn: number, nOut: number): number {
  return 10 + 148 * nIn + 34 * nOut;
}

export function feeForTx(nIn: number, nOut: number, rateSatsPerKb: number): number {
  return Math.max(1, Math.ceil((estimateTxSizeBytes(nIn, nOut) * rateSatsPerKb) / 1000));
}

export interface Selection {
  selected: SpendableUtxo[];
  fee: number;
  /** 0 when change was folded into the fee (sub-dust). */
  changeSats: number;
}

/**
 * Largest-first selection with a fee feedback loop. Assumes 2 outputs
 * (recipient + change); sub-dust change is folded into the fee.
 * Throws exit 3 when funds cannot cover amount + fee.
 */
export function selectUtxos(
  utxos: SpendableUtxo[],
  amountSats: number,
  rateSatsPerKb: number,
): Selection {
  const pool = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
  const selected: SpendableUtxo[] = [];
  let total = 0;

  for (const utxo of pool) {
    selected.push(utxo);
    total += utxo.satoshis;
    const fee = feeForTx(selected.length, 2, rateSatsPerKb);
    if (total >= amountSats + fee) {
      const change = total - amountSats - fee;
      if (change < DUST_LIMIT_SATS) {
        // fold sub-dust change into the fee (single-output tx)
        return { selected, fee: total - amountSats, changeSats: 0 };
      }
      return { selected, fee, changeSats: change };
    }
  }

  const available = utxos.reduce((s, u) => s + u.satoshis, 0);
  const feeGuess = feeForTx(Math.max(1, utxos.length), 2, rateSatsPerKb);
  throw new CliError(
    EXIT.INSUFFICIENT_FUNDS,
    'insufficient_funds',
    `Insufficient funds: trying to send ${formatSats(amountSats)} plus ~${feeGuess} sats fee, ` +
      `but only ${formatSats(available)} is spendable. Fund the wallet or send less.`,
    { available_sats: available, needed_sats: amountSats + feeGuess },
  );
}

/** Build and sign a P2PKH transaction spending the selection. */
export async function buildSignedTx(
  wallet: Wallet,
  selection: Selection,
  recipientAddress: string,
  amountSats: number,
  changeAddress: string,
): Promise<Transaction> {
  const tx = new Transaction();
  for (const utxo of selection.selected) {
    const key = wallet.privKeyForAddress(utxo.address);
    if (!key) {
      throw new CliError(
        EXIT.UNEXPECTED,
        'missing_key',
        `No signing key for tracked address ${utxo.address}.`,
      );
    }
    const sourceLock = new P2PKH().lock(utxo.address);
    tx.addInput({
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(key, 'all', false, utxo.satoshis, sourceLock),
      sequence: 0xffffffff,
    });
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(recipientAddress), satoshis: amountSats });
  if (selection.changeSats > 0) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(changeAddress),
      satoshis: selection.changeSats,
    });
  }
  await tx.sign();
  return tx;
}
