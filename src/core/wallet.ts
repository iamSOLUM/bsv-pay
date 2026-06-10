import { CliError, EXIT } from '../errors.js';
import type { Network } from '../paths.js';
import { Wallet } from '../wallet/wallet.js';
import type { CoreOptions } from './context.js';
import { registerWallet, unwrapWallet } from './internal.js';

export interface OpenWalletOptions extends CoreOptions {
  /** Passphrase or async supplier; default: BSV_PAY_PASSPHRASE env. Never prompts. */
  passphrase?: string | (() => Promise<string>);
  /** Receives human warnings (e.g. unencrypted wallet); default: collected on `warnings`. */
  onWarning?: (text: string) => void;
}

/**
 * An open wallet as seen through the library boundary: addresses and
 * metadata only. Signing keys stay inside src/wallet/ (invariant 1) —
 * core modules reach the signing wallet through a private registry that
 * is not exported from the public entrypoint, never through any member
 * of this class.
 */
export class CoreWallet {
  constructor(
    public readonly network: Network,
    /** False for single-address WIF wallets. */
    public readonly isHd: boolean,
    /** Warnings raised during unlock when no onWarning sink was supplied. */
    public readonly warnings: readonly string[],
  ) {}

  /** Every address this wallet has issued (receive + change chains). */
  addresses(): string[] {
    return unwrapWallet(this)
      .trackedAddresses()
      .map((a) => a.address);
  }
}

/**
 * Unlock a wallet for library use. Unlike the CLI, this never prompts and
 * never writes to stdout/stderr: the passphrase comes from the explicit
 * option or BSV_PAY_PASSPHRASE; an encrypted wallet with neither throws
 * code 7 (`passphrase_required`). A missing wallet file throws code 2
 * (`no_wallet`).
 */
export async function openWallet(opts: OpenWalletOptions): Promise<CoreWallet> {
  const warnings: string[] = [];
  const onWarning = opts.onWarning ?? ((text: string) => warnings.push(text));

  // Only consulted for encrypted wallets, so unencrypted wallets open
  // without any passphrase — same as the CLI.
  const passphrase =
    opts.passphrase ??
    process.env.BSV_PAY_PASSPHRASE ??
    (() => {
      throw new CliError(
        EXIT.WALLET_LOCKED,
        'passphrase_required',
        'Wallet is encrypted. Pass `passphrase` to openWallet() or set BSV_PAY_PASSPHRASE.',
      );
    });

  const wallet = await Wallet.unlock(opts.network, { passphrase, onWarning });
  const pub = new CoreWallet(opts.network, wallet.isHd, warnings);
  registerWallet(pub, wallet);
  return pub;
}
