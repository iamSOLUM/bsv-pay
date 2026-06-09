import chalk from 'chalk';
import type { ChainProvider } from '../chain/provider.js';
import type { Ctx } from '../context.js';
import { cmdSend } from './send.js';

export interface DonateOptions {
  yes?: boolean;
  allowLarge?: boolean;
  dryRun?: boolean;
}

// TODO: the testnet address is still a well-known placeholder (no one holds
// its key) — replace if testnet donations ever matter.
const DONATION_ADDRESS: Record<'main' | 'test', string> = {
  main: '131CswxfV8Swi8zUSc3XfH9tEJLxzxmpa4',
  test: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
};

const DEFAULT_AMOUNT = '10000';

export async function cmdDonate(
  ctx: Ctx,
  amount: string | undefined,
  opts: DonateOptions,
  provider?: ChainProvider,
): Promise<void> {
  if (ctx.network === 'test') {
    process.stderr.write(
      chalk.yellow(
        'NOTE: the testnet donation address is a PLACEHOLDER — coins sent to it are unrecoverable. Use --dry-run.',
      ) + '\n',
    );
  }
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
