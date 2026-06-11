/** Stable exit codes, documented in README. */
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  INSUFFICIENT_FUNDS: 3,
  NETWORK: 4,
  BROADCAST_REJECTED: 5,
  BROADCAST_UNKNOWN: 6,
  WALLET_LOCKED: 7,
  SPEND_LIMIT: 8,
  /** Phase 2: the spend was queued for human approval instead of sent. */
  PENDING_APPROVAL: 9,
  /** Phase 2: a 402 payment broadcast but the server refused the content. */
  PAYMENT_NOT_REDEEMED: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Error carrying a stable exit code and a snake_case machine-readable code
 * for --json output. `data` is merged into the JSON error object (never
 * include key material).
 */
export class CliError extends Error {
  constructor(
    public readonly exitCode: ExitCode,
    public readonly errorCode: string,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function usageError(errorCode: string, message: string): CliError {
  return new CliError(EXIT.USAGE, errorCode, message);
}

export function networkError(message: string, data?: Record<string, unknown>): CliError {
  return new CliError(EXIT.NETWORK, 'network_error', message, data);
}
