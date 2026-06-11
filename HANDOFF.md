# HANDOFF — bsv-pay Phase 2 (state as of 2026-06-11)

For a fresh session: read CLAUDE.md (invariants — they override everything), then
AGENT-PHASE2.md (roadmap M8–M13), DECISIONS.md, this file. Run the verification
suite once before touching code: `npm test && npm run lint && npm run format:check
&& npm run build && npm run e2e:local` — all green at handoff (187 unit tests / 22
files; e2e has 8 steps).

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

## Next action: M10 — MCP server (plan first, then a HARD checkpoint)

Protocol (from the owner's kickoff): write the implementation plan and WAIT for
approval before coding. After M10 ships: STOP — the owner personally connects the
server to Claude Code and runs a demo (check allowance → pay → get BLOCKED over
budget → approve the queued payment) before M11 may start.

M10 requirements (AGENT-PHASE2.md, plus repo-specific obligations):

- stdio MCP server (`bsv-pay mcp`) on the official `@modelcontextprotocol/sdk`
  (record the chosen SDK version in DECISIONS.md). Tools over core: `pay`,
  `create_payment_request`, `await_payment`, `get_balance`, `get_history`,
  `get_policy_status` (remaining budgets, limits, pending approvals).
- Every `pay` goes through `authorizeSpend()` — i.e. through core
  `planSend`/`executeSend`, never around them. **Obligation: add the MCP `pay`
  entry point as a row in the sweep in `test/policy-gate.test.ts`** (the test
  header demands it; M11 owes the same for `paidFetch`). The static choke-point
  scan will also fail any new file calling broadcast/signing/fetch directly —
  that is intended; route through core, don't extend the allowlists.
- Policy denials are structured RESULTS, not protocol errors
  (`{ok:false, error:"daily_budget_exceeded", remaining_sats, ...}`) — the engine
  already puts these fields on `CliError.data`; map them through.
- Keys/seeds/passphrases never in tool results or server logs (extend the
  key-boundary test pattern to MCP results). Wallet unlock happens at server
  start (env passphrase or prompt), never via a tool — this is the deployment
  story where the agent holds no secret at all.
- Tool descriptions are prompt engineering: state units (sats), irreversibility,
  and that budgets exist.
- Tests: spawn the real MCP server against the local mock chain (e2e-local
  pattern); assert an over-budget `pay` returns the structured denial AND a
  ledgered deny decision. README gets "Using bsv-pay with Claude Code"
  (`claude mcp add bsv-pay -- bsv-pay mcp`) + a worked budget-governed session.
- Exit codes, `--json` shapes, MCP tool schemas: additive-only (invariant 3).
  Manual testing on testnet/mock only — never mainnet.

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
