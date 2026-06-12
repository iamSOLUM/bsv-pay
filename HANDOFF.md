# HANDOFF — bsv-pay Phase 2 (state as of 2026-06-12: v0.2.0 PUBLISHED — Phase 2 closed)

For a fresh session: read CLAUDE.md (invariants — they override everything), then
AGENT-PHASE2.md (roadmap M8–M13), DECISIONS.md, this file. Run the verification
suite once before touching code: `npm test && npm run lint && npm run format:check
&& npm run build && npm run e2e:local` — all green at handoff (262 unit tests / 29
files; e2e has 11 steps).

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
- **M11 — HTTP 402 (BRC-105 simplified profile)**, built 2026-06-12 and the
  design call **RATIFIED by the owner on 2026-06-12**: the simplified profile
  is approved; the README's interop caveat ("Compatibility, honestly") stays
  prominent until M12 closes it. Researched first: full BRC-105 needs
  BRC-103/104 mutual auth + BRC-29/AtomicBEEF, which need BRC-100 custody —
  that is M12; the SDK's AuthFetch becomes usable then.
  Shipped (rationale + divergences in DECISIONS.md M11):
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

## M12 — BRC-100 custody: RATIFIED by the owner 2026-06-12

The owner ratified the build including the AuthFetch deferral and the
receive-side refusal under custody, and verified e2e step [11/11] green on
their machine.

**KNOWN IOU — the real-app custody pass is still owed.** The docs/BRC100.md
walkthrough against actual external wallet software is deferred: public
testnet faucets are currently broken (verified personally by the owner on
2026-06-12), so a real wallet app cannot be funded. Standing consequences:

1. BRC-100 mode must NOT be promoted out of `--experimental` until a human
   has completed the real-app verification loop in docs/BRC100.md.
2. Launch docs (the agentic-payments guide, README, CHANGELOG) must state
   plainly that custody mode is experimental and protocol-tested against a
   mock, pending real-app verification.

Built per the owner's standing instructions, all three honored:

1. **Policy in front of external custody — done and proven.** The backend
   union (`local | brc100`) lives behind the same module-private WeakMap as
   the signing wallet; `planSend` authorizes before knowing which backend
   pays, `executeSend` consumes the authorization before branching, and the
   external wallet is reachable only via `Brc100Wallet.payToAddress` from
   `executeSend`. The choke-point scan gained rules for `createAction`/
   `payToAddress`; the sweep gained a cross-checking mock wallet app that
   refuses unledgered actions; `test/brc100.test.ts` proves denials/queues
   never reach the wallet app and that its key never crosses the boundary.
2. **Noob-proof owner guide: `docs/BRC100.md`** — install (Metanet Desktop),
   testnet switch, connect, and a 6-step verification loop with expected
   exit codes, plus a zero-install path (e2e step [11/11] runs the whole
   custody loop against a mock desktop wallet: `npm run e2e:local`).
3. **The experimental escape hatch was used**: `init --experimental-brc100`
   works; plain `--brc100` still exits 2 pointing at it. Documented
   limitation (README support matrix + DECISIONS M12): receive-side
   surfaces (`request`/`watch`/`serve`/`requirePayment`/MCP request tools)
   refuse with exit 2 `brc100_receive_not_supported` — an address issued by
   bsv-pay would be invisible to the wallet app, stranding funds. Spending
   (send/donate/fetch/MCP pay/paid_fetch), balance (via the app's
   listOutputs), history, policy, and approvals all work.

Other M12 facts a next session needs:
- Errors map onto stable families: 3 insufficient (app verdict), 5
  `brc100_action_rejected` (human declined in the app, nothing spent), 6
  `brc100_broadcast_unknown` (ledgered `unknown`, counts against session
  budget), 7 `brc100_unreachable`, 2 `brc100_network_mismatch` (invariant 7).
- Exact fee/size/change decode from the app's AtomicBEEF; degrade to
  txid-only rather than lose a broadcast payment. Dry runs never contact
  the app (estimated fee, `fee_estimated: true`, empty txid).
- **Full BRC-105 via AuthFetch: revisited and DEFERRED** (DECISIONS M12,
  bottom bullet): no server-side BRC-103/104 exists in our dependency set
  to test against, and gating AuthFetch needs a second spend door with
  identity-key recipients that bypass address-based lists. The README
  interop caveat was narrowed (custody half closed), not removed. Clean
  future milestone once a testable BRC-104 counterparty exists.
- Connection: SDK `HTTPWalletJSON`, default `http://localhost:3321`,
  `BSV_PAY_BRC100_URL` override, originator `bsv-pay`. Injection seam for
  tests/embedders: `CoreOptions.brc100` (mirrors `provider`).
- The owner has NOT yet run the manual external-wallet loop; the mock-based
  proofs are green. Offer the docs/BRC100.md walkthrough before M13 ships.

## M13 — DONE. The owner cleared the checkpoint and `bsv-pay-cli@0.2.0` IS PUBLISHED (2026-06-12).

Publish facts a next session needs:

- **Install: `npm i -g bsv-pay-cli` — the single canonical name.** The
  planned `bsvpay` alias package was REJECTED by the registry (403: name
  too similar to the existing `bsv-pay` package) and the owner dropped it
  entirely — packages/bsvpay is deleted, install docs mention only
  bsv-pay-cli. The `bsvpay` *bin* alias inside the published package
  stays (shipped in 0.2.0; command names aren't registry names), as does
  the `./cli` subpath export. Decision + reasoning in DECISIONS.md M13.
- The publish ran from the owner's terminal (npm 2FA/OTP); prepublishOnly
  gated it behind the full test suite + build. The published tarball is
  byte-identical to the PII-audited artifact (shasum e511e8af…).
- Git: main pushed, tag `v0.2.0` pushed. A pre-publish PII sweep of both
  artifacts and the full git history came back clean (no machine paths,
  usernames, hostnames, emails, or secrets in any blob ever; .mcp.json
  was never committed). Known-public identity: the GitHub handle in
  LICENSE/package.json/FUNDING.yml, the proton.me commit email (intrinsic
  to git, owner accepted), and the mainnet donation address (deliberate).

What M13 delivered:

- **Two-agent demo**: `npm run demo:two-agents` (examples/two-agents/) — a
  real `bsv-pay serve` seller and an MCP-only scripted buyer on the mock
  chain: free price discovery, two governed buys, a prompt-injection
  payment blocked by the denylist, the daily-budget stop, the printed
  ledger. The orchestrator asserts every beat (doubles as a smoke test;
  not in CI by decision). README shows the Claude Code swap-in.
- **Launch guide**: docs/AGENTIC-PAYMENTS.md — threat model, MCP setup
  (Claude Code/Desktop, Cursor), 402 quickstart, BRC-100 custody **with
  the owner-required disclaimer** (experimental, mock-tested, pending
  real-app verification), and the map of executable proofs.
- **v0.2.0**: package.json + `cli --version` + MCP_SERVER_VERSION;
  CHANGELOG.md covers 0.1.0 and 0.2.0 (M8–M12, custody disclaimer included).
- **Publishing setup**: package `bsv-pay-cli` (bins `bsv-pay` + `bsvpay`),
  `files` ships dist/ + docs/ + CHANGELOG, `prepublishOnly` runs the full
  test suite + build so nothing publishes from a red tree.

**Post-launch standing items:**
1. The BRC-100 real-app IOU above still gates any promotion of
   `--experimental-brc100` (not a 0.2.0 blocker — the docs disclaim it).
2. If a future release ever revisits an alias name, read DECISIONS.md M13
   first: npm's similarity check killed `bsvpay`, and the owner's call was
   one canonical name, not a third attempt.

## Next: Phase 3 — identity-key payments (scoped 2026-06-13)

A community proposal for identity-key receive (BRC-29 derivation, peer
artifacts, `internalizeAction`) was assessed and owner-ratified as the
Phase 3 thesis. Roadmap: **AGENT-PHASE3.md** (M14 bsv-pay↔bsv-pay rail,
M15 external interop behind the real-app gate, M16 promotion checkpoint).
Contributor rules: **CONTRIBUTING.md** (new). Key standing rule recorded
in DECISIONS.md Phase 3: defaults flip by explicit opt-in and
human-verified promotion only — never environment detection. Design
discussion happens in the contributor's issue BEFORE code; the
identity-key policy-list semantics decision is mandatory pre-code.

## In-flight notes

- **Unreproduced flake**: exactly one unit test failed once on 2026-06-11 (1 of 9
  full/stress runs; name lost to output truncation). Never reproduced locally,
  including 5 stress runs of the timing-sensitive files (watch, request,
  core-request, approvals, policy-load). If CI ever shows a flaky test, that's
  the lead — chase it with full logs before anything else. (The SEPARATE e2e
  step-7 flake found post-publish was diagnosed and fixed — a harness race,
  see DECISIONS.md M13; no evidence links the two.)
- Phase 1 e2e loop is the regression canary; never weaken or skip existing tests.
- Session budgets are in-memory per process — relevant to the MCP server design
  (a server restart resets session, never daily, budgets).
- `planApprovedSend` (core/send.ts) and the prompt-injection seams in
  `src/commands/approvals.ts` are deliberately NOT exported from `bsv-pay/core`;
  keep it that way when wiring MCP.
- Versioning: 0.2.0 everywhere (package.json, CLI `--version`,
  MCP_SERVER_VERSION) — published to npm as `bsv-pay-cli`; binaries
  `bsv-pay` and `bsvpay`. No alias package exists (DECISIONS M13).
