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
