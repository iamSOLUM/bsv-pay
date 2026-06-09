import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { cmdSend } from './send.js';

export interface DonateOptions {
  yes?: boolean;
  allowLarge?: boolean;
  dryRun?: boolean;
}

// TODO: replace with the real project donation addresses before 1.0.
// These are well-known placeholder addresses (no one holds their keys) —
// the warning below makes sure nobody burns real coins by accident.
const DONATION_ADDRESS: Record<'main' | 'test', string> = {
  main: '1BitcoinEaterAddressDontSendf59kuE',
  test: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
};

const DEFAULT_AMOUNT = '10000';

export async function cmdDonate(
  ctx: Ctx,
  amount: string | undefined,
  opts: DonateOptions,
  provider?: ChainProvider,
): Promise<void> {
  process.stderr.write(
    chalk.yellow(
      'NOTE: the donation address is still a PLACEHOLDER (see TODO in donate.ts) — coins sent to it are unrecoverable. Use --dry-run unless you really mean it.',
    ) + '\n',
  );
  process.stderr.write('Thanks for supporting bsv-pay!\n');
  await cmdSend(
    ctx,
    DONATION_ADDRESS[ctx.network],
    amount ?? DEFAULT_AMOUNT,
    'bsv-pay donation',
    { ...opts },
    provider,
  );
}
