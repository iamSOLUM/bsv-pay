import type { ChainProvider } from '../chain/provider.js';
import { WhatsOnChainProvider } from '../chain/whatsonchain.js';
import { loadConfig, type Config } from '../config.js';
import type { Network } from '../paths.js';
import type { Brc100Interface } from '../wallet/brc100.js';

/**
 * Options every core function accepts. Config is loaded from
 * ~/.bsv-pay/config.toml (like the CLI) and merged with any overrides, so
 * library and CLI behavior stay consistent. The provider defaults to
 * WhatsOnChain; tests and the local e2e mock inject their own.
 */
export interface CoreOptions {
  network: Network;
  config?: Partial<Config>;
  provider?: ChainProvider;
  /**
   * Inject a connected BRC-100 wallet interface (tests, embedders). Used
   * only when the wallet file delegates to BRC-100 custody; the default is
   * an HTTP connection to the wallet app recorded at init.
   */
  brc100?: Brc100Interface;
}

export interface ResolvedCore {
  network: Network;
  config: Config;
  provider: ChainProvider;
}

export function resolveCore(opts: CoreOptions): ResolvedCore {
  return {
    network: opts.network,
    config: { ...loadConfig(), ...opts.config },
    provider: opts.provider ?? new WhatsOnChainProvider(opts.network),
  };
}
