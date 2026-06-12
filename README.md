# bsv-pay

A developer-first CLI — and an agent payment toolkit — for sending and
receiving micropayments on Bitcoin SV. Script-friendly by design: every
command supports `--json`, exit codes are stable and documented, and
nothing on stdout ever needs human parsing. Agent-safe by design: a policy
engine sits below every spend path, agents connect over MCP without ever
touching a key, and every decision lands in an append-only ledger.

> **Hot wallet.** bsv-pay keeps an encrypted seed on your disk and talks to a
> public API. Treat it like cash in your pocket: keep small amounts only.

**Giving an AI agent a wallet?** Start with
[Agentic payments with bsv-pay](docs/AGENTIC-PAYMENTS.md) — the threat
model, MCP setup for Claude Code / Claude Desktop / Cursor, the 402 flow,
and external custody. Or watch the whole thesis run in one command, no
coins needed:

```bash
npm run demo:two-agents   # a seller, a buyer agent, and the policy that governs it
```

## 60-second quickstart

```bash
npm install -g bsv-pay-cli     # or: npm install -g bsvpay (same thing)

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
| `--experimental-brc100` | EXPERIMENTAL: delegate custody to a BRC-100 wallet app — see below |
| `--brc100` | Reserved; points you at `--experimental-brc100` |

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

Sends a donation (default 10,000 sats) to the project donation address
(`131CswxfV8Swi8zUSc3XfH9tEJLxzxmpa4`). On testnet the address is still a
placeholder — the command warns; use `--dry-run` there.

### `bsv-pay policy show` / `bsv-pay policy test <address> <amount>`

`show` prints the active policy, live budget usage, and pending approvals.
`test` dry-runs a decision without sending or recording anything:
exit 0 = would allow, 8 = would deny, 9 = would queue for approval.

### `bsv-pay approvals list|approve <id>|reject <id>|set-secret`

Reviews and resolves payments queued by `approval_threshold_sats`.
`approve`, `reject`, and `set-secret` are **interactive only**: they require
a real terminal and the approval secret. There is deliberately no flag or
environment variable for the secret — see the policy section below.

### `bsv-pay fetch <url>`

Fetch a URL, automatically paying a BRC-105 `402 Payment Required` response
within policy. `--max-price <amount>` refuses to pay more than that for this
fetch, regardless of remaining budget. The body is the machine output (raw
on stdout, or in `--json`); payment details go to stderr. Free resources
cost nothing. See "Machine-to-machine payments" below.

### `bsv-pay serve --price <amount>`

A demo BRC-105 paywall: every request pays `--price` into this wallet before
it gets the content (`--port`, default 8402; `--host`, default localhost-only;
`--body` for the content). The real product is the importable
`requirePayment()` middleware this wraps — see below.

### `bsv-pay mcp`

Serves MCP tools over stdio for AI agents (`pay`, `paid_fetch`,
`create_payment_request`, `await_payment`, `get_balance`, `get_history`,
`get_policy_status`). The
wallet unlocks once at startup — `BSV_PAY_PASSPHRASE` or a terminal prompt —
and there is deliberately no unlock, approve, or key tool, so the connected
agent never holds a secret. Every `pay` goes through the same policy gate as
the CLI. See "Using bsv-pay with Claude Code" below.

## Amounts

Bare numbers are **satoshis**. Suffixes `sats` and `bsv` are accepted:
`5000`, `5000sats`, `0.0001bsv`. Anything ambiguous (`5,000`, `1e3`,
fractional sats) is an error — bsv-pay never guesses.

## Policy engine — `~/.bsv-pay/policy.toml`

Budgets and rules that sit **below** every spend path — CLI, library, and
MCP tools. No flag, parameter, or tool argument can cross a
policy.toml rule; only editing the file (and restarting any long-running
process) changes limits. Without a policy.toml nothing changes: only the
legacy `spend_limit_sats` confirm threshold from config.toml applies.

```toml
per_tx_limit_sats = 50000        # HARD cap per transaction (no --allow-large escape)
daily_budget_sats = 200000       # rolling 24h total, recomputed from the ledger
session_budget_sats = 100000     # per long-running process (e.g. an MCP server)
rate_limit_per_minute = 6        # max payments per minute
rate_limit_per_hour = 60         # and per hour
approval_threshold_sats = 25000  # at/above this, queue for human approval (exit 9)
allowlist = []                   # when non-empty, ONLY these recipients
denylist = []                    # always wins

[network.test]                   # optional per-network overrides
daily_budget_sats = 1000000
```

- Every decision — allow, deny, or queue — is appended to the ledger with
  the rule and reason. Denials exit 8 with a machine-readable `error`
  (`daily_budget_exceeded`, `recipient_denied`, …) and useful numbers
  (`remaining_sats`) so scripts and agents can adapt instead of retrying.
- Daily budgets and rate limits are recomputed from the append-only ledger
  at every decision — restarting a process never resets them. Unknown-status
  broadcasts count as spent. Typos in policy.toml are hard errors, never
  silently ignored.
- **Approvals**: a queued payment is sent only after a human runs
  `bsv-pay approvals approve <id>` and types the **approval secret** — a
  second secret, separate from the wallet passphrase, stored only as an
  argon2id hash. An agent holding `BSV_PAY_PASSPHRASE` cannot approve its
  own payment: the wallet passphrase is not accepted, and there is no
  non-interactive path. Approval re-checks every rule against today's
  ledger — it satisfies the threshold, never the budgets.
- **Threat model, honestly**: the policy engine governs anything that spends
  *through* bsv-pay. An actor with write access to `~/.bsv-pay` (or
  arbitrary code plus your passphrase) can bypass any local tool — so don't
  give agents the passphrase. The recommended agent setup is `bsv-pay mcp`:
  the server holds the unlocked wallet while the agent gets only budgeted
  tools.

## Using bsv-pay with Claude Code

```bash
claude mcp add bsv-pay --env BSV_PAY_PASSPHRASE=your-passphrase -- bsv-pay mcp --testnet
```

The server process holds the passphrase; Claude gets seven tools and nothing
else — no unlock, no approvals, no keys, no way to raise its own limits.
Policy edits apply on server restart (session budgets reset with the
process; daily budgets never reset — they are recomputed from the ledger).

A budget-governed session against this `~/.bsv-pay/policy.toml`:

```toml
per_tx_limit_sats = 8000
daily_budget_sats = 12000
approval_threshold_sats = 1500
```

The agent plans within its allowance instead of discovering limits by
failing — and when it crosses one anyway, the refusal is a structured
result it can read, not an opaque error:

```
get_policy_status        → { ok: true, daily_remaining_sats: 2300, pending_approvals: [], … }
pay (800 sats)           → { ok: true, txid: "d6d818f6…", fee_sats: 12, … }
pay (1600 sats)          → { ok: false, error: "daily_budget_exceeded", remaining_sats: 1500, … }
pay (1500 sats)          → { ok: false, error: "pending_approval", approval_id: "8b1f42…", … }
```

That last payment was **not sent** — it is queued for you:

```bash
bsv-pay approvals list             # review what the agent wants to pay
bsv-pay approvals approve 8b1f42   # type the approval secret to release it
```

Every decision — allowed, denied, or queued — lands in the append-only
ledger with its rule and reason, so you can audit exactly what the agent
did and what it tried to do. The same loop runs end-to-end in CI against a
local mock chain (`npm run e2e:local`, step 9), so none of the above
depends on live coins to verify.

## Machine-to-machine payments — HTTP 402 (BRC-105)

Buy:

```bash
bsv-pay fetch https://seller.example/dataset --max-price 1000
```

On a `402 Payment Required`, fetch reads the BRC-105 headers, pays within
policy (the same gate, budgets, and ledger as `send`), retries with the
`x-bsv-payment` envelope, and prints the content. Agents get the same flow
as the MCP `paid_fetch` tool.

Sell — either the demo server:

```bash
bsv-pay serve --price 50sats --port 8402 --body "premium data"
```

or the importable middleware (Express-compatible, zero dependencies):

```js
import { openWallet, requirePayment } from 'bsv-pay/core';

const wallet = await openWallet({ network: 'test' });
const gate = requirePayment({ network: 'test', wallet, priceSats: 50 });
app.use(gate); // req.bsvPayment = { txid, amountSats, address, … } once paid
```

Each 402 quotes a **fresh wallet address** with a single-use nonce prefix
(10-minute TTL); the seller confirms the payment on its own chain view
before serving and ledgers the receive. The buyer broadcasts through the
policy gate, so a 402 spend can be denied (exit 8), capped (`--max-price`,
exit 8 before any spend), or queued for approval (exit 9) exactly like any
other payment. Exit 10 means you paid but the server refused the content —
the txid is in the error, take it up with the seller.

**Compatibility, honestly**: this is a simplified BRC-105 profile — same
headers, flow, and version, but the payment destination is an advertised
fresh address rather than BRC-29 derived keys, and the envelope carries raw
tx hex rather than AtomicBEEF. bsv-pay's fetch and serve interoperate with
each other today (including under BRC-100 custody, where the external
wallet signs the 402 payment). Interop with external full-BRC-105 services
needs the SDK's AuthFetch (BRC-103/104 mutual auth); that integration is
deferred — there is no server-side implementation in our dependency set to
test a handshake against, and we won't ship untestable code in the spend
path. Details and the full reasoning in DECISIONS.md (M12).

## External wallet custody — BRC-100 (EXPERIMENTAL)

```bash
bsv-pay init --experimental-brc100 --testnet
```

Instead of a local seed, bsv-pay connects to a BRC-100 wallet app running
on your machine (e.g. Metanet Desktop, which serves the wallet JSON-API on
`localhost:3321`; override with `BSV_PAY_BRC100_URL`). Keys live in the
wallet app and **never** touch bsv-pay; bsv-pay constructs payment actions
and the app funds, signs, and broadcasts them — asking for your approval in
its own UI as it sees fit.

**The policy engine stays in front.** Every spend still passes the same
`authorizeSpend()` gate — budgets, rate limits, allow/denylists, approval
queue — *before* the wallet app is ever asked, and every decision is
ledgered. The wallet app is a second pair of hands, not a way around your
policy. That layering is the point: the app protects the keys, bsv-pay
governs the spending.

What works under BRC-100 custody today, and what doesn't:

| Surface | Status |
| --- | --- |
| `send`, `donate`, `fetch` (402 buyer), MCP `pay` + `paid_fetch` | ✅ governed by policy, ledgered, exact fee reported |
| `balance` (one spendable total from the app), `history`, `policy`, `approvals` | ✅ |
| `request`, `watch`, `serve` / `requirePayment()`, MCP request tools | ❌ exit 2 `brc100_receive_not_supported` — receive in the wallet app itself |

Receiving refuses by design rather than half-working: an address issued by
bsv-pay would be invisible to the wallet app, so funds sent there could not
be seen or spent from it. Use the app's own receive screen, or a local-seed
wallet for the selling side.

Setup and a step-by-step verification walkthrough: [docs/BRC100.md](docs/BRC100.md).

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
| 7 | Wallet locked / bad passphrase (also: wrong approval secret) |
| 8 | Spend limit exceeded / denied by policy (`error` says which rule) |
| 9 | Queued for human approval (`approval_id` in `--json`; see `bsv-pay approvals`) |
| 10 | 402 payment broadcast but the server refused the content (`txid` in the error) |

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

## Library usage — `bsv-pay/core`

The CLI is a thin layer over an importable engine. `bsv-pay/core` exposes the
same operations with typed results and typed errors — no prompts, no console
output, no `process.exit`, and never any key material in a return value:

```ts
import { openWallet, getBalance, send, createRequest, awaitPayment, BsvPayError } from 'bsv-pay/core';

const opts = { network: 'test' } as const;
const wallet = await openWallet({ ...opts, passphrase: process.env.WALLET_PASS });

const { confirmedSats, unconfirmedSats } = await getBalance(opts);

try {
  const result = await send(wallet, opts, { to: address, amountSats: 5000, memo: 'thanks' });
  console.log(result.txid, result.feeSats);
} catch (e) {
  if (e instanceof BsvPayError) console.error(e.errorCode, e.exitCode); // e.g. insufficient_funds, 3
}

const invoice = createRequest(wallet, { amountSats: 10_000, memo: 'invoice #7' });
const paid = await awaitPayment(opts, { address: invoice.address, timeoutMs: 600_000 });
```

`BsvPayError.exitCode` carries the same stable numbers as the CLI exit codes
below; `errorCode` is the same snake_case string `--json` emits. The config
spend limit applies to library sends too (`allowAboveLimit` mirrors
`--allow-large`); ledger entries are written exactly as the CLI writes them.
`planSend()`/`executeSend()` split the flow when you need to show fees before
committing, and `getHistory()` reads the local ledger. Wallet *creation* is
CLI-only for now — run `bsv-pay init` first.

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
npm run e2e:local   # full loop through the real CLI against a local mock API
node scripts/e2e-testnet.mjs   # live testnet loop, needs BSV_PAY_E2E=1 + faucet coins
```

`e2e:local` runs the whole definition-of-done loop (init → request → payment →
watch detects → send back → balance reconciles) by spawning the actual binary
against a local WhatsOnChain-compatible server — no coins or captchas needed —
then re-runs the loop through the built `bsv-pay/core` library against the
same mock. Point the CLI at any WoC-compatible API with `BSV_PAY_API_URL`.

The local ledger (`~/.bsv-pay/ledger.jsonl`) is append-only JSONL recording
every send, receive, and issued address.
