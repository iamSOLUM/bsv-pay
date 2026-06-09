import { Utils } from '@bsv/sdk';
import { usageError } from './errors.js';
import type { Network } from './paths.js';

const MAINNET_P2PKH_PREFIX = 0x00;
const TESTNET_P2PKH_PREFIX = 0x6f;

/**
 * Validate a P2PKH address checksum and network prefix BEFORE any network
 * call (invariant 4). Throws exit 2 on failure.
 */
export function validateAddress(address: string, network: Network): void {
  let prefix: number[];
  let data: number[];
  try {
    const decoded = Utils.fromBase58Check(address);
    prefix = decoded.prefix as number[];
    data = decoded.data as number[];
  } catch {
    throw usageError(
      'invalid_address',
      `"${address}" is not a valid BSV address (base58check checksum failed). Check for typos.`,
    );
  }
  if (data.length !== 20 || prefix.length !== 1) {
    throw usageError(
      'invalid_address',
      `"${address}" is not a P2PKH address. Only standard P2PKH addresses are supported.`,
    );
  }
  const expected = network === 'test' ? TESTNET_P2PKH_PREFIX : MAINNET_P2PKH_PREFIX;
  if (prefix[0] !== expected) {
    const wrongNet =
      prefix[0] === MAINNET_P2PKH_PREFIX
        ? 'mainnet'
        : prefix[0] === TESTNET_P2PKH_PREFIX
          ? 'testnet'
          : 'an unknown network';
    throw usageError(
      'wrong_network_address',
      `"${address}" is ${wrongNet === 'an unknown network' ? 'for' : 'a'} ${wrongNet} address but you are on ${network === 'test' ? 'testnet' : 'mainnet'}. ` +
        (network === 'test'
          ? 'Drop --testnet or use a testnet address.'
          : 'Pass --testnet or use a mainnet address.'),
    );
  }
}
