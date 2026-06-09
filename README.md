# bsv-pay

A developer-first CLI for sending and receiving micropayments on Bitcoin SV.
Script-friendly by design: every command supports `--json`, exit codes are
stable and documented, and nothing on stdout ever needs human parsing.

> **Hot wallet.** bsv-pay keeps an encrypted seed on your disk and talks to a
> public API. Treat it like cash in your pocket: keep small amounts only.

## 60-second quickstart

```bash
npm install -g bsv-pay

# 1. Create a wallet (you'll write down a 12-word seed and pick a passphrase)
bsv-pay init --testnet

# 2. Fund it from a testnet faucet (e.g. https://witnessonchain.com/faucet/tbsv)
bsv-pay request 10000sats "faucet top-up" --testnet     # prints address + QR

# 3. Watch it arrive (0-conf shows within seconds)
bsv-pay watch --testnet

# 4. Check and spend
bsv-pay balance --testnet
bsv-pay send <address> 5000sats "thanks" --testnet
```

Drop `--testnet` for real money. Set `network = "test"` in
`~/.bsv-pay/config.toml` to make testnet the default.

## Commands

### `bsv-pay init`

Create or import a wallet. Refuses to overwrite an existing wallet without
`--force`.

| Flag | Meaning |
| --- | --- |
| `--import-seed` | Import a BIP-39 seed phrase (checksum validated) |
| `--import-wif` | Import a raw WIF key (single address, risk warning shown) |
| `--force` | Overwrite an existing wallet |
| `--no-encrypt` | Explicit opt-in to store the seed unencrypted (warned on every run) |
| `--brc100` | BRC-100 wallet connection — not yet supported, clear error |

### `bsv-pay balance`

Confirmed and unconfirmed balance across every address the wallet has issued.
JSON shape: `{ok, confirmed_sats, unconfirmed_sats, addresses: [...]}`.
No passphrase needed (addresses come from the local ledger).

### `bsv-pay send <address> <amount> ["memo"]`

Builds, confirms, and broadcasts a payment. Always shows recipient, amount,
fee, and resulting balance before broadcasting.

| Flag | Meaning |
| --- | --- |
| `-y, --yes` | Skip the confirmation prompt (spend limit still enforced) |
| `--allow-large` | With `--yes`, permit sends at/above the spend limit |
| `--dry-run` | Build and sign but never broadcast; persists nothing |
| `--confirmed-only` | Don't spend unconfirmed UTXOs (spent by default) |

Memos are stored only in your local ledger — never on-chain.

### `bsv-pay request <amount> ["memo"]`

Derives a fresh receiving address, prints a BIP-21 URI
(`bitcoin:<addr>?sv&amount=<bsv>&label=<memo>`) and a terminal QR code
(suppressed when piped or with `--json`).

| Flag | Meaning |
| --- | --- |
| `--wait` | Poll until the payment is seen at 0-conf, then exit 0 with the txid |
| `--timeout <sec>` | With `--wait`, give up after this many seconds (default 600, exit 4) |

With `--json --wait` the output is NDJSON: first a `request_created` object
(so your script has the address), then a `payment_received` object.

### `bsv-pay watch`

Polls all tracked addresses (default every 10s, `--interval <sec>`, floor 5s)
and reports incoming payments at 0-conf as `pending`, then `confirmed`. Shows
the memo when the payment matches a request address, plus a session running
total. `--json` emits one NDJSON object per event. Rate limits back off
gracefully; Ctrl-C exits cleanly with a session summary.

### `bsv-pay donate [amount]`

Sends a donation (default 10,000 sats) to the project. The address is still a
placeholder — the command warns loudly; use `--dry-run`.

## Amounts

Bare numbers are **satoshis**. Suffixes `sats` and `bsv` are accepted:
`5000`, `5000sats`, `0.0001bsv`. Anything ambiguous (`5,000`, `1e3`,
fractional sats) is an error — bsv-pay never guesses.

## Exit codes (stable)

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Invalid usage, address, amount/unit, or config |
| 3 | Insufficient funds |
| 4 | Network/API error (after one automatic retry) — also `--wait` timeout |
| 5 | Broadcast rejected by the network |
| 6 | Broadcast sent but status unknown (txid is still printed — check before retrying) |
| 7 | Wallet locked / bad passphrase |
| 8 | Spend limit exceeded |

## Scripting

Every command takes `--json`: a single JSON object on stdout (NDJSON for
`watch` and `request --wait`), errors as
`{"ok": false, "code": <int>, "error": "<snake_case>", "message": "..."}`.
All prompts and human text go to stderr.

```bash
export BSV_PAY_PASSPHRASE=...   # unlock without a prompt
ADDR=$(bsv-pay request 5000 --json | jq -r .address)
bsv-pay send "$DEST" 5000sats --yes --json | jq -r .txid
```

The whole receive→send loop is scriptable with `--json` + exit codes alone.

## Configuration — `~/.bsv-pay/config.toml`

```toml
network = "main"            # or "test"
fee_rate_sats_per_kb = 50   # miner fee rate
poll_interval_secs = 10     # watch/request --wait cadence (floor 5)
spend_limit_sats = 100000   # per-transaction confirm threshold
fiat_display = false
```

All keys are optional; the values above are the defaults.

## Security notes

- **Seed encryption at rest**: argon2id-derived key + AES-256-GCM; wallet and
  ledger files are written `0600` under `~/.bsv-pay/`.
- **Passphrase**: interactive prompt, or `BSV_PAY_PASSPHRASE` for scripts.
  `--no-encrypt` exists but warns on every run.
- **Keys never leave the machine** and never appear in logs, errors, the
  ledger, or `--json` output. Transactions are signed locally; only raw signed
  hex is sent to the API.
- **Spend limit**: sends at/above `spend_limit_sats` (default 100k) require an
  explicit interactive confirmation or `--yes --allow-large`.
- **Address checksums** (and network prefix) are validated before any network
  call — a mainnet/testnet mix-up is exit 2, not lost coins.
- **Hot-wallet framing**: this is for micropayments. Do not store more than
  you would carry in cash. Testnet state lives in separate files from mainnet.
- The chain API is WhatsOnChain behind a `ChainProvider` interface; swap it by
  implementing five methods.

## Development

```bash
npm install
npm test            # vitest unit suite (mock provider, no live network)
npm run lint
npm run build
node scripts/e2e-testnet.mjs   # live testnet loop, needs BSV_PAY_E2E=1
```

The local ledger (`~/.bsv-pay/ledger.jsonl`) is append-only JSONL recording
every send, receive, and issued address.
