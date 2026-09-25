# CashFusion vs PayJoin — overlap and roles

Status: design note · Depends on: [payjoin.md](payjoin.md) · Related:
[architecture.md](architecture.md)

Both are opt-in, transparent-chain (no consensus change) privacy tools, and both are
heuristics rather than anonymity guarantees. They are **complementary**: PayJoin
hardens the *payment*; CashFusion breaks the *provenance* of coins. Each fixes what the
other does not.

## Comparison

| Dimension | PayJoin (ours, via PSBT) | CashFusion (live on eCash since 2024; ALP fusion in progress) |
|---|---|---|
| Shape | 2-party collaborative payment; the receiver contributes input(s) | N-party fusion round; many wallets combine inputs and receive randomized/split outputs |
| Coordination | None; counterparty exchange over encrypted envelopes | None (serverless); peer discovery over Tor |
| Anonymity set needed | No crowd — the benefit is per-transaction, but the tx is *detectable as PayJoin* | Yes — needs other participants/round liquidity; privacy scales with round size |
| What it hides | Sender↔receiver link for that payment; the receiver's output/amount among their UTXOs; the sender's change unlinkability | History/provenance of the fused coins (breaks tainted-chain tracking, e.g. KYC withdrawal trails) |
| Effect on clustering | *Anti-clusters*: co-spent inputs have two owners (common-input-ownership heuristic broken) | *Over-clusters*: co-spend is explicitly many owners; output attribution becomes ambiguous |
| Durability of the gain | Fragile: known PayJoin fingerprints; undone by address reuse or merging change | Fragile differently: fusion peers see the fused tx, so privacy is vs third parties; undone if fused outputs are later merged or reused |
| Costs / UX | +1 input; receiver must hold a UTXO and support PayJoin; async is fine | Larger tx; wait for a round; Tor; fragmented outputs; post-fusion hygiene required |
| Failure mode | Counterparty declines/times out → fall back to a normal payment | No peers / round failure → nothing happens; no theft either way (atomic signing) |
| Token coverage | SLP/ALP supported under our accounting rules (token OP_RETURN untouched) | XEC today; ALP-token Fusion implementation started (eCash recap, July 2026) |
| Effort in our stack | Low–moderate: builds on PSBT + [client-verification.md](client-verification.md) + envelopes | High: fusion protocol engine, Tor, round scheduling, UTXO management |

## Where they overlap

- Both are **opt-in** and require wallet support on both sides.
- Both are **transparent-chain** (visible transactions, no new consensus).
- Both are **heuristic breaks**, not formal anonymity; both degrade with address reuse,
  UTXO merging, and timing/amount correlation.
- Both reveal that *something* privacy-oriented happened (a PayJoin-shaped tx, a fusion
  tx); neither hides anything from the counterparty, nor from network-level observers.

## How they compose

1. **Fuse** coins to break provenance (e.g. after a KYC on-ramp).
2. **PayJoin** the payment, so the merchant relationship is not a clean graph edge and
   the fused coin's ambiguous origin is preserved.
3. The receiver **fuses later**, so the payment does not seed a new traceable cluster.

Roles in practice:

- PayJoin = the **payment layer**: per-transaction, merchant-friendly, works for
  tokens, and (phase 2) multisig. Day-one privacy for every send when the counterparty
  supports it.
- CashFusion = the **provenance/storage layer**: batch-oriented, requires rounds and
  Tor, best for holdings and for breaking received history. It cannot replace PayJoin at
  the payment moment, and PayJoin cannot cleanse a coin's history.

## Coverage in our roadmap

- PayJoin: `payjoin.md`, single-sig first, on top of PSBT + envelopes; opt-in per send
  with automatic fallback.
- CashFusion: not implemented here; track it as an eCash ecosystem integration
  (Electrum ABC today; ALP token fusion per the July 2026 recap). If adopted, it is a
  wallet-level feature (round scheduling, Tor, UTXO manager) that coexists with the L2
  node — the node only relays/notifies, it never mixes funds.

## Caveats to keep honest

- Fusion rounds expose the participant set to each other; privacy is against outside
  observers.
- PayJoin's sender-side anonymity bump is small; the receiver-side gain is typically
  larger. Detectability is an arms race.
- Neither tool protects against counterparty knowledge, network metadata, or
  distinctive amounts/timing.
