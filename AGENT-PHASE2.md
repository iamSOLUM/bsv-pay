# AGENT-PHASE2.md — bsv-pay: Agentic Payments

You are evolving bsv-pay from a human-facing CLI into **the safest payment tool an AI
agent can be trusted with on BSV**. The thesis: everyone lets agents pay; almost nobody
governs *how much, to whom, and how fast*. bsv-pay's differentiator is a policy engine
that sits below the agent, plus first-class MCP integration so any agent framework can
use it without ever touching a key.

Read CLAUDE.md first — its invariants override anything here. Work through milestones
in order; test + commit after each. Existing CLI behavior must not regress: the Phase 1
e2e loop (`npm run e2e:local`) must pass after every milestone.

## M8 — Core library extraction

Make the engine importable without breaking the CLI.

- Create `src/core/` exposing a programmatic API: `openWallet()`, `getBalance()`,
  `createRequest()`, `awaitPayment()`, `send()`, `getHistory()` — typed results,
  no `process.exit`, no console output; errors as typed exceptions carrying the
  same code numbers the CLI maps to exit codes.
- Commands in `src/commands/` become thin wrappers over core (parse args → core call
  → format). Behavior, flags, exit codes, and JSON shapes stay byte-compatible —
  prove it by keeping the entire existing test suite green untouched.
- Add a package subpath export (`bsv-pay/core`) rather than splitting packages now;
  note in DECISIONS.md that a monorepo split is deferred until there's a second consumer.

## M9 — Policy engine (the moat)

`~/.bsv-pay/policy.toml`, loaded by core, enforced in a single `authorizeSpend()` gate
that every spend path uses (CLI send, library send, future MCP + 402 client).

Policy capabilities:
- `per_tx_limit_sats` (subsumes existing spend limit; keep config fallback working)
- `daily_budget_sats` and `session_budget_sats` (rolling 24h from ledger; session = process lifetime)
- `rate_limit` (max payments per minute/hour)
- `allowlist` / `denylist` of recipient addresses (deny wins)
- `approval_threshold_sats`: above this, the spend is queued as `pending_approval`
  instead of sent; new CLI verbs `bsv-pay approvals list|approve <id>|reject <id>`
  (approval requires interactive passphrase — an agent with env passphrase cannot
  self-approve: use a separate approval secret or require TTY; decide and document)
- Every decision — allowed, denied, queued — appends a ledger entry with rule + reason.

CLI surface: `bsv-pay policy show` and `bsv-pay policy test <address> <amount>`
(dry-run a decision, exit 0/8). New exit code 9 = `pending_approval`.
Defaults when no policy.toml exists: current behavior exactly (per-tx limit only),
so nothing breaks for existing users.

## M10 — MCP server (`bsv-pay mcp`)

A stdio MCP server (official `@modelcontextprotocol/sdk`) exposing tools over core:

- `pay` (address, amount, memo?) → txid or structured policy denial
- `create_payment_request` (amount, memo?) → address + URI
- `await_payment` (address, timeout_s) → payment details or timeout
- `get_balance`, `get_history` (limit, filter)
- `get_policy_status` → remaining budgets, limits, pending approvals — so agents can
  plan within their allowance instead of discovering denials by failing

Requirements:
- Every `pay` goes through `authorizeSpend()`. Policy denials return structured,
  agent-readable results (`{ok:false, error:"daily_budget_exceeded", remaining_sats,...}`)
  — denials are results, not protocol errors, so agents can adapt.
- Tool descriptions written for LLM comprehension: state units (sats), irreversibility,
  and that budgets exist. Treat tool descriptions as prompt engineering.
- Keys, seeds, and passphrases never appear in any tool result or server log.
- Wallet unlock happens at server start (env passphrase or prompt), never via a tool.
- README section "Using bsv-pay with Claude Code": `claude mcp add bsv-pay -- bsv-pay mcp`,
  plus a worked example of a budget-governed session on testnet.
- Tests: spawn the MCP server against the local mock chain API; assert a `pay` over
  budget is denied with the right shape and a ledger entry exists.

## M11 — HTTP 402 flows (BRC-105)

Both sides of machine-to-machine payments:

- **Client**: `bsv-pay fetch <url>` — on a BRC-105 402 response (x-bsv-payment headers),
  build the payment within policy, retry with `x-bsv-payment`, return the resource.
  `--max-price <amount>` caps what a single fetch may pay regardless of policy headroom.
  Also exposed in core as `paidFetch()` and as an MCP tool `paid_fetch` (same policy gate).
  Study the BRC-105 spec (bitcoin-sv/BRCs payments/0105) and @bsv/sdk's AuthFetch before
  implementing; prefer SDK primitives over hand-rolling BRC-103/104 auth.
- **Server**: an importable Express middleware `requirePayment({priceSats})` (or adapt
  bsv-blockchain/payment-express-middleware if licensing and deps allow — evaluate and
  record the call in DECISIONS.md), plus `bsv-pay serve --price 50sats --port 8402`
  as a demo paywall server for testing and tutorials.
- e2e: a test where one bsv-pay instance runs `serve` and another `fetch`es it, paying
  automatically against the local mock chain.

## M12 — BRC-100 custody (complete the stub)

Replace the `init --brc100` error with a real connection via @bsv/sdk's wallet client
interface (BSV Desktop / Metanet Desktop expose it; wallet-toolbox documents it).

- Custody model: keys live in the external wallet; bsv-pay constructs actions and
  requests signatures. bsv-pay's policy engine still runs as a second layer in front.
- All commands and MCP tools work identically with either backend (local seed or
  BRC-100); the backend is a wallet-provider interface decision, invisible above core.
- If the external-wallet protocol proves unstable to integrate, ship behind
  `--experimental-brc100` with documented limitations rather than blocking the milestone.

## M13 — Prove it: the two-agent demo + docs

- `examples/two-agents/`: a data-seller agent (serves via 402 paywall) and a buyer agent
  (Claude or scripted) that discovers the price, checks `get_policy_status`, pays via MCP,
  and gets the data — runnable end-to-end against the local mock chain, no real coins.
- Docs: "Agentic payments with bsv-pay" guide covering the threat model (why policy
  lives below the agent), MCP setup for Claude Code/Desktop and Cursor, 402 quickstart,
  and BRC-100 custody. This guide is the launch artifact.
- Update README, bump to v0.2.0, CHANGELOG.

## Definition of done

An AI agent connected via MCP can: check its allowance, request and receive a payment,
pay a 402-protected endpoint, and be **stopped** — provably, with a ledger entry — when
it exceeds its budget, attempts a denylisted address, or fires too fast. A human can
review and approve queued large payments. All of it demonstrable on the local mock
chain with no real funds, and nothing from Phase 1 has regressed.