# Decisions

Running log of non-blocking decisions made while building bsv-pay.

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
