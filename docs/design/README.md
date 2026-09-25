# ABCPAY v2 — L2 wallet-service design docs

Chronik Wallet Service (CWS) is evolving from a BWS-compatible wallet API into an **L2
wallet-service node**: a coordination/relay/index layer that never holds keys, that a
client can independently verify against the chain, and that anyone can self-host.

These docs are written **before implementation**. Each one ends with acceptance
criteria and a test plan; implementation lands as separate PRs in the order below.

| # | Doc | Scope | Status | Depends on |
|---|-----|-------|--------|------------|
| 0 | [architecture.md](architecture.md) | Node roles, trust & threat model, wire versioning, anti-spam, honest privacy claims | design | — |
| 1 | [client-verification.md](client-verification.md) | P0: the client verifies proposals instead of trusting the node | design | 0 |
| 2 | [psbt.md](psbt.md) | P1: BIP174 PSBT subset as the proposal/envelope format (tokens included) | design | 0, 1 |
| 3 | [payment-requests.md](payment-requests.md) | Encrypted envelopes over the relay: payment requests, receipts, invites (the #3 workstream) | design | 0, 1, 2 |
| 4 | [payjoin.md](payjoin.md) | PayJoin over the PSBT channel (the #2 workstream), single-sig first | design | 0–3 |
| 5 | [cashfusion-vs-payjoin.md](cashfusion-vs-payjoin.md) | Comparison and complementarity of the two transparent-chain privacy tools | design | 0, 4 |

## Why this order

- **Verification first**: today the node builds proposals and the client signs them. Until
  the client derives its intent itself and checks the built transaction, "trustless"
  is a claim, not a property — and every later feature (PSBT, PayJoin) inherits the gap.
- **PSBT second**: one standard envelope unlocks offline/hardware signers, multi-party
  rounds, and PayJoin without inventing a format.
- **Envelopes third**: the encrypted relay channel is immediately useful (requests,
  receipts, invites) and is the transport PayJoin needs to be both usable and private.
- **PayJoin fourth**: the only per-transaction privacy win we can measure — build it on
  top of a channel that already keeps the node blind.

## Related reading

- [architecture.md § Watchlist](architecture.md#watchlist--shielded-pools-and-l1-metaprotocols)
  covers the Sept 2026 "Shielded Bitcoin" proposal and why it is not on the roadmap.
- [cashfusion-vs-payjoin.md](cashfusion-vs-payjoin.md) explains how the two
  transparent-chain privacy tools complement each other.

## Ground rules used across the docs

1. **Chain is the source of truth.** The node never holds keys, never signs, and never
   needs to be trusted for custody.
2. **Blind relay.** Payloads are end-to-end encrypted between wallets; the node stores
   opaque blobs plus the minimum routing metadata (recipient identity, expiry).
3. **Honest claims.** No feature in this set provides anonymity. We document what each
   one provably does and what it does not (see [architecture.md](architecture.md#claims-and-evidence)).
4. **Versioned surface.** New work uses `/v5/...`. The BWS-compatible routes
   (`/v3/`, `/v4/`, `/v1/...`) keep working unchanged for existing clients.
5. **Graceful degradation.** Capability discovery (`GET /v5/node-info`) lets clients use
   new features when the node supports them and fall back to today's flow otherwise.
