import fs from 'node:fs';
import path from 'node:path';
import { HD, Mnemonic, PrivateKey } from '@bsv/sdk';
import { CliError, EXIT } from '../errors.js';
import { appendLedger } from '../ledger.js';
import { walletPath, type Network } from '../paths.js';
import { askHidden, isInteractive } from '../prompt.js';
import { decryptSecret, encryptSecret, type CipherBlob, type KdfParams } from './crypto.js';

export interface SecretPayload {
  type: 'mnemonic' | 'wif';
  value: string;
}

export interface WalletFile {
  version: 1;
  network: Network;
  encrypted: boolean;
  /** Present only when encrypted === false (explicit opt-in at init). */
  secret?: SecretPayload;
  kdf?: KdfParams;
  cipher?: CipherBlob;
  next_receive_index: number;
  next_change_index: number;
  created_at: string;
}

/** BIP-44, BSV coin type 236. chain 0 = receive, 1 = change. */
const DERIVATION_BASE = "m/44'/236'/0'";

export function walletExists(network: Network): boolean {
  return fs.existsSync(walletPath(network));
}

export function readWalletFile(network: Network): WalletFile {
  const file = walletPath(network);
  if (!fs.existsSync(file)) {
    throw new CliError(
      EXIT.USAGE,
      'no_wallet',
      `No ${network === 'test' ? 'testnet ' : ''}wallet found. Run "bsv-pay init${network === 'test' ? ' --testnet' : ''}" first.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WalletFile;
  } catch {
    throw new CliError(
      EXIT.UNEXPECTED,
      'corrupt_wallet',
      `Wallet file ${file} is not valid JSON. Restore it from backup or re-run init --force.`,
    );
  }
}

export function writeWalletFile(network: Network, wallet: WalletFile): void {
  const file = walletPath(network);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(wallet, null, 2) + '\n', { mode: 0o600 });
}

export function buildWalletFile(
  network: Network,
  secret: SecretPayload,
  passphrase: string | null,
): WalletFile {
  const base = {
    version: 1 as const,
    network,
    next_receive_index: 0,
    next_change_index: 0,
    created_at: new Date().toISOString(),
  };
  if (passphrase === null) {
    return { ...base, encrypted: false, secret };
  }
  const { kdf, cipher } = encryptSecret(JSON.stringify(secret), passphrase);
  return { ...base, encrypted: true, kdf, cipher };
}

export const UNENCRYPTED_WALLET_WARNING =
  'WARNING: this wallet stores its seed UNENCRYPTED on disk. Anyone who can read\n' +
  '~/.bsv-pay can spend your funds. Re-run "bsv-pay init --force" to encrypt.';

/**
 * How unlock obtains the passphrase and reports warnings. Defaults preserve
 * CLI behavior (env var, then interactive prompt; warnings to stderr); the
 * core library passes explicit values so it never prompts or prints.
 */
export interface UnlockOptions {
  /** Passphrase or async supplier; default: BSV_PAY_PASSPHRASE env, then interactive prompt. */
  passphrase?: string | (() => Promise<string>);
  /** Sink for human warnings (e.g. unencrypted wallet); default: stderr. */
  onWarning?: (text: string) => void;
}

/** Resolve the passphrase: env var for scripts, otherwise interactive prompt. */
async function obtainPassphrase(supplied?: string | (() => Promise<string>)): Promise<string> {
  if (typeof supplied === 'string') return supplied;
  if (typeof supplied === 'function') return supplied();
  const env = process.env.BSV_PAY_PASSPHRASE;
  if (env !== undefined) return env;
  if (!isInteractive()) {
    throw new CliError(
      EXIT.WALLET_LOCKED,
      'passphrase_required',
      'Wallet is encrypted and no terminal is available to prompt. Set BSV_PAY_PASSPHRASE for scripted use.',
    );
  }
  return askHidden('Wallet passphrase: ');
}

export interface TrackedAddress {
  address: string;
  chain: 0 | 1; // 0 receive, 1 change
  index: number;
}

/** An unlocked wallet: can derive addresses and signing keys. */
export class Wallet {
  private constructor(
    public readonly network: Network,
    private file: WalletFile,
    private readonly secret: SecretPayload,
    private readonly hd: HD | null,
  ) {}

  static async unlock(network: Network, options: UnlockOptions = {}): Promise<Wallet> {
    const file = readWalletFile(network);
    const warn = options.onWarning ?? ((text: string) => process.stderr.write(text + '\n'));
    let secret: SecretPayload;
    if (file.encrypted) {
      if (!file.kdf || !file.cipher) {
        throw new CliError(
          EXIT.UNEXPECTED,
          'corrupt_wallet',
          'Wallet file is marked encrypted but has no cipher data.',
        );
      }
      const passphrase = await obtainPassphrase(options.passphrase);
      secret = JSON.parse(decryptSecret(file.kdf, file.cipher, passphrase)) as SecretPayload;
    } else {
      warn(UNENCRYPTED_WALLET_WARNING);
      if (!file.secret) {
        throw new CliError(EXIT.UNEXPECTED, 'corrupt_wallet', 'Wallet file has no secret payload.');
      }
      secret = file.secret;
    }
    const hd =
      secret.type === 'mnemonic'
        ? HD.fromSeed(Mnemonic.fromString(secret.value).toSeed()).derive(DERIVATION_BASE)
        : null;
    return new Wallet(network, file, secret, hd);
  }

  /**
   * Read-only view (no passphrase needed): tracked addresses can be derived
   * only for unencrypted wallets; encrypted wallets still require unlock, so
   * commands that just need addresses use the ledger instead. Kept private —
   * commands should use Wallet.unlock or the ledger.
   */

  get isHd(): boolean {
    return this.hd !== null;
  }

  keyAt(chain: 0 | 1, index: number): PrivateKey {
    if (this.hd) return this.hd.derive(`m/${chain}/${index}`).privKey;
    return PrivateKey.fromWif(this.secret.value);
  }

  addressAt(chain: 0 | 1, index: number): string {
    const priv = this.keyAt(chain, index);
    return this.network === 'test' ? priv.toAddress('testnet') : priv.toAddress();
  }

  /** Every address this wallet has ever issued (receive + change chains). */
  trackedAddresses(): TrackedAddress[] {
    if (!this.isHd) return [{ address: this.addressAt(0, 0), chain: 0, index: 0 }];
    const list: TrackedAddress[] = [];
    // index 0 is always tracked, even before the first explicit issue
    const receiveCount = Math.max(1, this.file.next_receive_index);
    for (let i = 0; i < receiveCount; i++) {
      list.push({ address: this.addressAt(0, i), chain: 0, index: i });
    }
    for (let i = 0; i < this.file.next_change_index; i++) {
      list.push({ address: this.addressAt(1, i), chain: 1, index: i });
    }
    return list;
  }

  privKeyForAddress(address: string): PrivateKey | undefined {
    const hit = this.trackedAddresses().find((a) => a.address === address);
    return hit ? this.keyAt(hit.chain, hit.index) : undefined;
  }

  /** Next address for a purpose WITHOUT persisting anything (dry runs). */
  peekAddress(purpose: 'receive' | 'change'): { address: string; index: number } {
    if (!this.isHd) return { address: this.addressAt(0, 0), index: 0 };
    const chain = purpose === 'change' ? 1 : 0;
    const index = chain === 0 ? this.file.next_receive_index : this.file.next_change_index;
    return { address: this.addressAt(chain, index), index };
  }

  /** Derive a fresh address, persist the counter, and record it in the ledger. */
  issueAddress(
    purpose: 'receive' | 'change' | 'request',
    memo?: string,
  ): { address: string; index: number } {
    if (!this.isHd) {
      // WIF wallets have a single address; "issuing" returns it without counters.
      return { address: this.addressAt(0, 0), index: 0 };
    }
    const chain = purpose === 'change' ? 1 : 0;
    const index = chain === 0 ? this.file.next_receive_index : this.file.next_change_index;
    const address = this.addressAt(chain, index);
    if (chain === 0) this.file.next_receive_index = index + 1;
    else this.file.next_change_index = index + 1;
    writeWalletFile(this.network, this.file);
    appendLedger(this.network, {
      type: 'address_issued',
      address,
      derivation_index: index,
      purpose,
      memo,
      timestamp: new Date().toISOString(),
    });
    return { address, index };
  }
}
