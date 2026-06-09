import { CliError, EXIT } from '../errors.js';

/**
 * BRC-100 wallet connection — deferred (see DECISIONS.md). The interface is
 * the integration point; connectBrc100 is the stub that will be replaced.
 */
export interface Brc100Connection {
  getPublicKey(args: { identityKey: boolean }): Promise<string>;
  createAction(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  signAction(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function connectBrc100(): never {
  throw new CliError(
    EXIT.USAGE,
    'brc100_not_supported',
    'BRC-100 wallet connection is not yet supported. Use a local wallet: "bsv-pay init" (create) or "bsv-pay init --import-seed".',
  );
}
