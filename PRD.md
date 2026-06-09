# PRD: bsv-pay — Universal Micropay CLI for BSV

**Version:** 0.3 (MVP)
**Date:** June 2026
**Status:** Draft for review

---

## Overview

`bsv-pay` is a lightweight, developer-first command-line tool that makes sending, receiving, and managing micropayments on Bitcoin SV fast, simple, and scriptable.

On most blockchains, micropayments are impractical due to high fees. On BSV, they are natural. `bsv-pay` turns this advantage into a practical daily tool for developers, power users, creators, and automation scripts.

---

## Goals

### Primary Goal
Make sending and receiving micropayments on BSV as easy and natural as typing a single command.

### Secondary Goals
- Prioritize excellent terminal UX and scriptability.
- Make it safe by default: a careless command or a buggy script should never silently drain a wallet.
- Keep the core tool free and accessible.
- Build a sustainable project through community support in the early stage.
- Create a foundation that can later support optional paid features without compromising the free experience.

---

## Target Users

- Developers and power users who work in the terminal
- Content creators and builders who want to accept or send small tips/payments
- People building automation, scripts, or services that involve payments
- BSV users who want a simple, fast way to interact with micropayments

---

## Core Concept & User Flows

`bsv-pay` is a single, installable CLI binary focused on frictionless micropayments.

### Key User Flows (MVP)

- **Send a payment**
  `bsv-pay send <address> <amount> "optional memo"`
- **Check balance**
  `bsv-pay balance`
- **Watch incoming payments in real time**
  `bsv-pay watch`
- **Create a payment request**
  `bsv-pay request <amount> "memo"`
- **One-time wallet setup**
  `bsv-pay init` — import via seed phrase, raw WIF key (with warning), or connect a BRC-100 compatible wallet.

---

## MVP Scope

| Priority | Feature | Description | Included in MVP |
|---|---|---|---|
| P0 | Send payment | Send BSV with optional memo | Yes |
| P0 | Balance | Display current wallet balance | Yes |
| P0 | Watch mode | Monitor and display incoming payments | Yes |
| P0 | Payment requests | Generate payment requests (URI + terminal QR) | Yes |
| P0 | Wallet setup | Import seed/WIF or connect BRC-100 wallet | Yes |
| P0 | Safety rails | Confirmation prompts, spend limits, address validation | Yes |
| P1 | JSON output | `--json` flag for all commands (scripting) | Yes |
| P1 | Exit codes | Documented, stable exit codes for scripting | Yes |
| P1 | Config file | Minimal local config (`~/.bsv-pay/config.toml`) | Yes |
| P1 | Testnet support | `--testnet` flag | Yes |
| P1 | Donation command | `bsv-pay donate` to support the project | Yes |
| P2 | Basic transaction history | Recent sends and receives | Nice to have |

### Non-Goals for MVP
- Token support
- Complex smart contract interactions
- Full Metanet browsing
- Advanced DeFi features
- Multi-wallet / multi-profile management
- GUI or web dashboard

---

## User Experience Principles

- **Simplicity first**: The most common actions should require minimal typing.
- **Safe by default**: Destructive or irreversible actions require confirmation unless explicitly disabled.
- **Scriptable by default**: Every command works cleanly with `--json` and meaningful exit codes.
- **Fast feedback**: Clear success messages, transaction links, and updated balances.
- **Respectful prompts**: Subtle, non-intrusive messages (e.g. donation suggestions after initial use).
- **Beautiful but lightweight**: Clean, colored output without clutter (auto-disabled when piped).
- **Transparent**: Users always understand what is happening, what fees they pay, and where their funds are going.

---

## Amounts, Units & Fees

- **Default unit is satoshis.** All bare numbers are interpreted as sats: `bsv-pay send <addr> 5000` sends 5,000 sats.
- Explicit unit suffixes are supported: `5000sats`, `0.0001bsv`. Ambiguity is never guessed — an unrecognized format is an error, not a best-effort parse.
- Output always shows the unit (e.g. `Sent 5,000 sats (≈ $0.002)`); optional fiat estimate can be disabled in config.
- **Fees**: a sane default fee rate (sats/KB) is built in and shown before sending. It can be overridden per command (`--fee-rate`) or in config. The total fee is always displayed in the confirmation prompt and in `--json` output.
- **Balance & 0-conf**: `bsv-pay balance` shows confirmed and unconfirmed (pending) amounts separately. Sending can spend unconfirmed change by default (required for rapid micropayment chains), with a `--confirmed-only` flag for cautious scripts.

---

## Security & Key Handling

This tool holds real money. Key handling gets first-class treatment:

- **Storage**: Seeds/keys are stored locally in `~/.bsv-pay/`, encrypted at rest with a key derived from a user passphrase (scrypt/argon2). Files are created with `0600` permissions.
- **Interactive vs. scripted use**: Interactive sessions prompt for the passphrase (with optional OS keychain caching: macOS Keychain / libsecret / Windows Credential Manager). For automation, the passphrase may be supplied via the `BSV_PAY_PASSPHRASE` environment variable. An unencrypted "hot wallet" mode exists for CI/server use but requires an explicit `--i-understand-hot-wallet` style opt-in at setup and prints a standing warning.
- **Spend limits**: A configurable per-transaction limit (default: 100,000 sats) at or above which `send` requires interactive confirmation, or `--yes` plus an explicit `--allow-large` in scripts. A fat-fingered extra zero becomes a blocked action, not a drained wallet.
- **BRC-100 custody model**: When connected to a BRC-100 wallet, key custody and signing remain entirely in that wallet — `bsv-pay` never sees or stores keys; it only constructs requests and relays approvals. Spend limits and confirmations still apply on the `bsv-pay` side as a second layer.
- **Confirmation prompts**: All sends show recipient, amount, fee, and resulting balance before broadcasting. `--yes` skips the prompt for scripting (subject to spend limits).
- **Address validation**: Addresses are checksum-validated before any network call; invalid addresses fail fast with a clear message.
- **Raw key import**: Supported (developers will want it), but gated behind a warning explaining the risks vs. seed phrases.
- **Memo semantics**: Memos are **local metadata** in MVP — recorded in a local transaction log (`~/.bsv-pay/ledger.jsonl`), never written on-chain by default. On-chain OP_RETURN memos (`--on-chain-memo`) are post-MVP. This avoids surprise fees and privacy leaks. The same local ledger is the foundation for the P2 transaction-history feature, making it cheap to add later.
- **Memory hygiene**: Keys are zeroed from memory after use where the runtime allows; keys are never written to logs, history, or `--json` output.
- **Recommended posture**: Documentation explicitly frames `bsv-pay` wallets as hot wallets for small amounts, not savings.

---

## Error Handling & Exit Codes

Scripts must be able to distinguish failure modes programmatically.

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | General / unexpected error |
| 2 | Invalid usage (bad arguments, unknown unit, invalid address) |
| 3 | Insufficient funds |
| 4 | Network/API error (e.g. WhatsOnChain unreachable) |
| 5 | Broadcast failed / rejected by network |
| 6 | Broadcast succeeded but confirmation status unknown |
| 7 | Wallet locked / passphrase missing or wrong |
| 8 | Spend limit exceeded without override |

- Human-readable errors go to stderr; `--json` errors are structured (`{"ok": false, "code": 3, "error": "insufficient_funds", ...}`).
- Exit code 6 still emits the txid (stdout / `--json`) so scripts can verify the payment themselves before deciding how to proceed.
- Every failure message says what happened **and** what to do next.
- Network operations have sensible timeouts and one automatic retry with backoff before failing.

---

## Payment Requests (Spec)

`bsv-pay request <amount> "memo"` produces a complete, shareable request:

1. A **payment URI** (BIP-21 style: `bitcoin:<address>?sv&amount=...&label=...`) printed to stdout.
2. A **QR code rendered in the terminal** (suppressed when piped or with `--json`).
3. A fresh receiving address derived from the wallet (one address per request, to make matching unambiguous).

**Fulfillment detection**: `bsv-pay request --wait` blocks until payment to that address is detected (reusing the watch machinery), then exits 0 with the txid — making "request, get paid, continue script" a one-liner. Without `--wait`, the user can run `bsv-pay watch` separately.

---

## Watch Mode (Spec)

- Polls the WhatsOnChain API at a default interval of **10 seconds** (configurable, floor of 5s to respect rate limits).
- Target: an incoming payment appears in the terminal **within 15 seconds** of broadcast at default settings.
- Reports payments at **0-conf** (as soon as seen in the mempool) and marks them as `pending` until confirmed — essential for micropayment UX.
- Displays: amount, sender (if derivable), memo/OP_RETURN if present, txid link, running session total.
- `--json` mode emits one JSON object per event (NDJSON) for piping into other tools.
- Handles API rate-limit responses gracefully (backs off, informs the user, never crashes the session).
- Post-MVP path: webhook/streaming backends for higher reliability (see Future Considerations).

---

## Monetization Strategy (Phase 1)

For the MVP and early stages, `bsv-pay` will be **completely free** to use.

**Primary monetization approach:**

- **Donations and Sponsorships**
  - GitHub Sponsors (main channel)
  - Direct BSV donations via `bsv-pay donate`
  - Open Collective (optional)
  - Community and ecosystem sponsorships

The tool will include tasteful, low-friction ways to support development (e.g. `bsv-pay donate` command and occasional gentle prompts), but these will never block core functionality and never appear in `--json`/piped output.

**Future consideration (Post-MVP):**
Tiny, optional platform fees may be introduced later on advanced or high-volume features only. Core sending and receiving will remain free indefinitely.

---

## Distribution & Launch

- Published as an npm package (`npm i -g bsv-pay`) with a single-command install.
- README with a 60-second quickstart and an animated terminal demo (the demo *is* the marketing).
- Launch channels: BSV developer communities/forums, X/Twitter BSV ecosystem, Hacker News "Show HN", relevant Discord/Telegram groups.
- Early adopters: reach out to 5–10 BSV builders pre-launch for feedback and first testimonials.

---

## Technical Approach

- **Language**: TypeScript (Node.js, LTS)
- **BSV Library**: `@bsv/sdk` (primary) with BRC-100 wallet support
- **CLI Framework**: Commander.js + Chalk + clean output formatting (color auto-off when not a TTY)
- **Receiving payments**: Polling via WhatsOnChain API (simple and reliable for MVP); API layer abstracted so alternative providers can be added without touching command code
- **Wallet handling**: Local encrypted storage for seeds (scrypt/argon2 + AES-256-GCM) + support for BRC-100 wallets
- **Address management**: HD derivation (BIP-32/44); every issued receiving address is recorded in the local ledger so `balance` and `watch` cover all of them without slow gap-limit scanning
- **Config**: `~/.bsv-pay/config.toml` (network, units, fee rate, poll interval, spend limit)
- **Output modes**: Human-readable by default + full `--json` support
- **Distribution**: Published as an npm package with easy global install
- **Testing**: Unit tests for parsing/validation; integration tests against testnet in CI

---

## Success Metrics (MVP)

- A user can send their first micropayment within **2 minutes** of installing the tool (measured via documented quickstart walkthrough with fresh users).
- `bsv-pay watch` detects an incoming payment within **15 seconds** at default settings.
- `--json` + exit codes are sufficient to script a send-and-verify loop **without parsing human-readable text**.
- **0 reported incidents** of unintended fund loss attributable to tool UX (typos, unit confusion, missing confirmations) within the first 3 months.
- ≥ **200 GitHub stars** and ≥ **5 sponsors/donations** within 3 months of launch.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WhatsOnChain rate limits or outage | watch/balance break | Backoff + clear errors; provider abstraction; document limits; webhook backend post-MVP |
| Key theft or loss from local storage | User funds lost | Encryption at rest, 0600 perms, hot-wallet framing, spend limits |
| Script bugs sending wrong amounts | User funds lost | Default sats unit + explicit suffixes, spend limits, confirmations, dry-run flag (`--dry-run`) |
| npm supply-chain compromise | Catastrophic trust loss | Lockfile, minimal deps, provenance/signed releases, 2FA on npm account |
| Low adoption / donation model fails | Project stalls | Launch plan above; keep maintenance cost low via small scope |
| BSV ecosystem perception/volatility | Shrinking user base | Keep tool thin; provider abstraction limits sunk cost |

---

## Future Considerations

- Advanced watch features (webhooks, streaming, better reliability) as paid or sponsored functionality
- Tiny usage-based fees on high-volume or premium features
- Token support and basic contract interaction
- Potential web dashboard companion (optional)
- Multi-profile/multi-wallet support
- Homebrew / standalone binary distribution (no Node required)

---

## Resolved Questions (from v0.2)

- **Raw private key import?** Yes — supported behind an explicit warning. Developers expect it; hiding it just causes workarounds.
- **Polling interval for watch?** Default 10s, configurable with a 5s floor; success metric set at detection within 15s.
- **Local config file from the start?** Yes — minimal TOML config from day one; retrofitting config later is more painful than starting small.
- **Memo: on-chain or local?** Local-only metadata in MVP (see Security & Key Handling); on-chain OP_RETURN memos are an explicit post-MVP flag.

## Open Questions

- Should `request --wait` have a default timeout, and what should it be?
- Minimum Node.js version to support (LTS-only vs. current)?