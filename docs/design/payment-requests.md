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
   proposal ref) so the requester's wallet can mark the request paid without polling.
3. **Wallet invite** — join links for multisig wallets delivered to a specific
   copayer identity.
4. **PSBT exchange** — the substrate for [payjoin.md](payjoin.md); also enables offline
   co-signing (deliver a PSBT to a copayer's device).
5. **Encrypted memo** — an optional message attached to a payment (shown in history
   when present).

## Identities and keys

- **Envelope identity** = a secp256k1 keypair derived from the wallet mnemonic at a
  dedicated branch, e.g. `m/2'/0` (new branch; the frozen send/receive/request paths are
  untouched). Each copayer has their own identity (their own mnemonic), so multisig
  wallets have multiple addresses-identities — no shared secret material.
- **Auth identity** (existing): `requestPubKey` (`m/1'/0`) already signs node requests;
  envelope **authenticity** is signed with it (server can verify, recipients can too).
- **Encryption**: ECDH on secp256k1 between sender's envelope key and recipient's
  **encryption pubkey**, then HKDF-SHA256 → AES-256-GCM (or XChaCha20-Poly1305, chosen
  at implementation; `alg` field allows agility). Nothing is encrypted *to* the node.
- **Discovery**: `GET /v5/identities/:identity` returns
  `{ requestPubKey, encryptionPubKey, walletIds? }` for a signed request. Registration
  happens on wallet create/join (new optional fields on `copayers`, additive).
- **Rotation**: identities are per-device-restorable (mnemonic); document a "revoke +
  re-announce" flow for compromised devices (wallet remains safe — envelope keys never
  control funds).

## Envelope wire format

JSON body, size-capped (default 16 KiB, advertised in `node-info.limits`):

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
    "epk": "<ephemeral pubkey>",
    "iv": "<12–24 bytes>",
    "ct": "<ciphertext>"
  },
  "sig": "<requestPubKey signature over canonical(id,type,from,to,createdAt,expiresAt,enc)>"
}
```

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
{ "walletId": "…", "coin": "xec", "name": "Shared wallet", "secret": "…" }

// psbt / psbt_bundle  (see psbt.md)
{ "proposalId": "…", "psbt": "<base64>", "round": 1, "expect": "signature" }
```

Rules:

- The node stores `{ to, expiresAt, size, blob }` only — routing metadata, never
  plaintext.
- Replay protection: unique `id` (UUIDv7), TTL, dedupe on insert; recipients ack to
  delete.
- Signatures make authors accountable even to a third party (the node can rate-limit
  per identity and ban abusive ones without reading content).

## Relay API (`/v5/envelopes/`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v5/envelopes/` | Store an envelope for a recipient (auth + quota) |
| GET | `/v5/envelopes/?since=` | Poll pending envelopes (auth as recipient) |
| POST | `/v5/envelopes/:id/ack` | Delete after processing |
| GET | `/v5/notifications/` (SSE) | New event `envelope.received` with `{ id, type }` (no content) |

- **Blindness test** (acceptance): after a request + receipt round-trip, the node's
  database contains no readable request/receipt fields.
- Storage: Postgres table `envelopes(id, recipient_identity, type_tag, blob, size,
  created_at, expires_at)`; a sweeper deletes expired rows. `type_tag` is needed for
  SSE event hints; it is metadata, documented.
- Quotas: `envelopesPerHour`, `maxEnvelopeBytes`, `maxPendingPerIdentity`
  (`node-info.limits`), enforced per authenticated identity.
- Anti-spam phase 2: paid envelopes/stamps — see
  [architecture.md](architecture.md#anti-spam-pay-to-write).

## Flows

**Request → pay → receipt**

1. Requester picks a fresh receive address (derived locally), builds a
   `payment_request`, encrypts to the payer's identity, posts it.
2. Payer's app receives `envelope.received` over SSE, fetches, decrypts, verifies:
   signature, `expiresAt`, address format, amount; shows a confirm screen (uses
   [client-verification.md](client-verification.md) on the resulting proposal).
3. Payer signs/broadcasts (single-sig or multisig proposal as today, with the request's
   address as recipient; the address is not reused after payment).
4. Payer posts a `payment_receipt` (signed, encrypted) to the requester.
5. Requester's app matches `requestId`, marks paid, and links the txid to history.

**Request without CWS on the payer side**: the requester can always fall back to a QR
code / URI (the URI can encode `requestId` + address), so the feature degrades to
today's UX.

**Invites**: `wallet_invite` carries the same join secret the current QR link does; the
recipient's app can join directly, and both sides keep the off-chain record minimal.

## Privacy analysis (honest)

- **Provides**: payment intent and memo confidentiality; no on-chain invoice
  fingerprint; fresh addresses per request reduce reuse; invites don't leak via QR
  screenshots.
- **Does not provide**: on-chain graph privacy (a settled payment still links payer and
  requester addresses on-chain); metadata privacy against the node operator (who sees
  identity pairs, sizes, timings) — mitigated by self-hosting/Tor and TTL cleanup, not
  eliminated.
- **Recommendation**: treat envelope keys and content as private but assume routing
  metadata is visible to the operator and to a global passive adversary.

## Test plan

Unit (`wallet-core` / `abcpay-api`):

- Crypto round-trip (encrypt/decrypt, tamper → auth failure), canonical signature
  verification, replay/dedupe, TTL expiry, quota enforcement, size limits.
- Identity derivation vectors (mnemonic → envelope key) with fixtures.

E2E (Pi harness):

- Two fixture wallets: request → SSE delivery → decrypt → pay (existing send flow) →
  receipt → requester marks paid. Assert node DB holds only ciphertext.
- Token request variant (`tokenId`/`atoms`) settles through the token send path.
- Expired envelope is not delivered and is swept.
- Rate limit: N+1 requests → 429 with `Retry-After`.

## Acceptance criteria

- [ ] Envelope CRUD + SSE + ack + TTL sweep implemented under `/v5/envelopes/`.
- [ ] E2E request/receipt round-trip on the Pi with ciphertext-only storage proven.
- [ ] Quotas and size limits enforced and advertised in `node-info`.
- [ ] QR fallback path still works for requesters without CWS.
- [ ] No envelope content in logs (test asserts log-line absence).

## Open questions

1. Envelope branch choice (`m/2'/0`) — confirm no legacy convention collides.
2. Should receipts also be written on-chain as an eMPP section for verifiability, or
   stay off-chain (MVP)? If on-chain, self-sponsored receipts cost dust+fee.
3. Group envelopes (wallet-wide notifications to all copayers) — N envelopes vs a
   per-wallet identity. Defer.
4. Push notifications on native builds (FCM/APNs) vs SSE-only; affects TTL defaults.
