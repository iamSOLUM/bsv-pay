import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { awaitPayment, buildPaymentUri, createRequest } from '../core/request.js';
import { openWallet } from '../core/wallet.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { formatSats, parseAmount } from '../units.js';
import { obtainPassphrase } from '../wallet/wallet.js';
import { explorerTxUrl } from './send.js';

export { buildPaymentUri };

export interface RequestOptions {
  wait?: boolean;
  timeout?: string;
}

function renderQr(uri: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(uri, { small: true }, (qr) => resolve(qr));
  });
}

export async function cmdRequest(
  ctx: Ctx,
  amountArg: string,
  memo: string | undefined,
  opts: RequestOptions,
  provider?: ChainProvider,
): Promise<void> {
  const amountSats = parseAmount(amountArg);
  const timeoutSec = Number(opts.timeout ?? '600');
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    throw usageError(
      'invalid_timeout',
      `--timeout must be a positive integer of seconds (got "${opts.timeout}").`,
    );
  }

  const core = { network: ctx.network, config: ctx.config, provider };
  const wallet = await openWallet({
    ...core,
    passphrase: () => obtainPassphrase(), // env var, then interactive prompt
    onWarning: (text) => process.stderr.write(text + '\n'),
  });
  const { address, uri } = createRequest(wallet, { amountSats, memo });

  ctx.out.info(chalk.bold('Payment request'));
  ctx.out.info(`  Address:  ${address}`);
  ctx.out.info(`  Amount:   ${formatSats(amountSats)}`);
  if (memo) ctx.out.info(`  Memo:     ${memo} (local only)`);
  ctx.out.info(`  URI:      ${uri}`);
  // QR only on a real terminal, never when piped or in --json mode
  if (!ctx.json && process.stdout.isTTY) {
    ctx.out.info('');
    ctx.out.info(await renderQr(uri));
  }

  const requestObj = {
    ok: true,
    event: 'request_created',
    address,
    amount_sats: amountSats,
    uri,
    ...(memo ? { memo } : {}),
    network: ctx.network,
  };

  if (!opts.wait) {
    ctx.out.result(requestObj);
    return;
  }

  // --wait emits NDJSON in --json mode: the request first, then the outcome
  // (a script needs the address before anyone can pay it). See DECISIONS.md.
  ctx.out.result(requestObj);
  ctx.out.info('');
  ctx.out.info(`Waiting for payment (0-conf), timeout ${timeoutSec}s — Ctrl-C to stop...`);

  let paid;
  try {
    paid = await awaitPayment(core, { address, timeoutMs: timeoutSec * 1000, memo });
  } catch (e) {
    // keep the CLI's original timeout message and data shape
    if (e instanceof CliError && e.errorCode === 'request_timeout') {
      throw new CliError(
        EXIT.NETWORK,
        'request_timeout',
        `No payment seen on ${address} within ${timeoutSec}s. The request URI is still valid; re-run with --wait to keep watching.`,
        { address, amount_sats: amountSats },
      );
    }
    throw e;
  }

  ctx.out.info(chalk.green('Payment received.'));
  ctx.out.info(`  Amount:    ${formatSats(paid.receivedSats)}`);
  ctx.out.info(`  Txid:      ${paid.txid}`);
  ctx.out.info(`  Explorer:  ${explorerTxUrl(ctx.network, paid.txid)}`);
  if (paid.receivedSats < amountSats) {
    process.stderr.write(
      chalk.yellow(
        `Note: received ${formatSats(paid.receivedSats)} is less than the requested ${formatSats(amountSats)}.`,
      ) + '\n',
    );
  }
  ctx.out.result({
    ok: true,
    event: 'payment_received',
    address,
    requested_sats: amountSats,
    received_sats: paid.receivedSats,
    txid: paid.txid,
    status: paid.confirmed ? 'confirmed' : 'pending',
    explorer_url: explorerTxUrl(ctx.network, paid.txid),
  });
}
