import { HTTPWalletJSON, P2PKH, Transaction, WERR_INSUFFICIENT_FUNDS } from '@bsv/sdk';
import type {
  CreateActionArgs,
  CreateActionResult,
  ListOutputsArgs,
  ListOutputsResult,
} from '@bsv/sdk';
import { CliError, EXIT } from '../errors.js';
import type { Network } from '../paths.js';

/**
 * BRC-100 custody backend (EXPERIMENTAL — Phase 2 M12). Keys live in an
 * external wallet app (BSV Desktop / Metanet Desktop); bsv-pay constructs
 * actions and the external wallet funds, signs, and broadcasts them.
 *
 * The policy engine stays IN FRONT of external custody: the policy gate in
 * core decides and ledgers every spend BEFORE anything reaches this module
 * (invariant 2), exactly as for local-seed wallets. The connection handle
 * is key-capable by proxy — it can make the external wallet sign — so it
 * never crosses the core boundary (invariant 1 extended to wallet handles):
 * this module hands out txids, amounts, and addresses only.
 */

/** Default JSON-API endpoint exposed by BSV Desktop / Metanet Desktop. */
export const DEFAULT_BRC100_URL = 'http://localhost:3321';

/** Originator shown to the user by the wallet app when it asks permission. */
const ORIGINATOR = 'bsv-pay';

/**
 * The subset of the BRC-100 wallet interface bsv-pay uses (structural, so
 * tests and embedders can inject a mock). Matches @bsv/sdk WalletInterface.
 */
export interface Brc100Interface {
  getVersion(args: object): Promise<{ version: string }>;
  getNetwork(args: object): Promise<{ network: 'mainnet' | 'testnet' }>;
  waitForAuthentication(args: object): Promise<{ authenticated: true }>;
  getPublicKey(args: { identityKey: true }): Promise<{ publicKey: string }>;
  createAction(args: CreateActionArgs): Promise<CreateActionResult>;
  listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult>;
}

export interface ConnectBrc100Options {
  /** Wallet JSON-API URL; default BSV_PAY_BRC100_URL env, then localhost:3321. */
  url?: string;
  /** Inject a connected wallet interface (tests, library embedders). */
  wallet?: Brc100Interface;
}

export interface Brc100PayParams {
  to: string;
  amountSats: number;
  memo?: string;
}

export interface Brc100PayResult {
  txid: string;
  /** Empty string when the wallet returned a txid but no decodable tx. */
  rawTxHex: string;
  /** Exact fee decoded from the returned transaction; undefined if undecodable. */
  feeSats?: number;
  /** Satoshis the wallet routed back to itself (its own change). */
  changeSats: number;
  sizeBytes: number;
}

/**
 * Receive-side surfaces (request/watch/serve, MCP request tools) refuse
 * under BRC-100 custody: a payment address issued outside the wallet app
 * would be invisible to it — the funds would land somewhere the wallet
 * cannot see or spend. Receiving stays in the wallet app (documented
 * limitation of the experimental backend; see DECISIONS.md M12).
 */
export function brc100ReceiveNotSupported(): CliError {
  return new CliError(
    EXIT.USAGE,
    'brc100_receive_not_supported',
    'Receiving through bsv-pay is not supported with BRC-100 custody (experimental): an address ' +
      'issued by bsv-pay would be invisible to the wallet app and the funds unspendable from it. ' +
      "Use the wallet app's own receive screen, or a local-seed wallet for request/watch/serve.",
  );
}

function unreachable(url: string, cause: string): CliError {
  return new CliError(
    EXIT.WALLET_LOCKED,
    'brc100_unreachable',
    `No BRC-100 wallet answered at ${url} (${cause}). Start your wallet app ` +
      '(e.g. Metanet Desktop) and make sure its JSON-API is enabled, or set ' +
      'BSV_PAY_BRC100_URL if it listens elsewhere. Nothing was spent.',
    { url },
  );
}

/** Connection failures (TCP refused, DNS, timeout) — the request never landed. */
function isConnectionFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const text = `${e.message} ${e.cause instanceof Error ? e.cause.message : String(e.cause ?? '')}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout/i.test(text);
}

function truncateBytes(text: string, maxBytes: number): string {
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

/** BRC-100 action description: 5–50 bytes, shown in the wallet app's UI. */
function actionDescription(memo: string | undefined): string {
  return truncateBytes(`bsv-pay: ${memo ?? 'payment'}`, 50);
}

/**
 * An external BRC-100 wallet, connected and network-verified. Exposes only
 * public data (txids, satoshis, the identity public key); the underlying
 * interface stays module-private and is never returned by any method.
 */
export class Brc100Wallet {
  constructor(
    public readonly network: Network,
    private readonly iface: Brc100Interface,
    public readonly url: string,
  ) {}

  /** Block until the wallet app has authenticated this origin (may prompt). */
  async waitForAuthentication(): Promise<void> {
    try {
      await this.iface.waitForAuthentication({});
    } catch (e) {
      if (isConnectionFailure(e)) throw unreachable(this.url, 'connection lost');
      throw new CliError(
        EXIT.WALLET_LOCKED,
        'brc100_not_authenticated',
        `The wallet app did not authenticate bsv-pay: ${e instanceof Error ? e.message : String(e)}.`,
        { url: this.url },
      );
    }
  }

  /** The wallet's identity public key (public data, safe to display). */
  async identityKey(): Promise<string> {
    const { publicKey } = await this.iface.getPublicKey({ identityKey: true });
    return publicKey;
  }

  async version(): Promise<string> {
    const { version } = await this.iface.getVersion({});
    return version;
  }

  /** Spendable balance as the external wallet reports it (default basket). */
  async getBalanceSats(): Promise<number> {
    let total = 0;
    let offset = 0;
    for (;;) {
      let res: ListOutputsResult;
      try {
        res = await this.iface.listOutputs({ basket: 'default', limit: 10_000, offset });
      } catch (e) {
        if (isConnectionFailure(e)) throw unreachable(this.url, 'connection lost');
        throw new CliError(
          EXIT.NETWORK,
          'brc100_error',
          `The external wallet could not list its funds: ${e instanceof Error ? e.message : String(e)}.`,
          { url: this.url },
        );
      }
      for (const o of res.outputs) if (o.spendable) total += o.satoshis;
      offset += res.outputs.length;
      if (res.outputs.length === 0 || offset >= res.totalOutputs) return total;
    }
  }

  /**
   * Ask the external wallet to pay `amountSats` to a P2PKH address. The
   * wallet funds, signs, and broadcasts (acceptDelayedBroadcast: false, so
   * failures surface here, not in a background queue). Only called by core
   * executeSend AFTER the policy gate authorized this exact spend.
   *
   * Errors: exit 3 (wallet reports insufficient funds), exit 7 (wallet
   * unreachable — nothing spent), exit 6 (the wallet created the action but
   * its broadcast outcome is unknown; txid in data when available), exit 5
   * (the wallet refused — e.g. the human declined the prompt; nothing spent).
   */
  async payToAddress(params: Brc100PayParams): Promise<Brc100PayResult> {
    let result: CreateActionResult;
    try {
      result = await this.iface.createAction({
        description: actionDescription(params.memo),
        outputs: [
          {
            lockingScript: new P2PKH().lock(params.to).toHex(),
            satoshis: params.amountSats,
            outputDescription: 'bsv-pay payment',
          },
        ],
        labels: ['bsv-pay'],
        options: { acceptDelayedBroadcast: false },
      });
    } catch (e) {
      throw mapActionError(e, this.url);
    }

    if (!result.txid) {
      throw new CliError(
        EXIT.UNEXPECTED,
        'brc100_bad_result',
        'The external wallet returned no txid for the created action.',
      );
    }

    // Decode the returned AtomicBEEF for the exact fee/size/change. The
    // payment is already broadcast at this point, so decoding problems must
    // not throw the result away — degrade to txid-only.
    try {
      if (!result.tx) throw new Error('no tx in result');
      const tx = Transaction.fromAtomicBEEF(result.tx);
      const rawTxHex = tx.toHex();
      const recipientScript = new P2PKH().lock(params.to).toHex();
      let recipientSeen = false;
      let changeSats = 0;
      for (const out of tx.outputs) {
        const isRecipient =
          !recipientSeen &&
          out.satoshis === params.amountSats &&
          out.lockingScript.toHex() === recipientScript;
        if (isRecipient) recipientSeen = true;
        else changeSats += out.satoshis ?? 0;
      }
      return {
        txid: result.txid,
        rawTxHex,
        feeSats: tx.getFee(),
        changeSats,
        sizeBytes: rawTxHex.length / 2,
      };
    } catch {
      return { txid: result.txid, rawTxHex: '', feeSats: undefined, changeSats: 0, sizeBytes: 0 };
    }
  }
}

/** Map a createAction failure onto the stable exit-code families. */
function mapActionError(e: unknown, url: string): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof WERR_INSUFFICIENT_FUNDS) {
    return new CliError(
      EXIT.INSUFFICIENT_FUNDS,
      'insufficient_funds',
      `The external wallet reports insufficient funds: ${e.moreSatoshisNeeded} more satoshis needed. Fund the wallet or send less.`,
      { needed_sats: e.totalSatoshisNeeded, more_sats_needed: e.moreSatoshisNeeded },
    );
  }
  // WERR_REVIEW_ACTIONS (duck-typed: injected mocks may not share the class):
  // the wallet created the action but the broadcast outcome needs review —
  // the money may have moved. Conservative: status unknown, txid if present.
  if (e instanceof Error && 'reviewActionResults' in e) {
    const txid = (e as unknown as { txid?: string }).txid;
    return new CliError(
      EXIT.BROADCAST_UNKNOWN,
      'brc100_broadcast_unknown',
      `The external wallet created the payment but its broadcast outcome is unknown${txid ? ` (txid ${txid})` : ''}. ` +
        'Check the wallet app before retrying; the funds may already have moved.',
      txid ? { txid } : undefined,
    );
  }
  if (isConnectionFailure(e)) return unreachable(url, 'connection failed mid-request');
  return new CliError(
    EXIT.BROADCAST_REJECTED,
    'brc100_action_rejected',
    `The external wallet did not complete the payment: ${e instanceof Error ? e.message : String(e)}. ` +
      'If you declined the request in the wallet app, nothing was sent.',
  );
}

/**
 * Connect to the external BRC-100 wallet and verify it is on the expected
 * network (invariant 7: a testnet bsv-pay wallet refuses a mainnet wallet
 * app and vice versa). Throws exit 7 `brc100_unreachable` when no wallet
 * answers and exit 2 `brc100_network_mismatch` on a network mismatch.
 */
export async function connectBrc100(
  network: Network,
  opts: ConnectBrc100Options = {},
): Promise<Brc100Wallet> {
  const url = opts.url ?? process.env.BSV_PAY_BRC100_URL ?? DEFAULT_BRC100_URL;
  const iface = opts.wallet ?? (new HTTPWalletJSON(ORIGINATOR, url) as unknown as Brc100Interface);

  let walletNetwork: 'mainnet' | 'testnet';
  try {
    ({ network: walletNetwork } = await iface.getNetwork({}));
  } catch (e) {
    throw unreachable(url, e instanceof Error ? e.message : String(e));
  }

  const expected = network === 'test' ? 'testnet' : 'mainnet';
  if (walletNetwork !== expected) {
    throw new CliError(
      EXIT.USAGE,
      'brc100_network_mismatch',
      `The external wallet is on ${walletNetwork} but this bsv-pay wallet is ${expected}. ` +
        'Switch the wallet app to the matching network (state never mixes across networks).',
      { wallet_network: walletNetwork, expected_network: expected },
    );
  }
  return new Brc100Wallet(network, iface, url);
}
