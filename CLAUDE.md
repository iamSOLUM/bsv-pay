# CLAUDE.md — bsv-pay

bsv-pay is a developer-first CLI (and now agent payment toolkit) for BSV micropayments.
Phase 1 (CLI MVP) is complete and working. Phase 2 turns it into the safest, most
agent-friendly payment tool on BSV. Read PRD.md and DECISIONS.md before large changes;
append to DECISIONS.md whenever you make a judgment call.

## Architecture (do not casually restructure)

- `src/cli.ts` — Commander wiring only; no business logic
- `src/commands/` — one file per command, thin: parse → call core → format output
- `src/wallet/` — encryption (argon2id + AES-256-GCM), BIP-44 derivation, key handling
- `src/ledger.ts` — append-only JSONL: every send, receive, issued address, and (Phase 2) every policy decision
- `src/chain/` — `ChainProvider` interface + WhatsOnChain impl; all network I/O goes through this
- `src/tx.ts` — UTXO selection, fees, build/sign via @bsv/sdk
- Phase 2 additions: `src/core/` (programmatic API), `src/policy/` (policy engine), `src/mcp/` (MCP server), `src/http402/` (BRC-105 client/middleware)

## Invariants — never break these

1. **Keys never cross a boundary.** Not in logs, errors, ledger, `--json`, MCP tool results, library return values, or exception messages. Signing happens inside `wallet/`; everything else handles addresses and txids only.
2. **Policy is enforced in core, not at the edge.** Every spend path (CLI, library, MCP, 402 client) funnels through one `authorizeSpend()` gate in core. An agent calling MCP tools must be physically unable to bypass budgets — no flag, parameter, or tool argument may disable policy. Only a human editing `policy.toml` + restarting can change limits.
3. **Stable contracts.** Exit codes 0–8 keep their documented meanings (new codes append, never repurpose). `--json` shapes are additive-only. MCP tool schemas, once shipped, are additive-only.
4. **Bare amounts are satoshis.** Suffixes `sats`/`bsv` only. Ambiguity is exit 2, never a guess.
5. **stdout is for machines, stderr is for humans.** Prompts, warnings, spinners → stderr.
6. **Every money movement and every policy decision (allow or deny, with reason) is appended to the ledger.** The ledger is append-only; never rewrite history.
7. **Testnet and mainnet state never mix.** Separate files, validated address prefixes.

## Workflow

- Work milestone-by-milestone (see AGENT-PHASE2.md). After each: `npm test`, `npm run lint`, `npm run build`, fix, then commit with a clear message. Don't start the next milestone in the same dirty state.
- New features need unit tests (mock ChainProvider, no live network in CI) and, where they touch the payment loop, an `e2e:local` extension.
- Security-sensitive diffs (wallet/, policy/, anything touching signing or spend paths) should be small, isolated commits — they get human review.
- Use `--dry-run` and testnet for any manual verification. Never test against mainnet funds.
- If a decision genuinely blocks you, ask; otherwise choose sensibly and record it in DECISIONS.md.

## Out of scope (Phase 2)

Tokens/ordinals, DeFi, GUI, web dashboard, multi-chain support. If a milestone seems to need one of these, stop and ask.