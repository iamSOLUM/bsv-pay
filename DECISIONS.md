# Decisions

Running log of non-blocking decisions made while building bsv-pay.

## Licensing

- **MIT, confirmed by the owner (2026-06-10)** after weighing source-available and dual-license options. Rationale: for a hot-wallet CLI, trust and adoption are the asset — auditability is a feature, and the monetization path is around the tool (donations, services, hosting) rather than license sales.

## M1 — Scaffold

- **TOML parser**: `smol-toml` (pure TS, maintained, TOML 1.0). The PRD fixes the major stack but not a TOML library; this is the lightest compliant option.
- **Argon2id**: `@noble/hashes` provides a pure-JS argon2id. Chosen over the native `argon2` package so `npm install -g` never needs a compiler toolchain.
- **Default fee rate**: 50 sats/KB with a 1-sat minimum fee. Mainstream BSV miners currently accept well below this; conservative default, user-tunable via `fee_rate_sats_per_kb` in config.toml.
- **State home override**: `BSV_PAY_HOME` env var redirects `~/.bsv-pay/` — needed for tests and harmless for users.
- **Network naming**: internal `Network` type is `'main' | 'test'` matching WhatsOnChain path segments.
- **ESM**: package is ESM-only (`"type": "module"`); Node >= 20 required, which predates the npm-global target anyway.
- **Commander usage errors**: unknown commands/options/missing args exit 2 and emit the standard JSON error shape when `--json` is present.

## M2 — Wallet

- **Derivation path**: BIP-44 with the registered BSV coin type — `m/44'/236'/0'/{0|1}/{index}` (0 = receive, 1 = change). Some BSV wallets use the BTC coin type (0'); importers coming from those wallets will see an empty balance and should re-import into such a wallet instead. Documented trade-off in README later.
- **Argon2id parameters**: OWASP first recommended config (m=19 MiB, t=2, p=1) — ~0.3 s per unlock in pure JS, acceptable for a CLI that unlocks on every spend. Params are stored in the wallet file so they can be raised without breaking existing wallets.
- **BRC-100**: `init --brc100` returns a clear `brc100_not_supported` error (exit 2); `src/wallet/brc100.ts` holds the future interface.
- **Non-interactive `init` (create)**: allowed when `BSV_PAY_PASSPHRASE` is set; the new seed is printed to stderr with a warning and the write-it-down confirmation is skipped, so scripts/CI can provision wallets. Interactive runs must re-type a randomly chosen seed word (3 attempts).
- **Seed display in `--json` mode**: the seed phrase and all prompts go to stderr; the JSON result never contains key material (invariant 4). Scripts that need the seed must capture stderr deliberately.
- **`init --force`**: overwrites the wallet file but keeps the old ledger (history is append-only); stale `address_issued` entries from the previous wallet are ignored because tracked addresses derive from wallet counters, not the ledger.
- **All interactive prompts write to stderr**, keeping `--json` stdout machine-clean even mid-prompt.

## M3 — balance

- **Read-only commands don't need the passphrase**: `balance` and `watch` enumerate addresses from the ledger's `address_issued` entries instead of unlocking the wallet. Spending commands still unlock.
- **Broadcast is never silently retried** (unlike GET requests): a retry after an ambiguous failure could mask a double-send. Ambiguity surfaces as exit 6.

## M4 — send

- **UTXO selection**: largest-first greedy with a fee feedback loop. Minimizes input count (and thus fees) for micropayment-sized wallets; no privacy-motivated randomization in the MVP.
- **Dust threshold 135 sats**: change below this is folded into the fee rather than creating an uneconomical output.
- **Fee estimate**: 10 + 148×inputs + 34×outputs bytes (standard P2PKH sizes), rounded up to ≥1 sat. Verified against a real signed tx (225 bytes vs 226 estimated).
- **`--dry-run` persists nothing**: no ledger entry, no change-address counter bump — repeated dry runs are free of side effects.
- **At/above the spend limit interactively**, the user must re-type the amount in sats (stronger than y/N for irreversible money movement).
- **Exit 6 path**: the ledger records the send with `status: "unknown"` and the txid is printed in both human and JSON output so the user can check the explorer before retrying.

## M5 — request

- **`request --wait --json` emits NDJSON** (a `request_created` object, then `payment_received`): a script must learn the address before anyone can pay it, so a single trailing object would be useless. This mirrors the `watch` NDJSON carve-out in invariant 2.
- **Any payment to the request address counts** as fulfilment (the address is fresh, so the first inbound tx is the payment); a short-pay prints a warning but still exits 0. Strict amount matching would strand honest underpayments.
- **`--wait` timeout exits 4** per the PRD's exit-code table, with error code `request_timeout`.

## M6 — watch

- **First polling cycle baselines silently** — pre-existing funds are not session events. The session total counts only payments that arrive while watching.
- **Rate-limit handling**: any chain failure doubles the poll interval (capped at 8×) and resets after a healthy cycle; the session never crashes.
- **Ledger dedupe**: watch appends a `receive` only if no receive with the same txid+address exists (request `--wait` may already have recorded it).
- **Tracked addresses re-read every cycle**, so a `request` issued in another terminal is picked up mid-session.

## M7 — polish

- **Donation address**: mainnet donations go to the real project address `131CswxfV8Swi8zUSc3XfH9tEJLxzxmpa4` (provided by the owner on 2026-06-10). The testnet entry remains the well-known `mipcBbFg…` placeholder (valid checksum, no key holder) and warns accordingly.
- **E2E testnet script** (`scripts/e2e-testnet.mjs`) is gated behind `BSV_PAY_E2E=1`, drives the CLI exclusively through `--json` + exit codes, and requires one manual faucet payment.
- **Local e2e harness (post-MVP)**: BSV testnet faucets are effectively dead (checked 2026-06-10: witnessonchain is the lone survivor, captcha-gated and unusable for the owner; scrypt.io 526, bitails faucet 502, bitcoincloud NXDOMAIN). `scripts/e2e-local.mjs` runs the full definition-of-done loop by spawning the real CLI against an in-process WhatsOnChain-compatible mock over real HTTP; it runs in CI. `BSV_PAY_API_URL` was added to the provider to support this (and any self-hosted WoC-compatible API). The live-testnet script remains for whenever coins are obtainable.
- **Spend-limit check precedence**: the limit is enforced right after amount parsing — before wallet unlock and any network call — so `--yes` scripts over the limit fail fast with exit 8. Found via the e2e harness: previously an over-limit amount on an underfunded wallet exited 3 instead of 8.
- **Global-install verification**: Docker is not installed on this machine, so the "clean Docker container" check was substituted with an `npm install -g --prefix <fresh dir>` of the packed tarball — verified `--version`, JSON error shapes, exit codes 2/3, and a live testnet init/request/balance loop through the installed binary. Re-run in Docker (`docker run -it node:22 npm i -g bsv-pay-0.1.0.tgz`) when available.
