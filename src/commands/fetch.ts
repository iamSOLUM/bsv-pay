import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { openWallet } from '../core/wallet.js';
import { paidFetch } from '../http402/client.js';
import { formatSats, parseAmount } from '../units.js';
import { obtainPassphrase } from '../wallet/wallet.js';

export interface FetchOptions {
  maxPrice?: string;
}

/**
 * `bsv-pay fetch <url>` — GET a resource, automatically paying a BRC-105
 * 402 within policy. The body is the machine output (raw to stdout, or
 * inside the --json object); everything about the payment goes to stderr.
 * Exit 8 = capped/denied before money moved, 9 = queued for approval,
 * 10 = paid but the server refused the content (txid in the error).
 */
export async function cmdFetch(
  ctx: Ctx,
  url: string,
  opts: FetchOptions,
  provider?: ChainProvider,
): Promise<void> {
  const maxPriceSats = opts.maxPrice !== undefined ? parseAmount(opts.maxPrice) : undefined;
  const core = { network: ctx.network, config: ctx.config, provider };
  const wallet = await openWallet({
    ...core,
    passphrase: () => obtainPassphrase(),
    onWarning: (text) => process.stderr.write(text + '\n'),
  });

  const result = await paidFetch(wallet, core, { url, maxPriceSats });

  if (result.paid) {
    process.stderr.write(
      chalk.green(
        `paid ${formatSats(result.payment!.amountSats)} (+${result.payment!.feeSats} sats fee, txid ${result.payment!.txid.slice(0, 12)}…) for ${url}`,
      ) + '\n',
    );
  } else {
    process.stderr.write(`no payment required (HTTP ${result.status})\n`);
  }

  if (ctx.json) {
    ctx.out.result({
      ok: true,
      status: result.status,
      paid: result.paid,
      ...(result.contentType !== undefined && { content_type: result.contentType }),
      ...(result.payment && {
        amount_sats: result.payment.amountSats,
        fee_sats: result.payment.feeSats,
        txid: result.payment.txid,
        address: result.payment.address,
      }),
      body: result.body,
    });
  } else {
    // the resource itself is the machine output
    process.stdout.write(result.body);
    if (result.body.length > 0 && !result.body.endsWith('\n')) process.stdout.write('\n');
  }
}
