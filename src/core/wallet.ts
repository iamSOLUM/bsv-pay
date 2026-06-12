import { CliError, EXIT } from '../errors.js';
import type { Network } from '../paths.js';
import { connectBrc100, type Brc100Interface } from '../wallet/brc100.js';
import { readWalletFile, Wallet } from '../wallet/wallet.js';
import type { CoreOptions } from './context.js';
import { registerWallet, unwrapBackend, unwrapWallet } from './internal.js';

export interface OpenWalletOptions extends CoreOptions {
  /** Passphrase or async supplier; default: BSV_PAY_PASSPHRASE env. Never prompts. */
  passphrase?: string | (() => Promise<string>);
  /** Receives human warnings (e.g. unencrypted wallet); default: collected on `warnings`. */
  onWarning?: (text: string) => void;
}

/** Which custody backend an open wallet delegates to. */
export type WalletBackendKind = 'local' | 'brc100';

/**
 * An open wallet as seen through the library boundary: addresses and
 * metadata only. Signing keys (and, for BRC-100 custody, the external
 * wallet handle — key-capable by proxy) stay inside src/wallet/
 * (invariant 1) — core modules reach the signing backend through a private
 * registry that is not exported from the public entrypoint, never through
 * any member of this class.
 */
export class CoreWallet {
  constructor(
    public readonly network: Network,
    /** False for single-address WIF wallets. */
    public readonly isHd: boolean,
    /** Warnings raised during unlock when no onWarning sink was supplied. */
    public readonly warnings: readonly string[],
    /** Custody backend (additive, M12): local seed or external BRC-100 wallet. */
    public readonly backend: WalletBackendKind = 'local',
  ) {}

  /**
   * Every address this wallet has issued (receive + change chains). A
   * BRC-100 wallet manages its own addresses internally: empty array.
   */
  addresses(): string[] {
    if (unwrapBackend(this).kind === 'brc100') return [];
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
 *
 * When the wallet file delegates to BRC-100 custody (EXPERIMENTAL), this
 * connects to the external wallet app instead — no passphrase involved;
 * an unreachable wallet app throws code 7 (`brc100_unreachable`).
 */
export async function openWallet(opts: OpenWalletOptions): Promise<CoreWallet> {
  const file = readWalletFile(opts.network);

  if (file.backend === 'brc100') {
    const brc100 = await connectBrc100(opts.network, {
      url: file.brc100_url,
      wallet: opts.brc100,
    });
    const pub = new CoreWallet(opts.network, true, [], 'brc100');
    registerWallet(pub, { kind: 'brc100', wallet: brc100 });
    return pub;
  }

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
  const pub = new CoreWallet(opts.network, wallet.isHd, warnings, 'local');
  registerWallet(pub, { kind: 'local', wallet });
  return pub;
}

// Re-exported type so OpenWalletOptions/CoreOptions stay self-contained.
export type { Brc100Interface };
