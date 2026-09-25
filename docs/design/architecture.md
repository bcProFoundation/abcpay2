# L2 wallet-service architecture

Status: design · Applies to: CWS (Chronik Wallet Service) · Related: [README](README.md)

## Purpose

Turn CWS from a *server-assisted wallet API* into a **wallet-service node** in a
network of interchangeable nodes:

- The **client** holds keys, decides intent, verifies, signs, and broadcasts — by
  default **directly to Chronik** (or any compatible node). A node relay
  (`/v5/psbt/:id/relay`) exists only as a fallback for clients whose network blocks
  direct broadcast.
- The **node** coordinates (proposal delivery, notifications), relays (encrypted
  envelopes, PSBTs), and caches (testnet-grade convenience) — but is *not* trusted
  for custody or correctness.
- The **chain** (eCash + Chronik) is the source of truth: balances, history, token
  state, finality.

CWS is an **off-chain coordination and relay layer**. It is not a rollup, not a
zk-L2, and introduces no on-chain state machine, no fraud proofs, and no consensus
rules: every settlement is an ordinary eCash transaction, and the security argument is
"the client verifies, the chain settles", not "the node's state is provable".

Anyone can run a node (merchant, community member, power user). Clients choose their
node (`VITE_API_URL` / server setting today; discovery + health checks later) and can
switch without migrating funds, because funds never live in the node.

## Ground rules

These bind every doc in this set (and are enforced in review):

1. **Chain is the source of truth.** The node never holds keys, never signs, and never
   needs to be trusted for custody or correctness. Off-chain state is a cache or a
   coordination hint; disagreement is resolved by the chain.
2. **Client verifies, node coordinates.** Anything a client signs or pays is checked
   against local intent and the chain first ([client-verification.md](client-verification.md)).
   A node that lies loses traffic, not funds.
3. **Blind relay.** Payloads are end-to-end encrypted between wallets; the node stores
   opaque blobs plus the minimum routing metadata (recipient identity, sender identity,
   expiry, size, timestamps).
4. **Off-chain coordination, not a rollup.** No on-chain state machine, no proofs, no
   consensus changes. Do not describe CWS as an L2 in the zk/rollup sense — it is a
   wallet-service node layer over ordinary eCash transactions.
5. **No new cryptography for funds, and a review gate for new crypto elsewhere.**
   Transaction signing stays exactly what it is today: ECDSA secp256k1 with
   `SIGHASH_ALL|FORKID`, and PSBT is a pure container ([psbt.md](psbt.md)). The
   envelope channel is the one place this set *composes* new crypto (ECDH-secp256k1 +
   HKDF-SHA256 + AEAD, with AAD binding and an explicit `alg`): standard primitives,
   but a real construction, so it requires an **external cryptographic review** before
   any production deployment, and it never touches key material that controls funds.
6. **Versioned, additive surface.** New work lives under `/v5/...`; the BWS-compatible
   routes keep working byte-for-byte for existing clients. New fields are optional, new
   tables/columns are additive, migrations are reversible by ignoring them.
7. **Graceful degradation.** Capability discovery (`GET /v5/node-info`) lets clients use
   a feature when the node supports it and fall back to today's flow otherwise; a
   missing capability is a fallback, never a hard error.
8. **Honest claims.** No feature in this set provides anonymity. Each doc states what it
   provably does and what it does not, and marketing language ("private", "trustless",
   "untraceable") is not allowed to outrun the evidence — see
   [Claims and evidence](#claims-and-evidence).

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
  "limits": {
    "maxEnvelopeBytes": 16384,
    "maxPsbtEnvelopeBytes": 65536,
    "envelopeTtlSeconds": 604800,
    "envelopesPerHour": 60,
    "maxPendingPerIdentity": 200,
    "maxPendingTotal": 10000
  }
}
```

- Feature flags are per node; clients must degrade gracefully when a capability is
  missing (fall back to the current proposal flow).

## v5 auth contract

**What exists today.** `apps/abcpay-api/src/middleware/auth.ts` authenticates every
non-public route with `x-identity` + `x-signature`, verifies
`hash256(utf8("<method>|<path>|<body>"))` against the `copayers.requestPubKey` row whose
`copayer_id = x-identity`, rejects a mismatched `x-copayer-id`/`x-wallet-id` claim, and
puts `copayerId` + `walletId` on the context. So today an identity *is* a copayer, and a
copayer belongs to exactly one wallet.

**Why v5 cannot just reuse that.** Three new cases break the assumption:

1. **Non-copayer identities.** Envelope senders/recipients and PayJoin counterparties are
   often not copayers of the wallet they interact with (a payer or merchant may hold no
   wallet row on this node). `x-identity` must resolve against a shared `identities`
   registry, with `copayers` as one registration path among others.
2. **Counterparty participation without membership.** A PayJoin receiver contributes
   inputs but is not a member of the sender's wallet, so it must not be able to use
   member-only routes. Conversely `/v5/psbt/:id/sign` must stay copayer-only
   ([psbt.md](psbt.md)).
3. **Replay resistance.** The current message has no timestamp or nonce, so a captured
   signed request is replayable verbatim within its route's lifetime.

**The v5 rules.**

- **Authentication** = signature over a versioned message:
  `v5|<method>|<path>|<ts>|<nonce>|<body>`, ECDSA over `hash256(utf8(...))`, DERSig hex
  (the same primitives as `abcpay-wallet-core/src/auth.ts`; no new signature scheme).
  The node rejects `ts` outside a bounded window (default ±300s) and replays a
  `(identity, nonce)` pair for longer than that window. `x-identity` must exist in
  `identities`; v1–v4 continue to accept `copayerId`s unchanged.
- **Authorization is per-route, never header-derived.** The `x-wallet-id` / `x-copayer-id`
  headers stay *consistency checks only* (reject on mismatch, as today) and are never the
  source of permission. Each `/v5` route resolves its own object: envelopes check
  `to == recipient identity` and the sender is a registered identity; PSBT routes load
  `tx_proposals.wallet_id` and require `copayers` membership; identity discovery
  requires a signed request.
- **401 vs 403**: missing/unknown identity or bad signature → 401; known identity, wrong
  membership or wrong recipient → 403. The error body never reveals whether an unrelated
  wallet or envelope id exists (enumeration hygiene).
- **Rate limits key on identity *and* source IP**, with a node-wide cap, because identity
  creation is currently free and public (see below). `Retry-After` on 429.
- **Body binding is byte-exact**: the signed body is the exact request body
  (re-serialized JSON from the cloned request, as today), never a re-ordered or
  whitespace-normalized copy; unknown fields are signed, so a node cannot strip a field
  the client believed it signed.
- **Envelope content authorization is the recipient's business**: the node must not be
  able to read, and a recipient must not be able to be impersonated by the node — the
  AEAD AAD + per-header signature
  ([payment-requests.md](payment-requests.md#envelope-wire-format)) is what enforces this,
  not a route check.
- **Capabilities, not assumptions**: every `/v5` route the client uses must appear in
  `node-info.features`, and the client must fall back when absent (e.g. no
  `/v5/psbt/:id/sign` → legacy proposal signing).

## Anti-spam (pay-to-write)

MVP (no new payment flow):

- Every envelope/PSBT request is already authenticated (`x-identity`/`x-signature`), but
  **authentication is not anti-spam by itself**: `POST /v1/wallets/` and
  `POST /v2/wallets/` are public in `auth.ts`, so anyone can mint unlimited identities
  and wallets for free and then spam at the per-identity limit. The MVP therefore also
  enforces:
  - Per-identity **and** per-IP rate limits (messages/hour, bytes stored, envelopes in
    flight), plus a node-wide pending cap, all advertised in `node-info.limits`.
  - Creation throttling: per-IP wallet-creation budget and a global cap, with 429 +
    `Retry-After`; optionally an invite/paid-creation tier.
  - A cheap proof-of-cost for the free tier (see phase 2) so identity churn is not free.
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
   live for XEC fusion, with ALP-token fusion reported as in progress by the eCash
   project (not implemented or verified in our stack).

Decision: do not couple the L2 roadmap to shielded-pool timelines. Revisit when a peg
ships, when eCash adopts an equivalent, or when the ecosystem standardizes an indexer
spec we can implement.

## Schema and migrations

Current state (`apps/abcpay-api/src/db/schema.ts`): `copayers` has
`copayer_id`/`wallet_id`/`x_pub_key`/`request_pub_key` and **no** envelope fields;
`tx_proposals` has `raw`/`txid`/`signatures` and **no** PSBT column; there is no
`identities` or `envelopes` table. Everything below is **additive** — new tables, new
nullable columns, constant defaults — so existing rows, existing clients, and the
current e2e fixtures keep working untouched.

| # | Migration | Change | Notes |
|---|---|---|---|
| 001 | `identities` | new table: `id uuid pk`, `identity_key varchar(66) unique`, `request_pub_key text`, `encryption_pub_key text`, `kind varchar(16) default 'copayer'`, `label`, `created_at`, `last_seen_at` | one row per envelope identity (per-copayer rule); `kind` separates `copayer` from standalone/self-registered |
| 002 | `copayers` envelope keys | add `copayers.envelope_identity varchar(66) null`, `copayers.encryption_pub_key text null` | nullable → no rewrite; the copayer's app registers/announces lazily (on first authenticated request or first discovery call), so no backfill job is required |
| 003 | `envelopes` | new table: `id uuid pk`, `envelope_id varchar(64) unique`, `recipient_identity varchar(66)`, `sender_identity varchar(66) null`, `type_tag varchar(32)`, `blob text`, `size integer`, `created_at`, `expires_at`, `acked_at` | indexes on `(recipient_identity, created_at)` and `(expires_at)`; `blob` is ciphertext only; sweeper deletes expired/acked rows |
| 004 | `tx_proposals` PSBT | add `psbt text null` (base64), `psbt_sha256 varchar(64) null`, `format varchar(16) not null default 'json'` | `format` stays `json` for existing rows; `psbt` is the additive API field; the sha256 pins byte-identity between the stored blob and what clients assemble |

Rules for this set:

- **No destructive migration.** Rollback = ignore the new columns, or drop the two new
  tables; no data rewrite is ever required to go back.
- **Order matters only for 001 → 002** (the copayer column points at a registered
  identity); 003 and 004 are independent.
- **Auth transition**: v1–v4 keep resolving `x-identity` through `copayers`; v5 resolves
  through `identities`, with a temporary compatibility lookup
  (`identities.identity_key = x-identity` **or** `copayers.copayer_id = x-identity`) so a
  client that has not registered its envelope identity yet still authenticates on legacy
  routes.
- **Staging/e2e**: apply all four on the Pi, re-run the 47-check staging e2e unchanged
  (additive = old flows unaffected), then add coverage for the new paths
  (`seed-staging-fixtures.cjs` gains an identity + envelope round-trip).
- **Drizzle** generates the SQL from the updated schema; migrations are committed with
  the code that uses them, never ahead of it.

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
- [ ] The v5 auth contract is implemented: timestamped/nonced signatures, per-route
      authorization that never trusts `x-wallet-id`, 401/403 separation, replay rejection,
      and identity + IP + node-wide rate limits — with v1–v4 behavior unchanged.
- [ ] All four migrations are additive and applied on staging; rollback (ignore columns,
      drop new tables) is tested, and the existing staging e2e passes unmodified.
- [ ] The envelope construction has an external cryptographic review on record before any
      production deployment (ground rule 5).
- [ ] A self-hosting guide lets a third party run a node and complete a request +
      receipt + PayJoin round on mainnet.
