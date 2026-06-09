import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export async function cmdBalance(_ctx: Ctx): Promise<void> {
  throw new CliError(EXIT.UNEXPECTED, 'not_implemented', 'balance is not implemented yet (M3).');
}
