# ABCPAY v2 — L2 wallet-service design docs

Chronik Wallet Service (CWS) is evolving from a BWS-compatible wallet API into an **L2
wallet-service node**: a coordination/relay/index layer that never holds keys, that a
client can independently verify against the chain, and that anyone can self-host.

These docs are written **before implementation**. Each one ends with acceptance
criteria and a test plan; implementation lands as separate PRs in the order below.

| # | Doc | Scope | Status | Depends on |
|---|-----|-------|--------|------------|
| 0 | [architecture.md](architecture.md) | Node roles, ground rules, trust & threat model, v5 auth contract, schema/migrations, wire versioning, anti-spam, honest privacy claims | design | — |
| 1 | [client-verification.md](client-verification.md) | P0: the client verifies proposals instead of trusting the node | design | 0 |
| 2 | [psbt.md](psbt.md) | P1: BIP174 PSBT v0 (wire format verified against `ecash-lib@4.14.1`) as the proposal/envelope format | design | 0, 1 |
| 3 | [payment-requests.md](payment-requests.md) | Encrypted envelopes over the relay: payment requests, receipts, invites (the #3 workstream) | design | 0, 1, 2 |
| 4 | [payjoin.md](payjoin.md) | PayJoin over the PSBT channel (the #2 workstream), single-sig + XEC-only MVP | design | 0–3 |
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

- [architecture.md § Ground rules](architecture.md#ground-rules) is the canonical list of
  constraints every doc here obeys (chain is source of truth, blind relay, off-chain
  coordination rather than a rollup, no new crypto for funds plus a review gate for the
  envelope channel, additive versioning, graceful degradation).
- [architecture.md § v5 auth contract](architecture.md#v5-auth-contract) and
  [§ schema and migrations](architecture.md#schema-and-migrations) cover how identities,
  envelopes, and PSBT storage land additively.
- [architecture.md § Watchlist](architecture.md#watchlist--shielded-pools-and-l1-metaprotocols)
  covers the Sept 2026 "Shielded Bitcoin" proposal and why it is not on the roadmap.
- [cashfusion-vs-payjoin.md](cashfusion-vs-payjoin.md) explains how the two
  transparent-chain privacy tools complement each other.
