import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import { WhatsOnChainProvider } from '../chain/whatsonchain.js';
import type { Ctx } from '../context.js';
import { trackedAddressesFromLedger } from '../ledger.js';
import { readWalletFile } from '../wallet/wallet.js';
import { formatSats } from '../units.js';

export async function cmdBalance(ctx: Ctx, provider?: ChainProvider): Promise<void> {
  const chain = provider ?? new WhatsOnChainProvider(ctx.network);
  readWalletFile(ctx.network); // exits 2 with guidance when no wallet exists
  const addresses = trackedAddressesFromLedger(ctx.network);

  let confirmed = 0;
  let unconfirmed = 0;
  const perAddress: { address: string; confirmed_sats: number; unconfirmed_sats: number }[] = [];
  for (const address of addresses) {
    const b = await chain.getBalance(address);
    confirmed += b.confirmed;
    unconfirmed += b.unconfirmed;
    perAddress.push({ address, confirmed_sats: b.confirmed, unconfirmed_sats: b.unconfirmed });
  }

  ctx.out.info(chalk.bold(`Balance (${ctx.network === 'test' ? 'testnet' : 'mainnet'})`));
  ctx.out.info(`  Confirmed:    ${formatSats(confirmed)}`);
  ctx.out.info(`  Unconfirmed:  ${formatSats(unconfirmed)}`);
  ctx.out.info(`  Total:        ${formatSats(confirmed + unconfirmed)}`);
  ctx.out.info(`  Tracked addresses: ${addresses.length}`);
  ctx.out.result({
    ok: true,
    confirmed_sats: confirmed,
    unconfirmed_sats: unconfirmed,
    addresses: perAddress,
  });
}
