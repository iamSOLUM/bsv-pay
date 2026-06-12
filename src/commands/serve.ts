import http from 'node:http';
import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { openWallet } from '../core/wallet.js';
import { usageError } from '../errors.js';
import { requirePayment, type PaidRequest } from '../http402/middleware.js';
import { formatSats, parseAmount } from '../units.js';
import { obtainPassphrase } from '../wallet/wallet.js';

export interface ServeOptions {
  price: string;
  port?: string;
  host?: string;
  body?: string;
}

/**
 * `bsv-pay serve` — a demo BRC-105 paywall: every request must pay
 * `--price` into this wallet before it gets the content. Exists for
 * testing, tutorials, and the two-agent demo (M13); the real product is
 * the importable requirePayment() middleware this wraps. Human logging
 * goes to stderr; the HTTP responses are the machine surface.
 */
export async function cmdServe(
  ctx: Ctx,
  opts: ServeOptions,
  provider?: ChainProvider,
): Promise<void> {
  const priceSats = parseAmount(opts.price);
  const port = Number(opts.port ?? '8402');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw usageError('invalid_port', `--port must be 1-65535 (got "${opts.port}").`);
  }

  const core = { network: ctx.network, config: ctx.config, provider };
  const wallet = await openWallet({
    ...core,
    passphrase: () => obtainPassphrase(),
    onWarning: (text) => process.stderr.write(text + '\n'),
  });
  const gate = requirePayment({ ...core, wallet, priceSats });

  const server = http.createServer((req, res) => {
    gate(req, res, () => {
      const receipt = (req as PaidRequest).bsvPayment!;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          message: opts.body ?? 'Paid content served by bsv-pay.',
          amount_sats: receipt.amountSats,
          txid: receipt.txid,
        }),
      );
      process.stderr.write(
        chalk.green(
          `sold: ${formatSats(receipt.amountSats)} for ${req.url ?? '/'} (txid ${receipt.txid.slice(0, 12)}…)`,
        ) + '\n',
      );
    }).catch((err: unknown) => {
      process.stderr.write(
        chalk.red(`serve error: ${err instanceof Error ? err.message : String(err)}`) + '\n',
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      }
    });
  });

  const host = opts.host ?? '127.0.0.1'; // localhost-only unless explicitly exposed
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  process.stderr.write(
    `bsv-pay paywall on http://${host}:${port} — ${formatSats(priceSats)} per request, ` +
      `paid into this ${ctx.network === 'test' ? 'testnet' : 'mainnet'} wallet. Ctrl+C stops.\n`,
  );

  // Serve until interrupted.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => server.close(() => resolve()));
    process.once('SIGTERM', () => server.close(() => resolve()));
  });
}
