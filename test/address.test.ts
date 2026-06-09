import { describe, expect, it } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { validateAddress } from '../src/address.js';
import { CliError, EXIT } from '../src/errors.js';

const key = PrivateKey.fromRandom();
const mainAddr = key.toAddress();
const testAddr = key.toAddress('testnet');

function errorCodeOf(fn: () => unknown): { exit?: number; code?: string } {
  try {
    fn();
    return {};
  } catch (e) {
    const err = e as CliError;
    return { exit: err.exitCode, code: err.errorCode };
  }
}

describe('validateAddress', () => {
  it('accepts a valid mainnet address on mainnet', () => {
    expect(() => validateAddress(mainAddr, 'main')).not.toThrow();
  });

  it('accepts a valid testnet address on testnet', () => {
    expect(() => validateAddress(testAddr, 'test')).not.toThrow();
  });

  it('rejects checksum typos with exit 2', () => {
    const typo = mainAddr.slice(0, -1) + (mainAddr.endsWith('x') ? 'y' : 'x');
    expect(errorCodeOf(() => validateAddress(typo, 'main'))).toEqual({
      exit: EXIT.USAGE,
      code: 'invalid_address',
    });
  });

  it('rejects garbage with exit 2', () => {
    expect(errorCodeOf(() => validateAddress('not-an-address', 'main')).exit).toBe(EXIT.USAGE);
    expect(errorCodeOf(() => validateAddress('', 'main')).exit).toBe(EXIT.USAGE);
  });

  it('rejects cross-network use with exit 2 and a helpful code', () => {
    expect(errorCodeOf(() => validateAddress(testAddr, 'main'))).toEqual({
      exit: EXIT.USAGE,
      code: 'wrong_network_address',
    });
    expect(errorCodeOf(() => validateAddress(mainAddr, 'test'))).toEqual({
      exit: EXIT.USAGE,
      code: 'wrong_network_address',
    });
  });
});
