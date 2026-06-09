import type { Network } from '../paths.js';

export interface Utxo {
  txid: string;
  vout: number;
  satoshis: number;
  /** Block height; 0 or undefined means unconfirmed (mempool). */
  height?: number;
}

export interface AddressBalance {
  confirmed: number;
  unconfirmed: number;
}

export interface HistoryItem {
  txid: string;
  /** 0 or -1 means unconfirmed. */
  height: number;
}

export interface BroadcastResult {
  ok: boolean;
  txid?: string;
  /** Miner/API rejection message when ok is false. */
  error?: string;
}

/**
 * Chain access abstraction. WhatsOnChain is the default implementation;
 * keep this interface provider-agnostic so it can be swapped later.
 */
export interface ChainProvider {
  readonly network: Network;
  getBalance(address: string): Promise<AddressBalance>;
  getUtxos(address: string): Promise<Utxo[]>;
  getHistory(address: string): Promise<HistoryItem[]>;
  getRawTx(txid: string): Promise<string>;
  broadcast(rawTxHex: string): Promise<BroadcastResult>;
}
