import fs from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { usageError } from './errors.js';
import { configPath, type Network } from './paths.js';

export interface Config {
  /** Default network; --testnet always wins. */
  network: Network;
  /** Fee rate in satoshis per kilobyte. */
  feeRateSatsPerKb: number;
  /** watch/request --wait poll interval, seconds (floor 5). */
  pollIntervalSecs: number;
  /** Per-transaction spend limit in satoshis. */
  spendLimitSats: number;
  /** Show fiat equivalents in human output. */
  fiatDisplay: boolean;
}

export const DEFAULT_CONFIG: Config = {
  network: 'main',
  feeRateSatsPerKb: 50,
  pollIntervalSecs: 10,
  spendLimitSats: 100_000,
  fiatDisplay: false,
};

function asNumber(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw usageError(
      'invalid_config',
      `Config key "${key}" must be a non-negative number. Fix ${configPath()}.`,
    );
  }
  return v;
}

/** Load ~/.bsv-pay/config.toml, falling back to defaults when absent. */
export function loadConfig(): Config {
  const file = configPath();
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };

  let doc: Record<string, unknown>;
  try {
    doc = parseToml(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw usageError(
      'invalid_config',
      `Cannot parse ${file}: ${e instanceof Error ? e.message : String(e)}. Fix the TOML syntax or delete the file to use defaults.`,
    );
  }

  const cfg = { ...DEFAULT_CONFIG };
  if ('network' in doc) {
    if (doc.network !== 'main' && doc.network !== 'test') {
      throw usageError(
        'invalid_config',
        `Config "network" must be "main" or "test" (got ${JSON.stringify(doc.network)}). Fix ${file}.`,
      );
    }
    cfg.network = doc.network;
  }
  if ('fee_rate_sats_per_kb' in doc)
    cfg.feeRateSatsPerKb = asNumber(doc.fee_rate_sats_per_kb, 'fee_rate_sats_per_kb');
  if ('poll_interval_secs' in doc) {
    cfg.pollIntervalSecs = Math.max(5, asNumber(doc.poll_interval_secs, 'poll_interval_secs'));
  }
  if ('spend_limit_sats' in doc)
    cfg.spendLimitSats = asNumber(doc.spend_limit_sats, 'spend_limit_sats');
  if ('fiat_display' in doc) {
    if (typeof doc.fiat_display !== 'boolean') {
      throw usageError(
        'invalid_config',
        `Config "fiat_display" must be true or false. Fix ${file}.`,
      );
    }
    cfg.fiatDisplay = doc.fiat_display;
  }
  return cfg;
}
