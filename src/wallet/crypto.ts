import crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2';
import { CliError, EXIT } from '../errors.js';

export interface KdfParams {
  algo: 'argon2id';
  salt: string; // hex
  t: number; // iterations
  m: number; // memory in KiB
  p: number; // parallelism
}

export interface CipherBlob {
  algo: 'aes-256-gcm';
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
}

/**
 * OWASP-recommended argon2id configuration (19 MiB, t=2, p=1). Parameters are
 * stored alongside the wallet so they can be raised later without breaking
 * existing wallets.
 */
export const DEFAULT_KDF: Pick<KdfParams, 't' | 'm' | 'p'> = { t: 2, m: 19_456, p: 1 };

function deriveKey(passphrase: string, params: KdfParams): Buffer {
  const pass = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const salt = Buffer.from(params.salt, 'hex');
  return Buffer.from(argon2id(pass, salt, { t: params.t, m: params.m, p: params.p, dkLen: 32 }));
}

export function encryptSecret(
  plaintext: string,
  passphrase: string,
): { kdf: KdfParams; cipher: CipherBlob } {
  const kdf: KdfParams = {
    algo: 'argon2id',
    salt: crypto.randomBytes(16).toString('hex'),
    ...DEFAULT_KDF,
  };
  const key = deriveKey(passphrase, kdf);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return {
    kdf,
    cipher: {
      algo: 'aes-256-gcm',
      iv: iv.toString('hex'),
      tag: c.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    },
  };
}

/** Throws exit 7 (wallet locked) when the passphrase is wrong. */
export function decryptSecret(kdf: KdfParams, cipher: CipherBlob, passphrase: string): string {
  const key = deriveKey(passphrase, kdf);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.iv, 'hex'));
    d.setAuthTag(Buffer.from(cipher.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(cipher.ciphertext, 'hex')), d.final()]).toString(
      'utf8',
    );
  } catch {
    throw new CliError(
      EXIT.WALLET_LOCKED,
      'bad_passphrase',
      'Wrong passphrase. Try again, or set BSV_PAY_PASSPHRASE for scripted use.',
    );
  }
}
