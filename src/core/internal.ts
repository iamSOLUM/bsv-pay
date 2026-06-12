import type { Brc100Wallet } from '../wallet/brc100.js';
import type { Wallet } from '../wallet/wallet.js';
import type { CoreWallet } from './wallet.js';

/**
 * Module-private bridge between the public CoreWallet (addresses/metadata
 * only — invariant 1) and the custody backend behind it: the local signing
 * Wallet, or the BRC-100 external-wallet handle (key-capable by proxy, so
 * it stays behind the same boundary). Core modules register and unwrap
 * here; this file is deliberately NOT exported from core/index.ts, so
 * key-capable objects never cross the public library boundary.
 */
export type InnerBackend =
  | { kind: 'local'; wallet: Wallet }
  | { kind: 'brc100'; wallet: Brc100Wallet };

const inner = new WeakMap<CoreWallet, InnerBackend>();

export function registerWallet(pub: CoreWallet, backend: InnerBackend): void {
  inner.set(pub, backend);
}

export function unwrapBackend(pub: CoreWallet): InnerBackend {
  const backend = inner.get(pub);
  if (!backend) {
    throw new Error('CoreWallet is not registered; obtain it from openWallet().');
  }
  return backend;
}

/** The local signing wallet. Callers must branch on backend kind first. */
export function unwrapWallet(pub: CoreWallet): Wallet {
  const backend = unwrapBackend(pub);
  if (backend.kind !== 'local') {
    throw new Error(
      'Internal misuse: this code path needs the local signing wallet but the CoreWallet delegates to BRC-100 custody.',
    );
  }
  return backend.wallet;
}
