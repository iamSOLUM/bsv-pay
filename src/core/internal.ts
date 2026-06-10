import type { Wallet } from '../wallet/wallet.js';
import type { CoreWallet } from './wallet.js';

/**
 * Module-private bridge between the public CoreWallet (addresses/metadata
 * only — invariant 1) and the signing Wallet. Core modules register and
 * unwrap here; this file is deliberately NOT exported from core/index.ts,
 * so the key-capable Wallet never crosses the public library boundary.
 */
const inner = new WeakMap<CoreWallet, Wallet>();

export function registerWallet(pub: CoreWallet, wallet: Wallet): void {
  inner.set(pub, wallet);
}

export function unwrapWallet(pub: CoreWallet): Wallet {
  const wallet = inner.get(pub);
  if (!wallet) {
    throw new Error('CoreWallet is not registered; obtain it from openWallet().');
  }
  return wallet;
}
