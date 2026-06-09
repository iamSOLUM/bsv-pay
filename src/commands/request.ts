import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export interface RequestOptions {
  wait?: boolean;
  timeout?: string;
}

export async function cmdRequest(
  _ctx: Ctx,
  _amount: string,
  _memo: string | undefined,
  _opts: RequestOptions,
): Promise<void> {
  throw new CliError(EXIT.UNEXPECTED, 'not_implemented', 'request is not implemented yet (M5).');
}
