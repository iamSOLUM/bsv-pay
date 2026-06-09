import chalk from 'chalk';
import { CliError, EXIT } from './errors.js';

/**
 * Output discipline (invariant 2): in --json mode, stdout carries exactly one
 * JSON object (or NDJSON lines for watch) and nothing else; all human text
 * goes to stderr. Chalk auto-disables color when the stream is not a TTY.
 */
export class Output {
  constructor(public readonly json: boolean) {}

  /** Human-facing informational text. stdout normally, suppressed in --json mode. */
  info(text: string): void {
    if (!this.json) process.stdout.write(text + '\n');
  }

  /** Human-facing notice that must survive --json mode (warnings, prompts context) — goes to stderr. */
  warn(text: string): void {
    process.stderr.write(chalk.yellow(text) + '\n');
  }

  /** The single JSON result object (or one NDJSON event line). */
  result(obj: Record<string, unknown>): void {
    if (this.json) process.stdout.write(JSON.stringify(obj) + '\n');
  }

  /** Render an error: human message to stderr; JSON error object to stdout in --json mode. */
  error(err: unknown): number {
    const cliErr =
      err instanceof CliError
        ? err
        : new CliError(
            EXIT.UNEXPECTED,
            'unexpected_error',
            err instanceof Error ? err.message : String(err),
          );
    process.stderr.write(chalk.red(`Error: ${cliErr.message}`) + '\n');
    if (this.json) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          code: cliErr.exitCode,
          error: cliErr.errorCode,
          message: cliErr.message,
          ...cliErr.data,
        }) + '\n',
      );
    }
    return cliErr.exitCode;
  }
}
