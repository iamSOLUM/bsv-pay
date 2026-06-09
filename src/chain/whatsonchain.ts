import { networkError } from '../errors.js';
import type { Network } from '../paths.js';
import type {
  AddressBalance,
  BroadcastResult,
  ChainProvider,
  HistoryItem,
  Utxo,
} from './provider.js';

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_500;
const RATE_LIMIT_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface WocUnspent {
  height: number;
  tx_pos: number;
  tx_hash: string;
  value: number;
}

interface WocHistory {
  tx_hash: string;
  height: number;
}

export class WhatsOnChainProvider implements ChainProvider {
  readonly baseUrl: string;

  constructor(public readonly network: Network) {
    // BSV_PAY_API_URL points at any WhatsOnChain-compatible API root
    // (self-hosted instance, or the local e2e mock server).
    const root = process.env.BSV_PAY_API_URL ?? 'https://api.whatsonchain.com/v1/bsv';
    this.baseUrl = `${root.replace(/\/$/, '')}/${network}`;
  }

  /**
   * GET with one automatic retry (invariant 5). 429s wait longer before the
   * retry; persistent failure is exit 4.
   */
  private async get(path: string): Promise<string> {
    const url = this.baseUrl + path;
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.ok) return await res.text();
        lastError = `HTTP ${res.status}`;
        if (res.status === 404) break; // not retryable
        await sleep(res.status === 429 ? RATE_LIMIT_DELAY_MS : RETRY_DELAY_MS);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt === 0) await sleep(RETRY_DELAY_MS);
      }
    }
    throw networkError(
      `WhatsOnChain request failed (${lastError}) for ${url}. Check your connection and retry; the API may be briefly rate-limiting.`,
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    const body = await this.get(path);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw networkError(`WhatsOnChain returned unparseable JSON for ${path}. Retry shortly.`);
    }
  }

  async getBalance(address: string): Promise<AddressBalance> {
    return this.getJson<AddressBalance>(`/address/${address}/balance`);
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const rows = await this.getJson<WocUnspent[]>(`/address/${address}/unspent`);
    return rows.map((r) => ({
      txid: r.tx_hash,
      vout: r.tx_pos,
      satoshis: r.value,
      height: r.height > 0 ? r.height : undefined,
    }));
  }

  async getHistory(address: string): Promise<HistoryItem[]> {
    const rows = await this.getJson<WocHistory[]>(`/address/${address}/history`);
    return rows.map((r) => ({ txid: r.tx_hash, height: r.height }));
  }

  async getRawTx(txid: string): Promise<string> {
    return (await this.get(`/tx/${txid}/hex`)).trim();
  }

  /**
   * Broadcast is NOT silently retried: a retry after an ambiguous failure
   * could double-report. A definitive API rejection returns ok=false; an
   * ambiguous network failure throws (caller maps to exit 6, status unknown).
   */
  async broadcast(rawTxHex: string): Promise<BroadcastResult> {
    const url = `${this.baseUrl}/tx/raw`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: rawTxHex }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(
        `Broadcast request did not complete (${e instanceof Error ? e.message : String(e)}). The transaction may or may not have propagated.`,
      );
    }
    const body = (await res.text()).trim();
    if (res.ok) {
      // WoC returns the txid as a JSON string
      const txid = body.replace(/^"|"$/g, '');
      return { ok: true, txid };
    }
    return { ok: false, error: body || `HTTP ${res.status}` };
  }
}
