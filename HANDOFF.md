# HANDOFF — bsv-pay Phase 2 (state as of 2026-06-11, post-M10 build)

For a fresh session: read CLAUDE.md (invariants — they override everything), then
AGENT-PHASE2.md (roadmap M8–M13), DECISIONS.md, this file. Run the verification
suite once before touching code: `npm test && npm run lint && npm run format:check
&& npm run build && npm run e2e:local` — all green at handoff (215 unit tests / 26
files; e2e has 9 steps).

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
- Judgment calls are all recorded in DECISIONS.md (M8 and M9 sections).

## Next action: the M10 HARD checkpoint — owner demo, then M11

M10 is built, tested, and committed. Per the kickoff protocol the next step is
NOT M11: the owner personally connects the server to Claude Code and runs the
demo — check allowance → pay → get BLOCKED over budget → approve the queued
payment — before M11 may start. Suggested demo setup (testnet/mock only):
`claude mcp add bsv-pay --env BSV_PAY_PASSPHRASE=… -- bsv-pay mcp --testnet`,
with a small `policy.toml` (see the README's "Using bsv-pay with Claude Code").

What shipped (all obligations met; details in DECISIONS.md M10):

- `bsv-pay mcp` — stdio server on `@modelcontextprotocol/sdk` 1.29.0. Six tools
  over core: `pay`, `create_payment_request`, `await_payment`, `get_balance`,
  `get_history`, `get_policy_status`. No unlock/approve/secret/key tool exists
  (asserted by test); unlock happens once at startup (env passphrase or TTY).
- Every `pay` goes through core `send()` → the policy gate. The MCP entry point
  is a row in the `test/policy-gate.test.ts` sweep (M11 still owes `paidFetch`).
- **Owner requirement (added at plan approval): concurrent pays cannot race the
  budget.** `core/spend-lock.ts` single-flights decide→broadcast→ledger per
  state dir + network; `test/spend-concurrency.test.ts` (core) and the racing-
  pays test in `test/mcp-server.test.ts` (MCP) prove ledgered spend never
  exceeds the budget.
- Denials/queues are structured results: `{ok:false, code, error, message,
  ...data}` (`remaining_sats`, `approval_id`, …); `isError` only for bugs.
- `test/mcp-key-boundary.test.ts` sweeps full wire-level results for every
  secret representation (incl. approval-secret hash + salt).
- e2e step [9/9] spawns the real binary over stdio and replays the checkpoint
  demo loop. README has "Using bsv-pay with Claude Code" + the worked session.

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
