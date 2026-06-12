import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { getBalance } from '../core/balance.js';
import { formatSats } from '../units.js';

export async function cmdBalance(ctx: Ctx, provider?: ChainProvider): Promise<void> {
  const balance = await getBalance({ network: ctx.network, config: ctx.config, provider });

  ctx.out.info(chalk.bold(`Balance (${ctx.network === 'test' ? 'testnet' : 'mainnet'})`));
  if (balance.backend === 'brc100') {
    ctx.out.info(`  Spendable:    ${formatSats(balance.confirmedSats)}`);
    ctx.out.info('  Custody:      external BRC-100 wallet app (experimental)');
  } else {
    ctx.out.info(`  Confirmed:    ${formatSats(balance.confirmedSats)}`);
    ctx.out.info(`  Unconfirmed:  ${formatSats(balance.unconfirmedSats)}`);
    ctx.out.info(`  Total:        ${formatSats(balance.confirmedSats + balance.unconfirmedSats)}`);
    ctx.out.info(`  Tracked addresses: ${balance.addresses.length}`);
  }
  ctx.out.result({
    ok: true,
    confirmed_sats: balance.confirmedSats,
    unconfirmed_sats: balance.unconfirmedSats,
    addresses: balance.addresses.map((a) => ({
      address: a.address,
      confirmed_sats: a.confirmedSats,
      unconfirmed_sats: a.unconfirmedSats,
    })),
    ...(balance.backend ? { backend: balance.backend } : {}),
  });
}
