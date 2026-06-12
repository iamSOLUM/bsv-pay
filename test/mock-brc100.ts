import { LockingScript, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { WERR_INSUFFICIENT_FUNDS } from '@bsv/sdk';
import type {
  CreateActionArgs,
  CreateActionResult,
  ListOutputsArgs,
  ListOutputsResult,
} from '@bsv/sdk';
import type { Brc100Interface } from '../src/wallet/brc100.js';

/**
 * In-memory BRC-100 "wallet app" for tests: it holds its own key (which
 * must never surface through bsv-pay — the key-boundary tests scan for
 * it), funds/signs createAction requests against an in-memory UTXO set,
 * and answers listOutputs like a real wallet's default basket.
 */
export class MockBrc100Wallet implements Brc100Interface {
  readonly key = PrivateKey.fromRandom();
  readonly address: string;
  /** Flat fee the "wallet app" takes per action. */
  feeSats = 10;
  utxos: { tx: Transaction; vout: number; satoshis: number }[] = [];
  createActionCalls: CreateActionArgs[] = [];
  /** Raw hex of every transaction the wallet "broadcast". */
  broadcasts: string[] = [];
  /** Set to make the next createAction fail (e.g. the human declined). */
  failNextAction: Error | null = null;

  constructor(public network: 'mainnet' | 'testnet' = 'mainnet') {
    this.address = network === 'testnet' ? this.key.toAddress('testnet') : this.key.toAddress();
  }

  /** Credit the wallet with a confirmed (fake-proven) funding output. */
  fund(satoshis: number): void {
    const fundTx = new Transaction();
    fundTx.addOutput({ lockingScript: new P2PKH().lock(this.address), satoshis });
    fundTx.merklePath = new MerklePath(800_000, [
      [{ offset: 0, hash: fundTx.id('hex'), txid: true }],
    ]);
    this.utxos.push({ tx: fundTx, vout: 0, satoshis });
  }

  totalSats(): number {
    return this.utxos.reduce((s, u) => s + u.satoshis, 0);
  }

  async getVersion(): Promise<{ version: string }> {
    return { version: 'mock-brc100 1.0.0' };
  }

  async getNetwork(): Promise<{ network: 'mainnet' | 'testnet' }> {
    return { network: this.network };
  }

  async waitForAuthentication(): Promise<{ authenticated: true }> {
    return { authenticated: true };
  }

  async getPublicKey(): Promise<{ publicKey: string }> {
    return { publicKey: this.key.toPublicKey().toString() };
  }

  async listOutputs(_args: ListOutputsArgs): Promise<ListOutputsResult> {
    return {
      totalOutputs: this.utxos.length,
      outputs: this.utxos.map((u) => ({
        satoshis: u.satoshis,
        spendable: true,
        outpoint: `${u.tx.id('hex')}.${u.vout}`,
      })),
    };
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    this.createActionCalls.push(args);
    if (this.failNextAction) {
      const err = this.failNextAction;
      this.failNextAction = null;
      throw err;
    }

    const requested = args.outputs ?? [];
    const outputSum = requested.reduce((s, o) => s + o.satoshis, 0);
    const needed = outputSum + this.feeSats;

    const pool = [...this.utxos].sort((a, b) => b.satoshis - a.satoshis);
    const selected: typeof this.utxos = [];
    let total = 0;
    for (const u of pool) {
      if (total >= needed) break;
      selected.push(u);
      total += u.satoshis;
    }
    if (total < needed) {
      throw new WERR_INSUFFICIENT_FUNDS(needed, needed - total);
    }

    const tx = new Transaction();
    for (const u of selected) {
      tx.addInput({
        sourceTransaction: u.tx,
        sourceOutputIndex: u.vout,
        unlockingScriptTemplate: new P2PKH().unlock(
          this.key,
          'all',
          false,
          u.satoshis,
          new P2PKH().lock(this.address),
        ),
      });
    }
    for (const o of requested) {
      tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
    }
    const change = total - outputSum - this.feeSats;
    if (change > 0) {
      tx.addOutput({ lockingScript: new P2PKH().lock(this.address), satoshis: change });
    }
    await tx.sign();
    const rawTxHex = tx.toHex();
    const beef = tx.toAtomicBEEF();
    this.broadcasts.push(rawTxHex);

    // Update the wallet's own view: spent outputs go, change arrives (the
    // new tx gets a fake proof AFTER beef serialization, so it can fund the
    // next action without bloating this action's ancestry).
    this.utxos = this.utxos.filter((u) => !selected.includes(u));
    if (change > 0) {
      tx.merklePath = new MerklePath(800_001, [[{ offset: 0, hash: tx.id('hex'), txid: true }]]);
      this.utxos.push({ tx, vout: requested.length, satoshis: change });
    }
    return { txid: tx.id('hex'), tx: beef };
  }
}
