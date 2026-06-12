# HANDOFF — bsv-pay Phase 2 (state as of 2026-06-12, post-M11)

For a fresh session: read CLAUDE.md (invariants — they override everything), then
AGENT-PHASE2.md (roadmap M8–M13), DECISIONS.md, this file. Run the verification
suite once before touching code: `npm test && npm run lint && npm run format:check
&& npm run build && npm run e2e:local` — all green at handoff (236 unit tests / 28
files; e2e has 10 steps).

## Done and owner-approved

- **M8 — core library** (`bsv-pay/core` subpath export; commands are thin wrappers;
  key boundary = CoreWallet + private WeakMap in `src/core/internal.ts`, proven
  executable by `test/core-key-boundary.test.ts` incl. its leak-detector meta-test).
- **M9 — policy engine**, design walkthrough approved by the owner on 2026-06-11
  after running `test/policy-gate.test.ts`, `test/approvals.test.ts`,
  `test/policy-defaults.test.ts`, `test/policy-engine.test.ts`, and e2e locally.
  - Single gate: `authorizeSpend()` in `src/policy/engine.ts`, called by `planSend`;
    `executeSend` only accepts registry-authorized plans (one authorization = one
    broadcast). Every decision (allow/deny/queue, rule + reason) is ledgered.
  - `policy.toml`: hard `per_tx_limit_sats`, daily/session budgets (recomputed from
    the ledger), rate limits, allow/denylist, `approval_threshold_sats` → exit 9.
    No policy.toml = pre-policy behavior byte-for-byte (`test/policy-defaults.test.ts`).
  - Approvals: `bsv-pay approvals list|approve|reject|set-secret`; the approval
    secret is a second secret (argon2id hash only, TTY-only prompts, no env/flag
    path, wallet passphrase rejected, fail-closed). Self-approval attack is tested.
- **M10 — MCP server**, hard checkpoint CLEARED by the owner on 2026-06-12 (they
  connected it to Claude Code and ran the budget demo personally: allowance →
  pay → blocked over budget → "ignore your budget" refused → approval via the
  secret → balance reconciled). `bsv-pay mcp` on `@modelcontextprotocol/sdk`
  1.29.0; tools over core; structured `{ok:false, code, error, ...data}`
  results; no unlock/approve/secret tool (asserted by test); unlock once at
  startup. Owner requirement from plan approval: concurrent pays cannot race
  budgets → `core/spend-lock.ts` single-flights decide→broadcast→ledger,
  proven by `test/spend-concurrency.test.ts` + the MCP racing-pays test.
  `scripts/demo-chain.mjs` (`npm run demo:chain`) is a standalone mock chain
  with a faucet for interactive demos — public testnet faucets are dead.
- **M11 — HTTP 402 (BRC-105 simplified profile)**, built 2026-06-12. Researched
  first: full BRC-105 needs BRC-103/104 mutual auth + BRC-29/AtomicBEEF, which
  need BRC-100 custody — that is M12; the SDK's AuthFetch becomes usable then.
  Shipped now (rationale + divergences in DECISIONS.md M11):
  - `src/http402/`: protocol (BRC-105 headers, `x-bsv-payment-address`
    extension, raw-hex envelope), client (`paidFetch` — pays via core `send()`,
    `maxPriceSats` pre-gate cap, exit 10 `payment_not_redeemed` carries the
    txid), middleware (`requirePayment` — Express-compatible, zero deps, fresh
    address + single-use TTL'd nonce per quote, confirms on its own chain view
    via `awaitPayment` which ledgers the receive; buyer broadcasts, seller
    never signs/broadcasts/fetches).
  - Surfaces: `bsv-pay fetch <url> [--max-price]` (body = stdout, payment =
    stderr), `bsv-pay serve --price --port --host --body`, MCP `paid_fetch`
    (max_price_sats + max_body_chars), `paidFetch`/`requirePayment` exported
    from `bsv-pay/core`.
  - Obligations met: core `paidFetch` AND MCP `paid_fetch` are sweep rows in
    `test/policy-gate.test.ts`; the scan's only allowlist change is `fetch(` in
    `http402/client.ts`; key-boundary proofs (core + MCP) cover paid/refused/
    capped paths incl. `SendResult.rawTxHex` (new, additive, public data).
  - e2e step [10/10]: real `bsv-pay serve` (own wallet + state dir) sells to
    the buyer's real `bsv-pay fetch` over the mock chain — paid fetch, seller
    balance/ledger, max-price cap, and the third fetch blocked by the daily
    budget.

## Next action: M12 — BRC-100 custody (no hard checkpoint gate)

Replace the `init --brc100` stub (exit 2 `brc100_not_supported`,
`src/wallet/brc100.ts`) with a real connection via @bsv/sdk's wallet client
interface (BSV Desktop / Metanet Desktop expose it; wallet-toolbox documents
it). Requirements from AGENT-PHASE2.md:

- Custody model: keys live in the external wallet; bsv-pay constructs actions
  and requests signatures. The policy engine still runs as a second layer in
  front — invariant 2 applies unchanged.
- All commands and MCP tools work identically with either backend; the backend
  is a wallet-provider decision invisible above core.
- If the external-wallet protocol proves unstable, ship behind
  `--experimental-brc100` with documented limitations rather than blocking.
- M12 is also the moment to revisit full BRC-105 compliance: with a BRC-100
  wallet, the 402 client can switch to the SDK's AuthFetch (BRC-29 derivation,
  AtomicBEEF, mutual auth) for external services. Keep our simplified-profile
  serve/fetch working for local-seed wallets.
- Hard checkpoints existed after M9 and M10 only — but M12 touches custody, so
  keep diffs small/isolated for human review, and testnet/mock only as always.

## In-flight notes

- **Unreproduced flake**: exactly one unit test failed once on 2026-06-11 (1 of 9
  full/stress runs; name lost to output truncation). Never reproduced locally,
  including 5 stress runs of the timing-sensitive files (watch, request,
  core-request, approvals, policy-load). If CI ever shows a flaky test, that's
  the lead — chase it with full logs before anything else.
- Phase 1 e2e loop is the regression canary; never weaken or skip existing tests.
- Session budgets are in-memory per process — relevant to the MCP server design
  (a server restart resets session, never daily, budgets).
- `planApprovedSend` (core/send.ts) and the prompt-injection seams in
  `src/commands/approvals.ts` are deliberately NOT exported from `bsv-pay/core`;
  keep it that way when wiring MCP.
- Versioning: still 0.1.0 — the bump to 0.2.0 + CHANGELOG is an M13 deliverable.
  npm publish naming (decided earlier, not yet executed): `bsv-pay-cli` with
  `bsvpay` alias; binary stays `bsv-pay`.
