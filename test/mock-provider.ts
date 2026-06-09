import type {
  AddressBalance,
  BroadcastResult,
  ChainProvider,
  HistoryItem,
  Utxo,
} from '../src/chain/provider.js';
import type { Network } from '../src/paths.js';

/** In-memory ChainProvider for command-level tests (no live network in CI). */
export class MockChainProvider implements ChainProvider {
  balances = new Map<string, AddressBalance>();
  utxos = new Map<string, Utxo[]>();
  history = new Map<string, HistoryItem[]>();
  rawTxs = new Map<string, string>();
  broadcasts: string[] = [];
  broadcastResult: BroadcastResult = { ok: true, txid: 'a'.repeat(64) };
  broadcastError: Error | null = null;

  constructor(public readonly network: Network = 'main') {}

  async getBalance(address: string): Promise<AddressBalance> {
    return this.balances.get(address) ?? { confirmed: 0, unconfirmed: 0 };
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    return this.utxos.get(address) ?? [];
  }

  async getHistory(address: string): Promise<HistoryItem[]> {
    return this.history.get(address) ?? [];
  }

  async getRawTx(txid: string): Promise<string> {
    const hex = this.rawTxs.get(txid);
    if (!hex) throw new Error(`mock: no raw tx for ${txid}`);
    return hex;
  }

  async broadcast(rawTxHex: string): Promise<BroadcastResult> {
    if (this.broadcastError) throw this.broadcastError;
    this.broadcasts.push(rawTxHex);
    return this.broadcastResult;
  }
}
