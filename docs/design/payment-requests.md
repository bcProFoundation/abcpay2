# Encrypted envelopes: payment requests, receipts, invites (workstream #3)

Status: design · Depends on: [architecture.md](architecture.md),
[client-verification.md](client-verification.md), [psbt.md](psbt.md) · Next:
[payjoin.md](payjoin.md)

## Purpose

A store-and-forward, **end-to-end encrypted** channel between wallets, operated by any
CWS node as a **blind relay**. It replaces "send me your address out of band" flows and
provides the transport for PSBT exchange and PayJoin.

Immediate use cases:

1. **Payment request** — "pay me 12.5 XEC / 100 TESTA" with an expiry and a fresh
   receive address; the payer sees a verified request instead of pasting a QR.
2. **Payment receipt** — after broadcast, the payer sends a signed receipt (txid +
   proposal ref) so the requester's wallet can reconcile the request without polling.
   The receipt is a notification; the requester still checks the txid on-chain before
   marking the request paid.
3. **Wallet invite** — join links for multisig wallets delivered to a specific
   copayer identity.
4. **PSBT exchange** — the substrate for [payjoin.md](payjoin.md); also enables offline
   co-signing (deliver a PSBT to a copayer's device).
5. **Encrypted memo** — an optional message attached to a payment (shown in history
   when present).

## Identities and keys

- **Identity model (decided): per-copayer.** An *envelope identity* is a secp256k1 keypair
  derived from one copayer key's mnemonic at a dedicated branch, e.g. `m/2'/0` (new
  branch; the frozen send/receive/request paths are untouched). A single-sig wallet
  therefore has exactly one identity; an m-of-n wallet has one per copayer; two devices
  restoring the same copayer key derive the same identity (multi-device), while two
  copayers of the same wallet never share key material. This keeps "who can read this
  envelope" answerable without a wallet-level shared secret.
- **Auth identity** (existing): `requestPubKey` (`m/1'/0`) already signs node requests;
  envelope **authenticity** is signed with it, so the node can verify the author, and so
  can the recipient.
- **Registry**: identities live in a new `identities` table, not only as `copayers` rows.
  Reason: an envelope peer is often *not* a copayer of the wallet you are talking to — a
  payer, a merchant, or a PayJoin receiver may hold no wallet row on this node at all,
  while today's `x-identity` auth resolves exclusively through `copayers` (see
  [architecture.md § v5 auth contract](architecture.md#v5-auth-contract)). Wallet
  create/join registers an identity as a side effect (additive columns on `copayers`);
  standalone self-registration is a rate-limited phase-2 route.
- **Encryption**: ECDH on secp256k1 between the sender's envelope key and the recipient's
  **encryption pubkey**, then HKDF-SHA256 → AEAD. `info` binds
  `"abcpay-envelope-v1" ‖ alg ‖ from ‖ to ‖ id ‖ type` (domain separation, so a key
  derived for one envelope cannot be reused for another purpose), and the canonical
  header bytes are passed as **AEAD associated data (AAD)** — a tampered `to`, `id`,
  `type`, or `expiresAt` fails authentication instead of being silently decrypted with
  swapped routing. `alg` field allows agility (AES-256-GCM, 12-byte IV, or
  XChaCha20-Poly1305, 24-byte IV; the length is determined by `alg`, not guessed).
  Nothing is encrypted *to* the node.
- **Discovery**: `GET /v5/identities/:identity` returns
  `{ requestPubKey, encryptionPubKey, walletIds? }` for a registered identity; a signed
  request is required so the node cannot be used as an unauthenticated directory dump.
- **Rotation**: identities are per-device-restorable (mnemonic); document a "revoke +
  re-announce" flow for compromised devices (wallet remains safe — envelope keys never
  control funds).

## Envelope wire format

JSON body, size-capped (see **Size classes** below; both limits are advertised in
`node-info.limits`):

```json
{
  "v": 1,
  "id": "b7c1…",
  "type": "payment_request",
  "from": "<envelope identity pubkey>",
  "to": "<recipient envelope identity pubkey>",
  "createdAt": 1758100000,
  "expiresAt": 1758704800,
  "enc": {
    "alg": "secp256k1-ecdh-hkdf-aes256gcm",
    "epk": "<33-byte ephemeral pubkey>",
    "iv": "<12 bytes for AES-GCM, 24 for XChaCha20>",
    "ct": "<ciphertext with appended 16-byte tag>"
  },
  "sig": "<hex DER ECDSA signature over the canonical header>"
}
```

**Canonical header and signature (normative).** The signed message is the header
serialized as **UTF-8 JSON with exactly the key order shown above, no whitespace, no
trailing newline**: `{"v":…,"id":…,"type":…,"from":…,"to":…,"createdAt":…,"expiresAt":…,"enc":{...}}`
with `enc` sub-object in the order `alg, epk, iv, ct`. Integers are decimal numbers, all
hex is lowercase, and no field may be omitted, null, or reordered. The signature is made
with the primitives already in `abcpay-wallet-core/src/auth.ts` — ECDSA secp256k1 over
`hash256(utf8(canonicalHeader))`, serialized as DERSig hex (`signMessage` /
`verifyMessage`) — so there is no second signature convention in the codebase. The same
canonical header bytes are the AEAD **AAD**; the recipient verifies `sig` **before**
decrypting, and decryption fails if any header byte changed.

**Size classes.** base64 is ~1.33× the raw PSBT, and multisig + proprietary token pairs
make PSBTs large, so one flat cap does not work:

| Class | Types | Limit (default) |
|---|---|---|
| `message` | `payment_request`, `payment_receipt`, `wallet_invite`, `memo` | 16 KiB |
| `psbt` | `psbt`, `psbt_bundle` | 64 KiB |

Oversize bodies are rejected with 413 and the effective limit; stored bytes are counted
against per-identity and node-wide quotas.

Plaintext payloads by `type` (decrypted only by the recipient):

```json
// payment_request
{
  "coin": "xec",
  "network": "livenet",
  "address": "ecash:q…",        // fresh receive address of the requester
  "amount": 1250,                // sats, or null for "any amount"
  "tokenId": null, "atoms": null, // token requests use these instead of amount
  "memo": "Lunch",
  "expiresAt": 1758704800,
  "requestId": "9f2…"            // idempotency / receipt correlation
}

// payment_receipt
{
  "requestId": "9f2…",
  "txid": "<64 hex>",
  "proposalId": "…",             // when known
  "paidAt": 1758100123,
  "coin": "xec"
}

// wallet_invite
{ "walletId": "…", "coin": "xec", "name": "Shared wallet", "copayerId": "…", "secret": "…" }

// psbt / psbt_bundle  (see psbt.md)
{ "proposalId": "…", "psbt": "<base64>", "round": 1, "expect": "signature" }
```

Rules:

- The node stores `{ to, from, expiresAt, size, blob }` plus timestamps — routing
  metadata, never plaintext. `from` is recorded because the sender's signature verifies
  against their registered `requestPubKey`; this is a deliberate metadata tradeoff
  (attribution enables per-sender rate limits and abuse bans; it also means the node
  operator sees both ends — see Privacy analysis).
- Replay protection: unique `id` (UUIDv7), TTL, dedupe on insert; recipients ack to
  delete.
- Signatures make authors accountable even to a third party (the node can rate-limit
  per identity and ban abusive ones without reading content).

## Relay API (`/v5/envelopes/`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v5/envelopes/` | Store an envelope for a recipient (auth + quota + size class) |
| GET | `/v5/envelopes/?since=` | Poll pending envelopes (auth as recipient) |
| POST | `/v5/envelopes/:id/ack` | Delete after processing |
| POST | `/v5/identities/` | Self-registration of an envelope identity (phase 2, strictly rate-limited) |
| GET | `/v5/identities/:identity` | Key discovery for a registered identity (signed request) |
| GET | `/v5/notifications/` (SSE) | New event `envelope.received` with `{ id, type }` (no content) |

- **Blindness test** (acceptance): after a request + receipt round-trip, the node's
  database contains no readable request/receipt fields.
- Storage: Postgres table `envelopes(id, recipient_identity, sender_identity, type_tag,
  blob, size, created_at, expires_at, acked_at)`; a sweeper deletes expired rows.
  `type_tag` is needed for SSE event hints; it is metadata, documented. Full column
  definitions in [architecture.md § schema and migrations](architecture.md#schema-and-migrations).
- Quotas: `maxEnvelopeBytes` + `maxPsbtEnvelopeBytes`, `maxPendingPerIdentity`,
  `envelopesPerHour`, and a **node-wide** `maxPendingTotal`, all advertised in
  `node-info.limits` and enforced per authenticated identity **and** per source IP —
  identity-only limits are not enough while wallet creation is public
  ([architecture.md § Anti-spam](architecture.md#anti-spam-pay-to-write)).
- Anti-spam phase 2: paid envelopes/stamps — see
  [architecture.md](architecture.md#anti-spam-pay-to-write).

## Flows

**Request → pay → receipt**

1. Requester picks a fresh receive address (derived locally), builds a
   `payment_request`, encrypts to the payer's identity, posts it.
2. Payer's app receives `envelope.received` over SSE, fetches, decrypts, verifies:
   signature, AAD, `expiresAt`, address format, amount; shows a confirm screen (uses
   [client-verification.md](client-verification.md) on the resulting proposal).
3. Payer signs/broadcasts (single-sig or multisig proposal as today, with the request's
   address as recipient; the address is not reused after payment).
4. Payer posts a `payment_receipt` (signed, encrypted) to the requester.
5. Requester's app matches `requestId` and then **verifies the claim on-chain** before
   marking anything paid: fetch the txid from Chronik and require that it pays the
   request's fresh address the requested amount (and `tokenId`/`atoms` for token
   requests). Outcomes: `paid` (verified), `claimed — unconfirmed` (txid not indexed yet;
   the existing chain watcher confirms it later), or `rejected` (txid does not pay this
   request — surface it, never mark paid). A receipt is a notification, **not** proof;
   the on-chain check is what makes it one.

**Request without CWS on the payer side**: the requester can always fall back to a QR
code / URI (the URI can encode `requestId` + address), so the feature degrades to
today's UX.

**Invites**: the shared link/QR carries only a **non-secret handle** —
`{ walletId, copayerId }` — and the join secret travels *inside* the encrypted
`wallet_invite` envelope addressed to the recipient's identity. Reason: secrets in URLs
leak through browser history, `Referrer` headers, proxy/server logs, screenshots, and
clipboard managers, and an invite link is exactly the kind of artifact people paste into
chat apps. A handle-only link means a leaked link reveals nothing and cannot be replayed
to join. If a secret-bearing link must be supported for legacy QR compatibility, treat
the secret as single-use, rotate it immediately after a successful join, and serve the
page with `Referrer-Policy: no-referrer`.

## Privacy analysis (honest)

- **Provides**: payment intent and memo confidentiality; no on-chain invoice
  fingerprint; fresh addresses per request reduce reuse; invites don't leak via QR
  screenshots *or* shared links (the link carries no secret).
- **Does not provide**: on-chain graph privacy (a settled payment still links payer and
  requester addresses on-chain); metadata privacy against the node operator (who sees
  identity pairs — including the sender, because the node verifies its signature —
  plus sizes and timings). Mitigated by self-hosting/Tor and TTL cleanup, not
  eliminated; a paid/blinded-stamp scheme is the phase-2 answer
  ([architecture.md § Anti-spam](architecture.md#anti-spam-pay-to-write)).
- **Recommendation**: treat envelope keys and content as private but assume routing
  metadata is visible to the operator and to a global passive adversary.

## Test plan

Unit (`wallet-core` / `abcpay-api`):

- Crypto round-trip (encrypt/decrypt, tamper → auth failure), **AAD tampering** (change
  `to`/`id`/`type`/`expiresAt` after encryption → decryption fails), canonical signature
  verification with byte-exact fixtures (field order/whitespace/case variants must fail),
  replay/dedupe, TTL expiry, quota enforcement, size limits (16 KiB message accepted,
  64 KiB PSBT accepted, over-limit → 413).
- Identity derivation vectors (mnemonic → envelope key) with fixtures, including the
  per-copayer rule (two copayers → two identities; same copayer restored → same identity).
- Receipt reconciliation: a receipt whose `txid` does not pay the request is rejected; a
  receipt for an unindexed txid stays `claimed — unconfirmed`.

E2E (Pi harness):

- Two fixture wallets: request → SSE delivery → decrypt → pay (existing send flow) →
  receipt → requester verifies on-chain and marks paid. Assert node DB holds only
  ciphertext.
- Token request variant (`tokenId`/`atoms`) settles through the token send path.
- Expired envelope is not delivered and is swept.
- Rate limit: N+1 requests → 429 with `Retry-After`; node-wide pending cap → 503/429;
  IP cap against a fresh-identity burst (Sybil simulation).

## Acceptance criteria

- [ ] Envelope CRUD + SSE + ack + TTL sweep implemented under `/v5/envelopes/`.
- [ ] E2E request/receipt round-trip on the Pi with ciphertext-only storage proven, and
      a receipt is only marked paid after an on-chain check of the txid.
- [ ] Header AAD binding and canonical signature vectors implemented and tested.
- [ ] Quotas and size limits (16 KiB message / 64 KiB PSBT, per-identity + node-wide)
      enforced and advertised in `node-info`.
- [ ] Invite links contain no secret; joining requires the decrypted envelope.
- [ ] QR fallback path still works for requesters without CWS.
- [ ] No envelope content in logs (test asserts log-line absence).

## Resolved decisions

- **Receipts** (was open question 2): off-chain signed receipts are the MVP, and they are
  treated as *notifications*, not proof — the requester must verify the txid on-chain
  before marking a request paid. On-chain eMPP receipts are deferred (they cost
  dust + fee per payment); if they ever ship, they are an additional signal, not a
  replacement for the chain check.
- **Identity model**: per-copayer (above), with a shared `identities` registry so
  non-copayer peers (payers, PayJoin receivers) can participate.

## Open questions

1. Envelope branch choice (`m/2'/0`) — confirm no legacy convention collides.
2. Group envelopes (wallet-wide notifications to all copayers) — N envelopes vs a
   per-wallet identity. Defer.
3. Push notifications on native builds (FCM/APNs) vs SSE-only; affects TTL defaults.
4. Sender attribution vs metadata privacy: the MVP records and verifies `from` so the
   node can rate-limit per sender. If that is judged too leaky for real deployments, the
   fallback is unauthenticated-by-default envelopes (relay-only, no sender rate limiting)
   or paid stamps/blinded credits. Decide with the phase-2 anti-spam work.
