import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ChainProvider } from '../chain/provider.js';
import type { Config } from '../config.js';
import { CliError, usageError } from '../errors.js';
import type { Network } from '../paths.js';
import { getBalance } from '../core/balance.js';
import { getHistory } from '../core/history.js';
import { getPolicyStatus } from '../core/policy-status.js';
import { createRequest, awaitPayment } from '../core/request.js';
import { send } from '../core/send.js';
import type { CoreWallet } from '../core/wallet.js';
import { paidFetch } from '../http402/client.js';
import type { Brc100Interface } from '../wallet/brc100.js';

/**
 * The bsv-pay MCP server: tools over the core library, nothing else. The
 * wallet is unlocked BEFORE this server is built (env passphrase or TTY
 * prompt at startup) and no tool can unlock, lock, or export anything —
 * the agent on the other end of the transport never holds a secret. All
 * spending goes through core, where the policy gate and the single-flight
 * spend lock live; this module cannot reach the network or a key directly.
 *
 * Results contract (stable, additive-only once shipped): every tool returns
 * structuredContent with `ok: true | false`. Expected failures — policy
 * denials, queued approvals, insufficient funds — are RESULTS with stable
 * snake_case `error` codes and the engine's data fields (remaining_sats,
 * approval_id, ...), never protocol errors, so an agent can read them and
 * adapt. Only unexpected exceptions surface as isError tool results.
 */

export interface McpServerOptions {
  network: Network;
  wallet: CoreWallet;
  config?: Partial<Config>;
  /** Tests inject a mock; production uses the default (WhatsOnChain). */
  provider?: ChainProvider;
  /** Tests inject a mock BRC-100 wallet app (used only under brc100 custody). */
  brc100?: Brc100Interface;
}

export const MCP_SERVER_VERSION = '0.1.0';

/** Fields shared by every tool result. */
const ENVELOPE = {
  ok: z.boolean().describe('True when the call succeeded; false carries error + message.'),
  code: z
    .number()
    .int()
    .optional()
    .describe('Stable bsv-pay error number (same meanings as the CLI exit codes).'),
  error: z
    .string()
    .optional()
    .describe('Stable snake_case error code, e.g. "daily_budget_exceeded".'),
  message: z.string().optional().describe('Human-readable explanation when ok is false.'),
};

/**
 * Detail fields the policy engine attaches to refusals/queues; flattened
 * into ok:false results so agents can plan (e.g. remaining_sats) without
 * parsing prose. All optional: which appear depends on the deciding rule.
 */
const POLICY_DETAIL_FIELDS = {
  rule: z
    .string()
    .optional()
    .describe('Policy rule that decided, e.g. "daily_budget_sats" or "denylist".'),
  address: z.string().optional(),
  amount_sats: z.number().int().optional(),
  limit_sats: z.number().int().optional(),
  budget_sats: z.number().int().optional(),
  spent_sats: z.number().int().optional(),
  remaining_sats: z
    .number()
    .int()
    .optional()
    .describe('Satoshis still spendable under the rule that refused this payment.'),
  threshold_sats: z.number().int().optional(),
  approval_id: z
    .string()
    .optional()
    .describe(
      'Present when queued: only a human can release it with "bsv-pay approvals approve <id>".',
    ),
  limit: z.number().int().optional().describe('Rate limit ceiling (payments per window).'),
  window: z.string().optional().describe('Rate limit window: "minute" or "hour".'),
  sent: z.number().int().optional().describe('Payments already made in that window.'),
};

function asResult(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * Run a tool body; map CliError (typed, stable-coded, key-free by
 * invariant 1) to a structured ok:false result. Anything else is a bug —
 * rethrow and let the SDK report it as a generic tool error.
 */
async function guard(
  fn: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return asResult({ ok: true, ...(await fn()) });
  } catch (e) {
    if (e instanceof CliError) {
      return asResult({
        ok: false,
        code: e.exitCode,
        error: e.errorCode,
        message: e.message,
        ...(e.data ?? {}),
      });
    }
    throw e;
  }
}

export function buildMcpServer(opts: McpServerOptions): McpServer {
  const core = {
    network: opts.network,
    config: opts.config,
    provider: opts.provider,
    brc100: opts.brc100,
  };
  const networkLabel = opts.network === 'test' ? 'BSV testnet' : 'BSV MAINNET (real money)';

  const server = new McpServer({ name: 'bsv-pay', version: MCP_SERVER_VERSION });

  server.registerTool(
    'get_balance',
    {
      title: 'Get wallet balance',
      description:
        `Check this wallet's balance on ${networkLabel}. All amounts are satoshis ` +
        '(1 BSV = 100,000,000 satoshis). Returns confirmed and unconfirmed totals ' +
        'across every address the wallet tracks. Note that spending is governed by ' +
        'a human-set policy, so the spendable amount may be lower than the balance — ' +
        'use get_policy_status to see the actual allowance.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
      outputSchema: {
        ...ENVELOPE,
        network: z.enum(['main', 'test']).optional(),
        confirmed_sats: z.number().int().optional(),
        unconfirmed_sats: z.number().int().optional(),
        total_sats: z.number().int().optional(),
        addresses_tracked: z.number().int().optional(),
      },
    },
    () =>
      guard(async () => {
        const balance = await getBalance(core);
        return {
          network: opts.network,
          confirmed_sats: balance.confirmedSats,
          unconfirmed_sats: balance.unconfirmedSats,
          total_sats: balance.confirmedSats + balance.unconfirmedSats,
          addresses_tracked: balance.addresses.length,
        };
      }),
  );

  server.registerTool(
    'get_history',
    {
      title: 'Get payment history',
      description:
        'List payments this wallet has sent and received, newest first, from the ' +
        'local append-only ledger (fast, offline, includes local-only memos). ' +
        'All amounts are satoshis.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Maximum entries to return (default 20).'),
        type: z
          .enum(['send', 'receive'])
          .optional()
          .describe('Only sends or only receives; default both.'),
      },
      outputSchema: {
        ...ENVELOPE,
        network: z.enum(['main', 'test']).optional(),
        count: z.number().int().optional(),
        payments: z
          .array(
            z.object({
              type: z.enum(['send', 'receive']),
              txid: z.string(),
              amount_sats: z.number().int(),
              address: z.string(),
              memo: z.string().optional(),
              timestamp: z.string(),
              status: z.enum(['pending', 'confirmed', 'unknown']),
              fee_sats: z.number().int().optional(),
              decision_id: z
                .string()
                .optional()
                .describe('Links a send to the policy decision that authorized it.'),
            }),
          )
          .optional(),
      },
    },
    (args: { limit?: number; type?: 'send' | 'receive' }) =>
      guard(() => {
        const payments = getHistory(core, { limit: args.limit ?? 20, type: args.type });
        return { network: opts.network, count: payments.length, payments };
      }),
  );

  server.registerTool(
    'get_policy_status',
    {
      title: 'Get spending policy status',
      description:
        'Check the human-set spending policy: per-transaction limits, remaining ' +
        'daily/session budgets, rate-limit headroom, allow/denylists, and payments ' +
        'queued for human approval. All amounts are satoshis. Call this BEFORE ' +
        'paying and plan within the remaining allowance — payments outside policy ' +
        'are refused, the policy cannot be changed or bypassed from this server, ' +
        'and BSV payments are irreversible once sent.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
      outputSchema: {
        ...ENVELOPE,
        network: z.enum(['main', 'test']).optional(),
        source: z
          .enum(['defaults', 'file'])
          .optional()
          .describe('"file" when ~/.bsv-pay/policy.toml governs; "defaults" otherwise.'),
        per_tx_limit_sats: z
          .number()
          .int()
          .optional()
          .describe('Hard cap per payment. Absent = no hard cap.'),
        soft_spend_limit_sats: z
          .number()
          .int()
          .optional()
          .describe('Legacy per-payment limit; payments at/above it are refused here.'),
        daily_budget_sats: z.number().int().optional(),
        daily_remaining_sats: z
          .number()
          .int()
          .optional()
          .describe('What may still be spent in the rolling 24h window.'),
        session_budget_sats: z.number().int().optional(),
        session_remaining_sats: z
          .number()
          .int()
          .optional()
          .describe('What may still be spent before this server restarts.'),
        rate_limit_per_minute: z.number().int().optional(),
        remaining_this_minute: z.number().int().optional(),
        rate_limit_per_hour: z.number().int().optional(),
        remaining_this_hour: z.number().int().optional(),
        approval_threshold_sats: z
          .number()
          .int()
          .optional()
          .describe('Payments at/above this queue for human approval instead of sending.'),
        approval_secret_configured: z.boolean().optional(),
        allowlist: z
          .array(z.string())
          .optional()
          .describe('When non-empty, ONLY these addresses may be paid.'),
        denylist: z.array(z.string()).optional().describe('These addresses are never paid.'),
        usage: z
          .object({
            daily_spent_sats: z.number().int(),
            session_spent_sats: z.number().int(),
            sends_last_minute: z.number().int(),
            sends_last_hour: z.number().int(),
          })
          .optional(),
        pending_approvals: z
          .array(
            z.object({
              approval_id: z.string(),
              address: z.string(),
              amount_sats: z.number().int(),
              memo: z.string().optional(),
              confirmed_only: z.boolean().optional(),
              queued_at: z.string(),
            }),
          )
          .optional()
          .describe('Queued payments only a human (with the approval secret) can release.'),
      },
    },
    () =>
      guard(() => {
        const status = getPolicyStatus(core);
        return {
          network: status.network,
          source: status.source,
          per_tx_limit_sats: status.perTxLimitSats,
          soft_spend_limit_sats: status.softPerTxLimitSats,
          daily_budget_sats: status.dailyBudgetSats,
          daily_remaining_sats: status.dailyRemainingSats,
          session_budget_sats: status.sessionBudgetSats,
          session_remaining_sats: status.sessionRemainingSats,
          rate_limit_per_minute: status.rateLimitPerMinute,
          remaining_this_minute: status.remainingThisMinute,
          rate_limit_per_hour: status.rateLimitPerHour,
          remaining_this_hour: status.remainingThisHour,
          approval_threshold_sats: status.approvalThresholdSats,
          approval_secret_configured: status.approvalSecretConfigured,
          allowlist: status.allowlist,
          denylist: status.denylist,
          usage: {
            daily_spent_sats: status.usage.dailySpentSats,
            session_spent_sats: status.usage.sessionSpentSats,
            sends_last_minute: status.usage.sendsLastMinute,
            sends_last_hour: status.usage.sendsLastHour,
          },
          pending_approvals: status.pendingApprovals.map((p) => ({
            approval_id: p.approvalId,
            address: p.address,
            amount_sats: p.amountSats,
            memo: p.memo,
            confirmed_only: p.confirmedOnly,
            queued_at: p.queuedAt,
          })),
        };
      }),
  );

  server.registerTool(
    'pay',
    {
      title: 'Send a payment',
      description:
        `Send satoshis to an address on ${networkLabel}. IRREVERSIBLE: a broadcast ` +
        'payment cannot be cancelled or refunded. Amounts are satoshis (1 BSV = ' +
        '100,000,000 satoshis). Every payment is checked against the human-set ' +
        'spending policy (per-payment limits, daily/session budgets, rate limits, ' +
        'allow/denylists). A refused payment returns ok:false with a stable error ' +
        'code and details such as remaining_sats — adapt to the policy (it cannot ' +
        'be changed or bypassed from this server) instead of retrying the same ' +
        'payment. A payment at/above the approval threshold is NOT sent: it returns ' +
        'ok:false with error "pending_approval" and an approval_id that only a ' +
        'human can release with "bsv-pay approvals approve <id>" — do not retry it, ' +
        'that would queue a duplicate. Use get_policy_status first to plan within ' +
        'the allowance.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        address: z.string().describe('Recipient BSV address (must match the active network).'),
        amount_sats: z
          .number()
          .int()
          .positive()
          .describe('Amount in satoshis. Bare integer; no BSV decimals.'),
        memo: z
          .string()
          .optional()
          .describe('Local-only note for the wallet ledger; never written on-chain.'),
      },
      outputSchema: {
        ...ENVELOPE,
        ...POLICY_DETAIL_FIELDS,
        network: z.enum(['main', 'test']).optional(),
        txid: z.string().optional().describe('Transaction id of the broadcast payment.'),
        fee_sats: z.number().int().optional(),
        change_sats: z.number().int().optional(),
        balance_after_sats: z.number().int().optional(),
        explorer_url: z.string().optional(),
      },
    },
    (args: { address: string; amount_sats: number; memo?: string }) =>
      guard(async () => {
        const result = await send(opts.wallet, core, {
          to: args.address,
          amountSats: args.amount_sats,
          memo: args.memo,
        });
        return {
          network: opts.network,
          txid: result.txid,
          address: result.to,
          amount_sats: result.amountSats,
          fee_sats: result.feeSats,
          change_sats: result.changeSats,
          balance_after_sats: result.balanceAfterSats,
          explorer_url: result.explorerUrl,
        };
      }),
  );

  server.registerTool(
    'paid_fetch',
    {
      title: 'Fetch a URL, paying if required',
      description:
        'Fetch an http(s) URL. Free resources cost nothing and return paid:false. ' +
        'If the server responds 402 Payment Required (BRC-105), this SPENDS ' +
        'satoshis from the wallet: the payment goes through the same human-set ' +
        'policy as pay (budgets, limits, lists — refusals are ok:false results ' +
        'with stable codes) and is IRREVERSIBLE once made. Set max_price_sats ' +
        'whenever you do not already know the price — it hard-caps this one ' +
        'fetch regardless of remaining budget. A payment the server then ' +
        'refuses to honor returns ok:false error "payment_not_redeemed" with ' +
        'the txid: the money moved; do not blindly retry, that would pay again.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().describe('http(s) URL to fetch.'),
        max_price_sats: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Refuse to pay more than this for the resource (satoshis).'),
        max_body_chars: z
          .number()
          .int()
          .min(1)
          .max(500_000)
          .optional()
          .describe('Truncate the returned body to this many characters (default 50,000).'),
      },
      outputSchema: {
        ...ENVELOPE,
        ...POLICY_DETAIL_FIELDS,
        network: z.enum(['main', 'test']).optional(),
        url: z.string().optional(),
        status: z.number().int().optional().describe('HTTP status of the final response.'),
        paid: z.boolean().optional(),
        content_type: z.string().optional(),
        body: z.string().optional(),
        body_truncated: z.boolean().optional(),
        txid: z.string().optional(),
        fee_sats: z.number().int().optional(),
        price_sats: z.number().int().optional(),
        max_price_sats: z.number().int().optional(),
      },
    },
    (args: { url: string; max_price_sats?: number; max_body_chars?: number }) =>
      guard(async () => {
        const result = await paidFetch(opts.wallet, core, {
          url: args.url,
          maxPriceSats: args.max_price_sats,
        });
        const cap = args.max_body_chars ?? 50_000;
        const truncated = result.body.length > cap;
        return {
          network: opts.network,
          url: args.url,
          status: result.status,
          paid: result.paid,
          content_type: result.contentType,
          body: truncated ? result.body.slice(0, cap) : result.body,
          body_truncated: truncated,
          ...(result.payment && {
            txid: result.payment.txid,
            amount_sats: result.payment.amountSats,
            fee_sats: result.payment.feeSats,
            address: result.payment.address,
          }),
        };
      }),
  );

  server.registerTool(
    'create_payment_request',
    {
      title: 'Create a payment request',
      description:
        'Request a payment INTO this wallet: issues a fresh receiving address and a ' +
        'BIP-21 payment URI to hand to the payer. Amounts are satoshis (1 BSV = ' +
        '100,000,000 satoshis). Costs nothing and is governed by no budget — only ' +
        'pay (outgoing) is policy-limited. Follow up with await_payment on the ' +
        'returned address to detect when it is paid.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        amount_sats: z
          .number()
          .int()
          .positive()
          .describe('Amount to request, in satoshis. Encoded in the returned URI.'),
        memo: z
          .string()
          .optional()
          .describe('Local-only request label; also set as the URI label for the payer.'),
      },
      outputSchema: {
        ...ENVELOPE,
        network: z.enum(['main', 'test']).optional(),
        address: z.string().optional().describe('Fresh address issued for exactly this request.'),
        amount_sats: z.number().int().optional(),
        memo: z.string().optional(),
        uri: z.string().optional().describe('BIP-21 payment URI (bitcoin:<address>?sv&amount=…).'),
      },
    },
    (args: { amount_sats: number; memo?: string }) =>
      guard(() => {
        const request = createRequest(opts.wallet, {
          amountSats: args.amount_sats,
          memo: args.memo,
        });
        return {
          network: request.network,
          address: request.address,
          amount_sats: request.amountSats,
          memo: request.memo,
          uri: request.uri,
        };
      }),
  );

  server.registerTool(
    'await_payment',
    {
      title: 'Wait for an incoming payment',
      description:
        'Wait for the first incoming payment on an address THIS wallet issued ' +
        '(create_payment_request first). Polls the chain until a payment is seen at ' +
        '0-conf, then records it in the ledger and returns it; amounts are ' +
        'satoshis. On timeout it returns ok:false with error "request_timeout" — ' +
        'the request stays valid and calling await_payment again is safe.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        address: z.string().describe('Address returned by create_payment_request.'),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe('Seconds to wait before giving up (default 120, max 600).'),
      },
      outputSchema: {
        ...ENVELOPE,
        network: z.enum(['main', 'test']).optional(),
        address: z.string().optional(),
        txid: z.string().optional(),
        amount_sats: z.number().int().optional().describe('Satoshis received.'),
        confirmed: z
          .boolean()
          .optional()
          .describe('False = seen at 0-conf (normal for fresh payments).'),
        timeout_ms: z.number().int().optional(),
      },
    },
    (args: { address: string; timeout_s?: number }) =>
      guard(async () => {
        if (!opts.wallet.addresses().includes(args.address)) {
          throw usageError(
            'unknown_address',
            `Address ${args.address} was not issued by this wallet. ` +
              'Use create_payment_request and await the address it returns.',
          );
        }
        const payment = await awaitPayment(core, {
          address: args.address,
          timeoutMs: (args.timeout_s ?? 120) * 1000,
        });
        return {
          network: opts.network,
          address: payment.address,
          txid: payment.txid,
          amount_sats: payment.receivedSats,
          confirmed: payment.confirmed,
        };
      }),
  );

  return server;
}
