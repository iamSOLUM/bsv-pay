/**
 * bsv-pay/core — programmatic API over the same engine the CLI uses.
 *
 * Contract: typed results, typed errors (BsvPayError carries the same code
 * numbers the CLI maps to exit codes), no process.exit, no console output,
 * and no key material in any return value (invariant 1). This file is the
 * only supported import path; everything else under core/ is internal.
 */
export { CliError as BsvPayError, EXIT, type ExitCode } from '../errors.js';
export type { Network } from '../paths.js';
export type { Config } from '../config.js';
export type {
  ChainProvider,
  Utxo,
  AddressBalance,
  HistoryItem,
  BroadcastResult,
} from '../chain/provider.js';
export type { CoreOptions } from './context.js';
export { openWallet, CoreWallet, type OpenWalletOptions } from './wallet.js';
export { getBalance, type BalanceResult, type AddressBalanceResult } from './balance.js';
export {
  planSend,
  executeSend,
  send,
  explorerTxUrl,
  type SendParams,
  type SendPlan,
  type SendResult,
} from './send.js';
export { getHistory, type HistoryParams, type MoneyMovement } from './history.js';
export {
  createRequest,
  awaitPayment,
  buildPaymentUri,
  type RequestParams,
  type RequestResult,
  type AwaitPaymentParams,
  type PaymentResult,
} from './request.js';
export type { LedgerEntry } from '../ledger.js';
