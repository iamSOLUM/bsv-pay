import { trackedAddressesFromLedger } from '../ledger.js';
import { connectBrc100 } from '../wallet/brc100.js';
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
  /** BRC-100 custody (additive, M12): the external wallet reported the total. */
  backend?: 'brc100';
}

/**
 * Aggregate balance across every address the wallet has issued. Addresses
 * come from the ledger, so no passphrase or unlock is needed (read-only
 * commands don't unlock — see DECISIONS.md M3). Throws code 2 `no_wallet`
 * when no wallet exists.
 *
 * BRC-100 custody: the external wallet reports one spendable total — it
 * does not expose per-address detail or a confirmed/unconfirmed split, so
 * the total lands in confirmedSats and `addresses` is empty.
 */
export async function getBalance(opts: CoreOptions): Promise<BalanceResult> {
  const { network, provider } = resolveCore(opts);
  const file = readWalletFile(network); // throws no_wallet with guidance when absent

  if (file.backend === 'brc100') {
    const brc100 = await connectBrc100(network, { url: file.brc100_url, wallet: opts.brc100 });
    const totalSats = await brc100.getBalanceSats();
    return { confirmedSats: totalSats, unconfirmedSats: 0, addresses: [], backend: 'brc100' };
  }

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
