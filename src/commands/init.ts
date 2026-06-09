import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export interface InitOptions {
  importSeed?: boolean;
  importWif?: boolean;
  force?: boolean;
  encrypt?: boolean;
}

export async function cmdInit(_ctx: Ctx, _opts: InitOptions): Promise<void> {
  throw new CliError(EXIT.UNEXPECTED, 'not_implemented', 'init is not implemented yet (M2).');
}
