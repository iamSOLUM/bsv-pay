# Changelog

All notable changes to bsv-pay. The project follows semver; exit codes,
`--json` shapes, and MCP tool schemas are stable contracts (additive-only).

## 0.2.0 — 2026-06-12 (Phase 2: agentic payments)

bsv-pay grows from a human-facing CLI into an agent payment toolkit: a
policy engine below every spend path, an MCP server so agents pay without
holding keys, HTTP 402 buying and selling, and experimental external
custody. Nothing from 0.1.0 regressed: existing commands, flags, exit
codes, and JSON shapes are byte-compatible.

### Added

- **`bsv-pay/core`** — the engine as an importable library: `openWallet`,
  `getBalance`, `send`/`planSend`/`executeSend`, `createRequest`,
  `awaitPayment`, `getHistory`, `getPolicyStatus`, `paidFetch`,
  `requirePayment`. Typed results, typed errors (`BsvPayError` carries the
  CLI's stable code numbers), no prompts, no console output, and never any
  key material in a return value.
- **Policy engine** (`~/.bsv-pay/policy.toml`): hard `per_tx_limit_sats`,
  `daily_budget_sats` (rolling 24h, recomputed from the ledger),
  `session_budget_sats`, rate limits per minute/hour, allow/denylists, and
  `approval_threshold_sats` queueing big payments for a human. One
  `authorizeSpend()` gate decides every spend from every surface; every
  decision (allow/deny/queue, rule + reason) is appended to the ledger.
  New commands: `bsv-pay policy show`, `bsv-pay policy test`.
- **Approvals**: `bsv-pay approvals list|approve|reject|set-secret` with a
  dedicated approval secret (argon2id-hashed, TTY-only, separate from and
  rejecting the wallet passphrase) — an agent cannot approve its own
  queued payment.
- **MCP server** (`bsv-pay mcp`): seven tools over stdio — `pay`,
  `paid_fetch`, `create_payment_request`, `await_payment`, `get_balance`,
  `get_history`, `get_policy_status`. The wallet unlocks once at startup;
  there is no unlock/approve/key tool. Policy refusals are structured
  `{ok:false, error, ...data}` results agents can read and adapt to.
  Concurrent payments are single-flighted in core so racing spends cannot
  overshoot a budget.
- **HTTP 402 (simplified BRC-105 profile)**: `bsv-pay fetch <url>
  [--max-price]` pays paywalls within policy; `bsv-pay serve --price` and
  the zero-dependency Express-compatible `requirePayment()` middleware
  sell behind them. New exit code 10 `payment_not_redeemed` (paid but the
  server refused the content; txid in the error).
- **BRC-100 external custody (EXPERIMENTAL)**: `bsv-pay init
  --experimental-brc100` delegates signing to a desktop wallet app
  (Metanet/BSV Desktop JSON-API). The policy gate decides before the
  wallet app is ever asked. Spending, balance, history, policy, and
  approvals work; receive-side commands refuse by design
  (`brc100_receive_not_supported`). **Status, plainly: protocol-tested
  against a mock wallet (unit + e2e), not yet verified against a real
  wallet app** — it stays behind the experimental flag until that pass
  happens (docs/BRC100.md).
- **Two-agent demo** (`npm run demo:two-agents`): a seller paywall and an
  MCP-only buyer agent on a local mock chain — price discovery, governed
  purchases, a prompt-injection payment blocked by the denylist, a budget
  stop, and the printed audit trail.
- **Docs**: [Agentic payments with bsv-pay](docs/AGENTIC-PAYMENTS.md) (the
  guide), [docs/BRC100.md](docs/BRC100.md) (custody setup + verification).
- New exit codes 9 (`pending_approval`) and 10 (`payment_not_redeemed`);
  additive `--json` fields (`backend`, `fee_estimated`, policy detail
  fields on refusals).

### Notes

- Full BRC-105 interop with external services (the SDK's AuthFetch,
  BRC-103/104 mutual auth) is deferred with recorded reasoning — see
  DECISIONS.md M12 and the README's "Compatibility, honestly".
- Session budgets are per-process by definition; daily budgets are
  recomputed from the append-only ledger and survive restarts.

## 0.1.0 — 2026-06-10 (Phase 1: the CLI MVP)

Initial release: `init` (create/import, argon2id + AES-256-GCM encrypted
seed, BIP-44 derivation), `balance`, `send` (UTXO selection, fee
estimation, dry runs, spend-limit confirmation), `request` (fresh address,
BIP-21 URI, QR, `--wait`), `watch`, `donate`; WhatsOnChain provider with
testnet/mainnet state separation; append-only JSONL ledger; stable exit
codes 0–8; `--json` everywhere; local mock-chain e2e harness.
