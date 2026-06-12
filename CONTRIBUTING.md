# Contributing to bsv-pay

Thanks for wanting to help. bsv-pay moves real money for people who trust
it not to surprise them, so this project runs on a small number of hard
rules. They are short, they are checked by CI, and they are not
negotiable in a PR — but everything else is open for discussion.

## Read these first

1. **CLAUDE.md** — the seven invariants. They override everything,
   including this file. The two that bite contributors most often:
   keys never cross a boundary (no key material in logs, errors, results,
   or the ledger — ever), and **every spend path goes through the single
   policy gate in core** (no flag, parameter, or tool argument may cross
   a `policy.toml` rule).
2. **DECISIONS.md** — the running log of every judgment call since M1.
   If you're about to change behavior, the reasoning for the current
   behavior is probably in there. Read the entries for the area you're
   touching before proposing a change to it.
3. **PRD.md / AGENT-PHASE2.md / AGENT-PHASE3.md** — what's in scope and
   what was deliberately left out.

## The decision log

Any judgment call you make in a PR — a trade-off, a deviation, a deferral
— gets **appended to DECISIONS.md in the same PR**, with the reasoning.
Entries are append-only: never rewrite or delete history there. If your
PR contains no new decisions, say so in the description; reviewers check.

## Tests are contracts

- **Never weaken, skip, or delete an existing test** to make a change
  pass. If a test blocks you, the test is usually enforcing a recorded
  decision — argue with the decision (in an issue), not the test.
- **The policy-gate suite (`test/policy-gate.test.ts`) is the spine.**
  Its static scan allowlists every "door money can leave through"
  (broadcast, signing, `createAction`/`internalizeAction`, raw HTTP) to
  specific files — a new spend path **fails CI by existing**, which is
  the test working. If your feature genuinely needs a new door:
  extending the allowlist is a conscious, reviewed act, and the new
  entry point also needs a **sweep row** (the cross-checking mock that
  refuses any broadcast/action lacking a prior ledgered allow decision)
  plus runtime forgery coverage.
- **Key-boundary suites** (`test/core-key-boundary.test.ts`,
  `test/mcp-key-boundary.test.ts`, `test/brc100.test.ts`): any new
  result, error, or surface that could carry data gets serialized and
  scanned for key material. Extend them when you add surface.
- New features need unit tests against mock providers (no live network
  in CI), and anything touching the payment loop extends
  `scripts/e2e-local.mjs` (`npm run e2e:local`).

## Stable contracts (additive-only)

Exit codes 0–10 keep their documented meanings — new codes append, never
repurpose. `--json` output shapes only gain fields. MCP tool schemas only
gain optional fields. Ledger entry types only gain variants. Bare amounts
are satoshis, and ambiguity is an error, never a guess.

## Security-sensitive code: `src/wallet/`, `src/policy/`, spend paths

- **Small, isolated commits** — one concern per commit, no drive-by
  refactors riding along. These commits get line-by-line human review.
- New cryptography (key derivation, encryption) lives inside
  `src/wallet/` only, behind the existing boundary.
- Test against **testnet or the local mock chain only**. Never develop
  or verify against mainnet funds.
- Every money movement and every policy decision must land in the
  append-only ledger. No code path gets to skip the audit trail.

## Experimental flags and promotion

Risky or partially-verified surfaces ship behind explicit
`--experimental-*` flags with their limitations documented (see
`--experimental-brc100` and DECISIONS.md M12 for the pattern). Promotion
out of experimental — and any change of defaults — happens **only by
explicit opt-in and human-verified evidence, never by environment
detection**. "It works against our mock" is grounds for shipping behind
a flag; a human completing the documented real-software verification
loop is grounds for promotion. Don't write code that silently changes
behavior because it detected something installed on the machine.

## Workflow

```bash
npm ci
npm test && npm run lint && npm run format:check && npm run build && npm run e2e:local
```

All green before you push; CI runs the same suite on every PR. Two
mechanical rules with history behind them (DECISIONS.md M13): any
`package.json` edit is followed by `npm install` in the same commit so
the lockfile stays in sync, and commit messages explain *why*, not just
what.

## Before you write code

For anything touching the spend or receive paths, **open an issue and
discuss the design first** — these areas are dense with recorded
decisions, and a half-hour of issue discussion routinely saves a
rewritten PR. Small fixes (docs, error messages, test coverage) can go
straight to PR.
