import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export interface SendOptions {
  yes?: boolean;
  allowLarge?: boolean;
  dryRun?: boolean;
  confirmedOnly?: boolean;
}

export async function cmdSend(
  _ctx: Ctx,
  _address: string,
  _amount: string,
  _memo: string | undefined,
  _opts: SendOptions,
): Promise<void> {
  throw new CliError(EXIT.UNEXPECTED, 'not_implemented', 'send is not implemented yet (M4).');
}
