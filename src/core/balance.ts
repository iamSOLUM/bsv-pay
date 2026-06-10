import { trackedAddressesFromLedger } from '../ledger.js';
import { readWalletFile } from '../wallet/wallet.js';
import { resolveCore, type CoreOptions } from './context.js';

export interface AddressBalanceResult {
  address: string;
  confirmedSats: number;
  unconfirmedSats: number;
}

export interface BalanceResult {
  confirmedSats: number;
  unconfirmedSats: number;
  addresses: AddressBalanceResult[];
}

/**
 * Aggregate balance across every address the wallet has issued. Addresses
 * come from the ledger, so no passphrase or unlock is needed (read-only
 * commands don't unlock — see DECISIONS.md M3). Throws code 2 `no_wallet`
 * when no wallet exists.
 */
export async function getBalance(opts: CoreOptions): Promise<BalanceResult> {
  const { network, provider } = resolveCore(opts);
  readWalletFile(network); // throws no_wallet with guidance when absent
  const addresses = trackedAddressesFromLedger(network);

  let confirmedSats = 0;
  let unconfirmedSats = 0;
  const perAddress: AddressBalanceResult[] = [];
  for (const address of addresses) {
    const b = await provider.getBalance(address);
    confirmedSats += b.confirmed;
    unconfirmedSats += b.unconfirmed;
    perAddress.push({ address, confirmedSats: b.confirmed, unconfirmedSats: b.unconfirmed });
  }
  return { confirmedSats, unconfirmedSats, addresses: perAddress };
}
