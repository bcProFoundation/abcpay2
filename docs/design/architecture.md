# L2 wallet-service architecture

Status: design · Applies to: CWS (Chronik Wallet Service) · Related: [README](README.md)

## Purpose

Turn CWS from a *server-assisted wallet API* into a **wallet-service node** in a
network of interchangeable nodes:

- The **client** holds keys, decides intent, verifies, signs, broadcasts (or asks a
  node to relay a fully signed raw tx to Chronik).
- The **node** coordinates (proposal delivery, notifications), relays (encrypted
  envelopes, PSBTs), and caches (testnet-grade convenience) — but is *not* trusted
  for custody or correctness.
- The **chain** (eCash + Chronik) is the source of truth: balances, history, token
  state, finality.

Anyone can run a node (merchant, community member, power user). Clients choose their
node (`VITE_API_URL` / server setting today; discovery + health checks later) and can
switch without migrating funds, because funds never live in the node.

## Non-goals

- **No custody, ever.** No private keys, no mnemonics, no signing on the node.
- **No strong anonymity claims.** This design provides unlinkability heuristics and
  intent privacy, not anonymity. Chaumian mints / zk systems are out of scope here
  and would be separate designs with explicit trust models.
- **No mixing pools** in this phase (PayJoin is the only on-chain privacy feature).
- **No breaking changes** to the BWS-compatible contract.

## Roles and trust model

| Actor | Holds | Can it steal funds? | What the client must verify |
|---|---|---|---|
| Client (web/native) | Keys, intent | — | Everything it signs (see [client-verification.md](client-verification.md)) |
| Node (CWS) | Routing metadata, opaque payloads | **No** (never sees keys; cannot forge signatures) | Proposal correctness; capability claims; retention policy |
| Other copayers (multisig) | Their keys, their signatures | Not below the m-of-n threshold | Signatures are on-chain verifiable |
| Chronik / chain | Ledger data | No | Node responses can be cross-checked against any Chronik instance |
| Relay observer | IP, timing, routing metadata | No | Choose/self-host node; Tor; minimal retention |

Node failure modes and consequences:

- **Lies about UTXOs/fees/history** → client verification (P0) rejects or corrects.
- **Censors/delays** → availability issue only; the client can broadcast raw txs
  through any Chronik or node; funds are never at risk.
- **Reads envelope contents** → impossible by design (E2E encrypted to recipient).
- **Leaks metadata (who talks to whom, when)** → mitigated by self-hosting, Tor, and
  short retention; documented as an explicit residual risk.

## Threat model (who we defend against)

| Adversary | Defended by |
|---|---|
| Malicious or compromised node | [client-verification.md](client-verification.md), [psbt.md](psbt.md) |
| Passive chain analyst | [payjoin.md](payjoin.md) (heuristic break); wallet hygiene (fresh change, no address reuse) |
| Malicious counterparty | PayJoin sender/receiver verification rules; signed payment requests |
| Network/relay observer | E2E-encrypted envelopes ([payment-requests.md](payment-requests.md)); self-hosting; Tor (roadmap) |
| Spammer / DoS | Authenticated requests, quotas, paid envelopes (anti-spam below) |
| Device thief | Out of scope here (wallet encryption at rest is a separate workstream) |

## Wire surface and versioning

- New features live under **`/v5/...`** (e.g. `/v5/node-info`, `/v5/psbt/`,
  `/v5/envelopes/`). The existing `/cws/api` + `/bws/api` alias routes remain
  byte-compatible for current clients.
- **Capability discovery**: `GET /v5/node-info` returns a static, cacheable document:

```json
{
  "name": "cws",
  "version": "0.3.0",
  "chain": ["XEC", "DOGE"],
  "features": {
    "notifications": true,
    "psbt": true,
    "envelopes": true,
    "payjoin": "single-sig",
    "paidEnvelopes": false
  },
  "limits": { "maxEnvelopeBytes": 16384, "envelopeTtlSeconds": 604800, "envelopesPerHour": 60 }
}
```

- Feature flags are per node; clients must degrade gracefully when a capability is
  missing (fall back to the current proposal flow).

## Anti-spam (pay-to-write)

MVP (no new payment flow):

- Every envelope/PSBT request is already authenticated (`x-identity`/`x-signature`).
- Per-identity rate limits and quotas (messages/hour, bytes stored, envelopes in
  flight), enforced by the node and advertised in `node-info.limits`.
- TTL + ack-based deletion bound storage.

Phase 2 (CashWeb/Stamp pattern): **paid envelopes** — the sender attaches a tiny XEC
payment (a "stamp") to the node's deposit address before the node accepts beyond the
free quota. Notes:

- Pay-to-write must not create a new linkage: use **one-time deposit addresses** and
  never reuse them across identities; do not tie the stamp to the recipient publicly.
- Alternative to research: blinded credits / session keys (Chaumian), so the node
  cannot correlate stamp payers with envelope senders.
- Fee policy is per node and advertised; self-hosted nodes can disable stamps.

## Metadata and logging policy

- The node stores only: recipient identity key (opaque), TTL, size, timestamps, and
  the encrypted blob. Payload contents are never logged.
- Access logs are minimal by default (no envelope bodies, no wallet contents in
  errors); operators can configure retention.
- Documented residual risk: an observer at the node sees *that* identity A sent a
  message of size N to identity B at time T — not what it said.

## Claims and evidence

What this design lets us say, and what it does not:

| Claim | Evidence status |
|---|---|
| "The node cannot steal your funds." | Provable by protocol: keys stay client-side; client verifies what it signs (once P0 lands) |
| "PayJoin breaks the common-input-ownership heuristic for that transaction." | Measured per tx; depends on counterparty cooperation and wallet behavior (see [payjoin.md](payjoin.md)) |
| "Payment requests hide payment intent off-chain." | True by construction (E2E encrypted), with the metadata caveat above |
| "Privacy by scaling / escrowed bearer scripts give anonymity." | **Not claimed.** A fresh on-chain escrow publicly links funder → escrow → redeemer; bearer-script stashes only help with a large homogeneous pre-funded pool and bring theft/lockup risks (see appendix) |

## Appendix — why not "privacy through escrow" as envisioned in the article

The circulating "scale ⇒ privacy" proposal (escrow → off-chain redeem-script handover →
dispersion) does not achieve sender↔recipient unlinkability as described:

1. Funding (sender → escrow) and redemption (escrow → recipient) are both public and
   reference the **same UTXO**, so the link is trivially visible to any observer; the
   off-chain handover hides *knowledge of the release condition*, not the value flow.
2. Dispersion only frustrates post-redemption clustering of the recipient's coins.
3. It becomes unlinkable only in a different model: a large pool of **pre-funded,
   homogeneous bearer scripts** created before recipients exist (a real anonymity set).
   That model is a bearer-instrument design with its own costs: locked capital, script
   theft = lost funds, no recovery/dispute path, and it still benefits from
   blinding/pooling for genuine anonymity.

Useful parts worth shipping as *products* (not as privacy): conditional transfers,
vouchers/claim links, and timelocked vaults for safety (recovery, spending limits) —
enforceable on-chain with eCash's script introspection. Label them as such.

## Watchlist — shielded pools and L1 metaprotocols

The Sept 2026 **Shielded Bitcoin** proposal ([[alloc] init]) revives Zcash-style
shielded pools as a **Bitcoin L1 metaprotocol**: encrypted notes, nullifiers and
zero-knowledge proofs published in Bitcoin transactions, with independent **indexers**
verifying proofs and maintaining note/nullifier sets. Bitcoin only orders and stores
data; no soft fork, no federation, no separate chain (~700 vB per shielded transfer).

Why it is on our watchlist and not on the roadmap:

- **Not usable yet**: the paper covers in-pool transfers only. Peg-in/peg-out depends
  on PIPEs v2 / witness encryption, which is experimental (ciphertexts recently down
  from ~300 TB to ~8 TB) with no launch date.
- **Boundary privacy is explicitly not claimed**: deposits/withdrawals are public and
  linkable by amount/timing. That is exactly the layer PayJoin and wallet hygiene
  address today.
- **Bootstrapping problem**: a new pool starts with an anonymity set of ~1; the paper
  itself warns that large deposits do not create a large set on their own.
- **Trusted setup** (Groth16) and open questions on quantum resistance.
- **BTC only**, tokens and multisig are not covered (shielded multisig/threshold
  proofs remain a hard, separate problem).

Implications if something like this ships (on Bitcoin or an eCash equivalent):

1. **"Chain is the source of truth" gets a nuance**: for metaprotocols the source of
   truth is *the spec plus independently verifiable indexers*. Indexer divergence and
   liveness become new failure modes to design for; our nodes could themselves run
   indexer + relay roles, which fits the L2 architecture.
2. **PSBT needs shielded extensions** (shielded inputs/outputs are not BIP174-standard)
   and client verification needs viewing keys plus proof generation (WASM-class work
   for the web client) — a significant client-side surface.
3. **Notifications would need note scanning** (viewing keys) instead of address
   watching; the chain watcher design extends naturally but is not sufficient.
4. **Transparent flows remain essential** for tokens, multisig, exchange compatibility,
   and the boundaries themselves. PayJoin, PSBT verification, and the envelope channel
   keep their value in every scenario; CashFusion is the eCash-side provenance tool
   already live for XEC (and starting for ALP tokens).

Decision: do not couple the L2 roadmap to shielded-pool timelines. Revisit when a peg
ships, when eCash adopts an equivalent, or when the ecosystem standardizes an indexer
spec we can implement.

## Open questions

1. Node discovery: static list, CashWeb-style registry, or client-config only?
2. Paid envelopes: plain stamps vs blinded credits; per-node pricing floors.
3. Tor/onion support requirements for the relay endpoints and SSE.
4. Multi-node consistency: how clients detect a node serving stale/forked data
   (checkpoint comparison against a second Chronik instance?).
5. Retention defaults and operator guidance for legal exposure (GDPR-style deletion
   of routing metadata on ack/TTL).

## Acceptance criteria (architecture)

- [ ] `/v5/node-info` exists, is cacheable, and matches the documented shape.
- [ ] `docs/design/*` are referenced from the root README.
- [ ] Envelope payloads are never readable by the node (verified by test: node DB
      contains only ciphertext for a request/receipt round-trip).
- [ ] A self-hosting guide lets a third party run a node and complete a request +
      receipt + PayJoin round on mainnet.
