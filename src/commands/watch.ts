import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export async function cmdWatch(_ctx: Ctx, _opts: { interval?: string }): Promise<void> {
  throw new CliError(EXIT.UNEXPECTED, 'not_implemented', 'watch is not implemented yet (M6).');
}
