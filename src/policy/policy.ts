import fs from 'node:fs';
import { Utils } from '@bsv/sdk';
import { parse as parseToml } from 'smol-toml';
import type { Config } from '../config.js';
import { usageError } from '../errors.js';
import { baseDir, policyPath, type Network } from '../paths.js';

/**
 * The active spend policy. With no policy.toml, `source` is "defaults" and
 * the ONLY rule is the legacy soft per-tx limit from config.spendLimitSats
 * (confirmable interactively / --allow-large) — current behavior exactly.
 * When policy.toml exists, per_tx_limit_sats (if set) is a HARD limit no
 * flag can cross; the soft limit applies only when the file omits it.
 */
export interface Policy {
  source: 'defaults' | 'file';
  /** Hard per-transaction cap (policy.toml). No override exists. */
  perTxLimitSats?: number;
  /** Legacy confirmable limit from config.toml (pre-policy behavior). */
  softPerTxLimitSats?: number;
  /** Rolling 24h spend cap, computed from the ledger at decision time. */
  dailyBudgetSats?: number;
  /** Per-process spend cap (meaningful for long-running consumers). */
  sessionBudgetSats?: number;
  rateLimitPerMinute?: number;
  rateLimitPerHour?: number;
  /** At/above this, spends queue for human approval instead of sending. */
  approvalThresholdSats?: number;
  /** When non-empty, only these recipients are allowed. */
  allowlist: string[];
  /** Always wins over everything else. */
  denylist: string[];
}

const RULE_KEYS = [
  'per_tx_limit_sats',
  'daily_budget_sats',
  'session_budget_sats',
  'rate_limit_per_minute',
  'rate_limit_per_hour',
  'approval_threshold_sats',
  'allowlist',
  'denylist',
] as const;

function invalidPolicy(message: string): never {
  throw usageError('invalid_policy', `${message} Fix ${policyPath()}.`);
}

function asSats(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidPolicy(`Policy key "${key}" must be a non-negative integer of satoshis.`);
  }
  return value;
}

function asAddressList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    invalidPolicy(`Policy key "${key}" must be an array of address strings.`);
  }
  const list = value as string[];
  for (const address of list) {
    try {
      Utils.fromBase58Check(address);
    } catch {
      // A typo'd denylist entry would silently never match — fail loudly instead.
      invalidPolicy(`Policy ${key} entry "${address}" is not a valid address (checksum failed).`);
    }
  }
  return list;
}

function rejectUnknownKeys(doc: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) {
      // An ignored typo like "daily_budget_stas" would mean NO budget — unsafe.
      invalidPolicy(`Unknown policy key "${key}".`);
    }
  }
}

function applyRules(policy: Policy, doc: Record<string, unknown>): void {
  if ('per_tx_limit_sats' in doc)
    policy.perTxLimitSats = asSats(doc.per_tx_limit_sats, 'per_tx_limit_sats');
  if ('daily_budget_sats' in doc)
    policy.dailyBudgetSats = asSats(doc.daily_budget_sats, 'daily_budget_sats');
  if ('session_budget_sats' in doc)
    policy.sessionBudgetSats = asSats(doc.session_budget_sats, 'session_budget_sats');
  if ('rate_limit_per_minute' in doc)
    policy.rateLimitPerMinute = asSats(doc.rate_limit_per_minute, 'rate_limit_per_minute');
  if ('rate_limit_per_hour' in doc)
    policy.rateLimitPerHour = asSats(doc.rate_limit_per_hour, 'rate_limit_per_hour');
  if ('approval_threshold_sats' in doc)
    policy.approvalThresholdSats = asSats(doc.approval_threshold_sats, 'approval_threshold_sats');
  if ('allowlist' in doc) policy.allowlist = asAddressList(doc.allowlist, 'allowlist');
  if ('denylist' in doc) policy.denylist = asAddressList(doc.denylist, 'denylist');
}

/**
 * Cached per process (key: state dir + network): limits change only when a
 * human edits policy.toml AND the process restarts (invariant 2) — a
 * long-running MCP server does not pick up live edits.
 */
const cache = new Map<string, Policy>();

export function resetPolicyCacheForTests(): void {
  cache.clear();
}

export function loadPolicy(network: Network, config: Config): Policy {
  const cacheKey = `${baseDir()}::${network}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const file = policyPath();
  let policy: Policy;
  if (!fs.existsSync(file)) {
    policy = {
      source: 'defaults',
      softPerTxLimitSats: config.spendLimitSats,
      allowlist: [],
      denylist: [],
    };
  } else {
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      invalidPolicy(`Cannot parse policy.toml: ${e instanceof Error ? e.message : String(e)}.`);
    }
    rejectUnknownKeys(doc, [...RULE_KEYS, 'network']);
    policy = { source: 'file', allowlist: [], denylist: [] };
    applyRules(policy, doc);

    // Optional [network.main] / [network.test] override tables.
    if ('network' in doc) {
      const networks = doc.network;
      if (typeof networks !== 'object' || networks === null || Array.isArray(networks)) {
        invalidPolicy('Policy [network] must be a table of per-network overrides.');
      }
      rejectUnknownKeys(networks as Record<string, unknown>, ['main', 'test']);
      const override = (networks as Record<string, unknown>)[network];
      if (override !== undefined) {
        if (typeof override !== 'object' || override === null || Array.isArray(override)) {
          invalidPolicy(`Policy [network.${network}] must be a table.`);
        }
        rejectUnknownKeys(override as Record<string, unknown>, RULE_KEYS);
        applyRules(policy, override as Record<string, unknown>);
      }
    }

    // Keep the legacy config limit working when the file doesn't set a hard one.
    if (policy.perTxLimitSats === undefined) {
      policy.softPerTxLimitSats = config.spendLimitSats;
    }
  }
  cache.set(cacheKey, policy);
  return policy;
}
