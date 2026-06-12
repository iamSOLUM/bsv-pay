#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { buildCtx, type Ctx } from './context.js';
import { EXIT } from './errors.js';
import { Output } from './output.js';
import { cmdInit, type InitOptions } from './commands/init.js';
import { cmdBalance } from './commands/balance.js';
import { cmdSend, type SendOptions } from './commands/send.js';
import { cmdRequest, type RequestOptions } from './commands/request.js';
import { cmdWatch } from './commands/watch.js';
import { cmdDonate, type DonateOptions } from './commands/donate.js';
import { cmdFetch, type FetchOptions } from './commands/fetch.js';
import { cmdMcp } from './commands/mcp.js';
import { cmdPolicyShow, cmdPolicyTest } from './commands/policy.js';
import { cmdServe, type ServeOptions } from './commands/serve.js';
import {
  cmdApprovalsApprove,
  cmdApprovalsList,
  cmdApprovalsReject,
  cmdApprovalsSetSecret,
} from './commands/approvals.js';

const program = new Command();

interface GlobalOpts {
  json?: boolean;
  testnet?: boolean;
}

/** Wrap a command action: build context, map errors to exit codes + JSON. */
function run<A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<void>) {
  return async (...cmdArgs: unknown[]): Promise<void> => {
    // Commander passes (...args, options, command); we use optsWithGlobals.
    const command = cmdArgs[cmdArgs.length - 1] as Command;
    const opts = command.optsWithGlobals() as GlobalOpts;
    let ctx: Ctx | undefined;
    try {
      ctx = buildCtx(opts);
      // keep positional args + the options object, drop the trailing Command
      await fn(ctx, ...(cmdArgs.slice(0, -1) as A));
      process.exitCode = EXIT.OK;
    } catch (err) {
      const out = ctx?.out ?? new Output(Boolean(opts.json));
      process.exitCode = out.error(err);
    }
  };
}

program
  .name('bsv-pay')
  .description('Send and receive Bitcoin SV micropayments from the command line')
  .version('0.1.0')
  .option('--json', 'machine-readable JSON output (NDJSON for watch)')
  .option('--testnet', 'use BSV testnet (state kept separate from mainnet)');

program
  .command('init')
  .description('Create or import a wallet')
  .option('--import-seed', 'import an existing BIP-39 seed phrase')
  .option('--import-wif', 'import a raw WIF private key (not recommended)')
  .option('--force', 'overwrite an existing wallet')
  .option('--no-encrypt', 'EXPLICIT OPT-IN: store the seed unencrypted (dangerous)')
  .option('--brc100', 'connect a BRC-100 wallet (not yet supported)')
  .action(run<[InitOptions]>((ctx, opts) => cmdInit(ctx, opts)));

program
  .command('balance')
  .description('Show confirmed and unconfirmed balance across all tracked addresses')
  .action(run((ctx) => cmdBalance(ctx)));

program
  .command('send')
  .description('Send satoshis to an address')
  .argument('<address>', 'recipient BSV address')
  .argument('<amount>', 'amount: bare satoshis, Nsats, or Nbsv')
  .argument('[memo]', 'local-only memo for your ledger (never written on-chain)')
  .option('-y, --yes', 'skip the confirmation prompt (spend limit still enforced)')
  .option('--allow-large', 'with --yes, permit sends at/above the spend limit')
  .option('--dry-run', 'build and display the transaction but never broadcast')
  .option('--confirmed-only', 'spend only confirmed UTXOs')
  .action(
    run<[string, string, string | undefined, SendOptions]>((ctx, address, amount, memo, opts) =>
      cmdSend(ctx, address, amount, memo, opts),
    ),
  );

program
  .command('request')
  .description('Create a payment request with a fresh address, URI, and QR code')
  .argument('<amount>', 'amount: bare satoshis, Nsats, or Nbsv')
  .argument('[memo]', 'local-only memo / request label')
  .option('--wait', 'poll until the payment is seen (0-conf), then exit 0')
  .option('--timeout <sec>', 'with --wait, give up after this many seconds', '600')
  .action(
    run<[string, string | undefined, RequestOptions]>((ctx, amount, memo, opts) =>
      cmdRequest(ctx, amount, memo, opts),
    ),
  );

program
  .command('watch')
  .description('Watch all tracked addresses for incoming payments')
  .option('--interval <sec>', 'poll interval in seconds (floor 5)')
  .action(run<[{ interval?: string }]>((ctx, opts) => cmdWatch(ctx, opts)));

program
  .command('donate')
  .description('Support bsv-pay development')
  .argument('[amount]', 'amount to donate (default 10000 sats)')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--allow-large', 'with --yes, permit sends at/above the spend limit')
  .option('--dry-run', 'build and display the transaction but never broadcast')
  .action(
    run<[string | undefined, DonateOptions]>((ctx, amount, opts) => cmdDonate(ctx, amount, opts)),
  );

program
  .command('fetch')
  .description('Fetch a URL, automatically paying a BRC-105 402 paywall within policy')
  .argument('<url>', 'http(s) URL to fetch')
  .option('--max-price <amount>', 'refuse to pay more than this for the resource')
  .action(run<[string, FetchOptions]>((ctx, url, opts) => cmdFetch(ctx, url, opts)));

program
  .command('serve')
  .description('Run a demo BRC-105 paywall server: each request pays --price into this wallet')
  .requiredOption('--price <amount>', 'price per request: bare satoshis, Nsats, or Nbsv')
  .option('--port <n>', 'port to listen on', '8402')
  .option('--host <host>', 'interface to bind (default localhost-only)', '127.0.0.1')
  .option('--body <text>', 'content to serve once paid')
  .action(run<[ServeOptions]>((ctx, opts) => cmdServe(ctx, opts)));

program
  .command('mcp')
  .description(
    'Serve MCP tools over stdio for AI agents (wallet unlocks at start; policy enforced in core)',
  )
  .action(run((ctx) => cmdMcp(ctx)));

const policy = program
  .command('policy')
  .description('Inspect and dry-run the spend policy (~/.bsv-pay/policy.toml)');
policy
  .command('show')
  .description('Show active policy rules, current budget usage, and pending approvals')
  .action(run((ctx) => Promise.resolve(cmdPolicyShow(ctx))));
policy
  .command('test')
  .description('Dry-run a policy decision: exit 0 allow, 8 deny, 9 would-queue')
  .argument('<address>', 'recipient BSV address')
  .argument('<amount>', 'amount: bare satoshis, Nsats, or Nbsv')
  .action(
    run<[string, string]>((ctx, address, amount) =>
      Promise.resolve(cmdPolicyTest(ctx, address, amount)),
    ),
  );

const approvals = program
  .command('approvals')
  .description('Review and resolve payments queued by approval_threshold_sats');
approvals
  .command('list')
  .description('List payments waiting for human approval')
  .action(run((ctx) => Promise.resolve(cmdApprovalsList(ctx))));
approvals
  .command('approve')
  .description('Approve and send a queued payment (interactive: approval secret required)')
  .argument('<id>', 'approval id (or unambiguous prefix) from "approvals list"')
  .action(run<[string]>((ctx, id) => cmdApprovalsApprove(ctx, id)));
approvals
  .command('reject')
  .description('Reject a queued payment (interactive: approval secret required)')
  .argument('<id>', 'approval id (or unambiguous prefix) from "approvals list"')
  .action(run<[string]>((ctx, id) => cmdApprovalsReject(ctx, id)));
approvals
  .command('set-secret')
  .description('Set or change the human approval secret (interactive only, by design)')
  .action(run((ctx) => cmdApprovalsSetSecret(ctx)));

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    // help/version display are success; everything else is invalid usage.
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.version' ||
      err.code === 'commander.help'
    ) {
      process.exitCode = err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    } else {
      const json = process.argv.includes('--json');
      if (json) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            code: EXIT.USAGE,
            error: 'invalid_usage',
            message: err.message,
          }) + '\n',
        );
      }
      process.exitCode = EXIT.USAGE;
    }
  } else {
    process.exitCode = new Output(process.argv.includes('--json')).error(err);
  }
}
