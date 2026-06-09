import os from 'node:os';
import path from 'node:path';

export type Network = 'main' | 'test';

/** Base state directory; BSV_PAY_HOME overrides for tests. */
export function baseDir(): string {
  return process.env.BSV_PAY_HOME ?? path.join(os.homedir(), '.bsv-pay');
}

export function configPath(): string {
  return path.join(baseDir(), 'config.toml');
}

/** Testnet state lives separately from mainnet state (invariant 7). */
export function walletPath(network: Network): string {
  return path.join(baseDir(), network === 'test' ? 'wallet-testnet.json' : 'wallet.json');
}

export function ledgerPath(network: Network): string {
  return path.join(baseDir(), network === 'test' ? 'ledger-testnet.jsonl' : 'ledger.jsonl');
}
