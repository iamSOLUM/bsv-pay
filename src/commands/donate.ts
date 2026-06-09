import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export interface DonateOptions {
  yes?: boolean;
  allowLarge?: boolean;
  dryRun?: boolean;
}

export async function cmdDonate(
  _ctx: Ctx,
  _amount: string | undefined,
  _opts: DonateOptions,
): Promise<void> {
  throw new CliError(EXIT.UNEXPECTED, 'not_implemented', 'donate is not implemented yet (M7).');
}
