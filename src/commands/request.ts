import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import type { ChainProvider } from '../chain/provider.js';
import { WhatsOnChainProvider } from '../chain/whatsonchain.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { appendLedger } from '../ledger.js';
import { satsToBsvString, formatSats, parseAmount } from '../units.js';
import { Wallet } from '../wallet/wallet.js';
import { explorerTxUrl } from './send.js';

export interface RequestOptions {
  wait?: boolean;
  timeout?: string;
}

/** BIP-21-style URI with the BSV `sv` discriminator. Amount is in BSV. */
export function buildPaymentUri(address: string, amountSats: number, memo?: string): string {
  let uri = `bitcoin:${address}?sv&amount=${satsToBsvString(amountSats)}`;
  if (memo) uri += `&label=${encodeURIComponent(memo)}`;
  return uri;
}

function renderQr(uri: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(uri, { small: true }, (qr) => resolve(qr));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface PaymentSeen {
  txid: string;
  receivedSats: number;
  confirmed: boolean;
}

/** Poll a fresh address until the first incoming payment appears at 0-conf. */
async function waitForPayment(
  chain: ChainProvider,
  address: string,
  deadlineMs: number,
  pollIntervalMs: number,
): Promise<PaymentSeen | null> {
  for (;;) {
    try {
      const utxos = await chain.getUtxos(address);
      if (utxos.length > 0) {
        const txid = utxos[0]!.txid;
        const receivedSats = utxos
          .filter((u) => u.txid === txid)
          .reduce((s, u) => s + u.satoshis, 0);
        return { txid, receivedSats, confirmed: (utxos[0]!.height ?? 0) > 0 };
      }
    } catch {
      // transient network/rate-limit failure: keep polling until the deadline
    }
    if (Date.now() >= deadlineMs) return null;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  }
}

export async function cmdRequest(
  ctx: Ctx,
  amountArg: string,
  memo: string | undefined,
  opts: RequestOptions,
  provider?: ChainProvider,
): Promise<void> {
  const chain = provider ?? new WhatsOnChainProvider(ctx.network);
  const amountSats = parseAmount(amountArg);
  const timeoutSec = Number(opts.timeout ?? '600');
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    throw usageError(
      'invalid_timeout',
      `--timeout must be a positive integer of seconds (got "${opts.timeout}").`,
    );
  }

  const wallet = await Wallet.unlock(ctx.network);
  const { address } = wallet.issueAddress('request', memo);
  const uri = buildPaymentUri(address, amountSats, memo);

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

  const paid = await waitForPayment(
    chain,
    address,
    Date.now() + timeoutSec * 1000,
    ctx.config.pollIntervalSecs * 1000,
  );

  if (!paid) {
    throw new CliError(
      EXIT.NETWORK,
      'request_timeout',
      `No payment seen on ${address} within ${timeoutSec}s. The request URI is still valid; re-run with --wait to keep watching.`,
      { address, amount_sats: amountSats },
    );
  }

  appendLedger(ctx.network, {
    type: 'receive',
    txid: paid.txid,
    amount_sats: paid.receivedSats,
    address,
    memo,
    timestamp: new Date().toISOString(),
    status: paid.confirmed ? 'confirmed' : 'pending',
  });

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
