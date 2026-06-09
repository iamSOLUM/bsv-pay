import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/wallet/crypto.js';
import { CliError, EXIT } from '../src/errors.js';

describe('wallet crypto', () => {
  it('round-trips a secret with the right passphrase', () => {
    const { kdf, cipher } = encryptSecret('top secret seed', 'hunter2');
    expect(decryptSecret(kdf, cipher, 'hunter2')).toBe('top secret seed');
  });

  it('rejects a wrong passphrase with exit 7', () => {
    const { kdf, cipher } = encryptSecret('top secret seed', 'hunter2');
    try {
      decryptSecret(kdf, cipher, 'hunter3');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(EXIT.WALLET_LOCKED);
      expect((e as CliError).errorCode).toBe('bad_passphrase');
    }
  });

  it('rejects tampered ciphertext with exit 7', () => {
    const { kdf, cipher } = encryptSecret('top secret seed', 'hunter2');
    const tampered = {
      ...cipher,
      ciphertext: cipher.ciphertext.slice(0, -2) + (cipher.ciphertext.endsWith('00') ? '11' : '00'),
    };
    try {
      decryptSecret(kdf, tampered, 'hunter2');
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.WALLET_LOCKED);
    }
  });

  it('does not store the plaintext or passphrase in the blob', () => {
    const { kdf, cipher } = encryptSecret('correct horse battery staple', 'hunter2');
    const json = JSON.stringify({ kdf, cipher });
    expect(json).not.toContain('correct horse');
    expect(json).not.toContain('hunter2');
  });
});
