import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { argon2id } from '@noble/hashes/argon2';
import { CliError, EXIT, usageError } from '../errors.js';
import { appendLedger, readLedger } from '../ledger.js';
import { approvalSecretPath, type Network } from '../paths.js';
import { DEFAULT_KDF } from '../wallet/crypto.js';

/**
 * The human approval gate. The approval secret is SEPARATE from the wallet
 * passphrase by design: BSV_PAY_PASSPHRASE may live in an agent's
 * environment, so it must never be able to approve a queued payment. Only
 * an argon2id hash of the secret is stored; there is no env var, no flag,
 * and no non-interactive path that supplies it — the CLI reads it from a
 * hidden TTY prompt or not at all.
 */

interface SecretFile {
  algo: 'argon2id';
  salt: string; // hex
  t: number;
  m: number;
  p: number;
  hash: string; // hex
}

function hashSecret(
  secret: string,
  saltHex: string,
  params: { t: number; m: number; p: number },
): Buffer {
  const pass = new TextEncoder().encode(secret.normalize('NFKD'));
  const salt = Buffer.from(saltHex, 'hex');
  return Buffer.from(argon2id(pass, salt, { ...params, dkLen: 32 }));
}

export function approvalSecretConfigured(): boolean {
  return fs.existsSync(approvalSecretPath());
}

/** Store the argon2id hash of a new approval secret (never the secret). */
export function storeApprovalSecret(secret: string): void {
  const file: SecretFile = {
    algo: 'argon2id',
    salt: crypto.randomBytes(16).toString('hex'),
    ...DEFAULT_KDF,
    hash: '',
  };
  file.hash = hashSecret(secret, file.salt, file).toString('hex');
  fs.mkdirSync(path.dirname(approvalSecretPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(approvalSecretPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

export function verifyApprovalSecret(secret: string): boolean {
  if (!approvalSecretConfigured()) return false;
  let file: SecretFile;
  try {
    file = JSON.parse(fs.readFileSync(approvalSecretPath(), 'utf8')) as SecretFile;
  } catch {
    return false;
  }
  const expected = Buffer.from(file.hash, 'hex');
  const actual = hashSecret(secret, file.salt, file);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export interface PendingApproval {
  approvalId: string;
  address: string;
  amountSats: number;
  memo?: string;
  confirmedOnly?: boolean;
  queuedAt: string;
}

/**
 * Pending approvals are a fold over the append-only ledger: queue decisions
 * minus resolutions. No second mutable state file to tamper with.
 */
export function listPendingApprovals(network: Network): PendingApproval[] {
  const resolved = new Set<string>();
  const queued: PendingApproval[] = [];
  for (const entry of readLedger(network)) {
    if (entry.type === 'approval_resolved') resolved.add(entry.approval_id);
    if (entry.type === 'policy_decision' && entry.decision === 'queue' && entry.approval_id) {
      queued.push({
        approvalId: entry.approval_id,
        address: entry.address,
        amountSats: entry.amount_sats,
        memo: entry.memo,
        confirmedOnly: entry.confirmed_only,
        queuedAt: entry.timestamp,
      });
    }
  }
  return queued.filter((q) => !resolved.has(q.approvalId));
}

/** Find a pending approval by full id or unambiguous prefix. */
export function findPendingApproval(network: Network, id: string): PendingApproval {
  const pending = listPendingApprovals(network);
  const matches = pending.filter((p) => p.approvalId === id || p.approvalId.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw usageError(
      'ambiguous_approval',
      `Approval id "${id}" matches ${matches.length} pending approvals. Use more characters.`,
    );
  }
  throw usageError(
    'unknown_approval',
    `No pending approval matches "${id}". Run "bsv-pay approvals list".`,
  );
}

export function resolveApproval(
  network: Network,
  approvalId: string,
  resolution: 'approved' | 'rejected',
  txid?: string,
): void {
  appendLedger(network, {
    type: 'approval_resolved',
    approval_id: approvalId,
    resolution,
    timestamp: new Date().toISOString(),
    txid,
  });
}

/** Thrown when the typed approval secret is wrong. Exit 7 (auth failure). */
export function badApprovalSecret(): CliError {
  return new CliError(
    EXIT.WALLET_LOCKED,
    'bad_approval_secret',
    'Wrong approval secret. The wallet passphrase is NOT accepted here; the approval secret is the one set via "bsv-pay approvals set-secret".',
  );
}
