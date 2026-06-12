# AGENT-PHASE3.md — bsv-pay: Identity-Key Payments (the second rail)

Phase 2 made bsv-pay the safest payment tool an agent can hold on BSV.
Phase 3 adds a second *receive* rail: identity-key payments (BRC-29-style
derivation, peer-delivered payment artifacts, `internalizeAction`
acceptance) alongside — never instead of — the address rail. The thesis:
address-based receive scales by issuing addresses and polling a chain
provider per address; identity-key receive scales by handing the payment
artifact directly to the payee. Both should exist; the user picks.

Read CLAUDE.md first — its invariants override anything here — then
CONTRIBUTING.md and the DECISIONS.md entries for M11/M12 (the receive-side
refusal and the AuthFetch deferral are the recorded reasoning this phase
builds on). Work milestone-by-milestone; the Phase 1 + Phase 2 e2e steps
must pass untouched after every one.

## Ground rules (owner-ratified 2026-06-13)

1. **Address mode stays byte-identical and remains the default.** Every
   existing command, flag, exit code, and JSON shape is untouched.
2. **Defaults flip by explicit opt-in and human-verified promotion only —
   never environment detection.** No code path may switch transports
   because it detected a wallet app installed or listening. (Same ruling
   that rejected `WalletClient('auto')` in M12 and gates
   `--experimental-brc100` promotion on the real-app pass.)
3. **The `PaymentTransport` abstraction lands in the same milestone as
   its second consumer** (the identity transport) — not before. An
   abstraction with one implementation is speculation; see the M8
   monorepo-split precedent.
4. **Receiving is ungated; paying is not.** Inbound funds never pass the
   policy gate. Any new *outbound* path (paying an identity-key request)
   funnels through `authorizeSpend()` like every other spend, gets a
   choke-point allowlist review, a sweep row, and forgery coverage.
5. External-wallet interop sits behind the standing real-app gate
   (HANDOFF.md IOU): mock-proven work ships behind an experimental flag;
   promotion needs a human completing a documented verification loop
   against real wallet software.

## M14 — The identity rail, both ends, bsv-pay↔bsv-pay, CI-provable

Behind an explicit flag/config (suggested: `transport = "identity"` in
the request, or `--identity` on `request`; design in the issue first).

- **Receive**: `bsv-pay request --identity` produces an identity-key
  payment request (payee identity key, derivation prefix, amount,
  network) instead of an address URI. Local-seed wallets derive accepting
  keys via BRC-42/43 **inside `src/wallet/` only**; BRC-100-backed
  wallets accept via `internalizeAction` — which converts M12's
  `brc100_receive_not_supported` refusal into a supported path for this
  transport (the address-mode refusal stays).
- **Pay**: bsv-pay can pay such a request — through the policy gate. The
  artifact (AtomicBEEF + remittance: derivation prefix/suffix, sender
  identity key) is delivered to the payee, who validates, accepts, and
  ledgers the receive (invariant 6: a `receive` entry plus an additive
  `request_issued`-style entry for issued identity requests).
- **Open design questions to settle in the issue BEFORE code** (each
  becomes a DECISIONS.md entry):
  - Artifact delivery for v1: direct HTTP hand-off (the 402-envelope
    pattern we already ship), stdin/file exchange, or a message-box
    service. Bias: the simplest mechanism that two bsv-pay instances can
    prove in CI; fancier delivery can be a later transport detail.
  - **Identity-key policy semantics**: allow/denylists are exact-string
    matches today; an identity-key spend's `to` is a pubkey, not an
    address. Lists must be able to name identity keys, the engine's
    request must carry which kind it is, and the behavior must be
    documented and swept — this is the exact concern that helped defer
    AuthFetch (DECISIONS M12), now solved deliberately instead of
    inherited accidentally.
  - How `await`/acceptance interacts with `awaitPayment`'s contract
    (it only watches artifacts this wallet issued; it ledgers on accept).
- **Proofs**: choke-point scan extended consciously (`internalizeAction`
  is currently allowlisted to `wallet/brc100.ts` only); sweep row for the
  identity spend path; key-boundary coverage for the new derivation
  surface; an e2e step where one bsv-pay instance requests, the other
  pays, and both ledgers reconcile — all on the local mock chain.

## M15 — External-wallet interop (gated on the real-app pass)

Real wallet apps (BSV Desktop / Metanet Desktop) paying bsv-pay identity
requests and vice versa. Blocked on funding a real wallet on testnet
(the standing faucet problem); ships experimental with a noob-proof
verification guide in docs/, same pattern as docs/BRC100.md. This is
also the natural moment to re-revisit full BRC-105/AuthFetch for the 402
client — the counterparty problem and the identity-key policy semantics
(solved in M14) were two of its three deferral reasons.

## M16 — Promotion review (owner checkpoint)

Only after M14 + M15 evidence exists: decide flag→default questions
explicitly. Promotion criteria are written down before the review, and
"a human verified it against real software" is a hard requirement. If
the evidence isn't there, the rail stays opt-in — that is a fine
steady state, not a failure.

## Definition of done

Two bsv-pay instances can complete an identity-key payment end-to-end in
CI with no address polling involved; a policy denylist naming an identity
key provably blocks paying it (ledgered); address mode is byte-identical
throughout; and nothing from Phases 1–2 has regressed.

## Out of scope

Auto-detection of installed wallets for any behavioral change; making
identity mode the default (that is M16's question, answered by evidence);
tokens/ordinals, DeFi, GUI, multi-chain — unchanged from Phase 2.
