import { loadConfig, type Config } from './config.js';
import { Output } from './output.js';
import type { Network } from './paths.js';

export interface Ctx {
  out: Output;
  json: boolean;
  network: Network;
  config: Config;
}

export function buildCtx(opts: { json?: boolean; testnet?: boolean }): Ctx {
  const config = loadConfig();
  const network: Network = opts.testnet ? 'test' : config.network;
  return {
    out: new Output(Boolean(opts.json)),
    json: Boolean(opts.json),
    network,
    config,
  };
}
