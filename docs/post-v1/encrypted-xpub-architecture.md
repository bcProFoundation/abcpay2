# Encrypted Extended Public Keys (Post–v1 Migration)

**Status:** Planned — implement after AbcPay v1 → v2 migration is complete  
**Audience:** Backend, frontend, and security reviewers  
**Related:** BWS/Copay multisig model, `abcpay-wallet-core`, `abcpay-api` copayer schema

---

## Summary

Today AbcPay v2 (BWS-compatible) stores each copayer’s **account extended public key (`xPubKey`)** and the wallet’s **`publicKeyRing`** in plaintext on the server. That is standard for Copay/BWS: the server can derive addresses and assist with transaction proposals, but a database breach exposes **watch-only** visibility into every shared wallet.

This document describes a **server-blind** design: the server stores only **encrypted** key material it cannot decrypt. Each copayer uploads a blob only they (or the wallet group) can unlock. Address derivation, UTXO selection, and unsigned transaction building move entirely to **clients**. The server remains a coordination layer for proposals, notifications, and metadata.

**Important:** Encrypting xpubs improves **privacy against a compromised or curious server**. It does **not** change custody: xpubs were never spend keys. Spending still requires **m-of-n private keys** on copayer devices.

---

## Goals

| Goal | Description |
|------|-------------|
| **Server cannot read xpubs** | DB breach or malicious operator cannot derive addresses from stored key material |
| **Multisig still works** | 2-of-3 (and general m-of-n) wallets can derive addresses and sign proposals on clients |
| **Per-copayer storage** | Each participant has their own encrypted blob on the server (3 copayers → 3 blobs) |
| **Recoverability** | A copayer can restore from mnemonic + wallet ID without trusting server key storage |
| **Backward compatibility path** | Legacy plaintext wallets can be migrated or supported in parallel during transition |

## Non-goals (for initial implementation)

- Hiding on-chain activity (addresses and txs remain public once used)
- Replacing `requestPubKey` API authentication in phase 1 (see [Open questions](#open-questions))
- End-to-end encrypting transaction history or balances (Chronik is public)
- Changing the m-of-n signing cryptography on-chain

---

## Current state (v2 / BWS model)

### What the server stores per copayer

| Field | Sensitivity | Used for |
|-------|-------------|----------|
| `xPubKey` | Privacy leak if exposed | Multisig address derivation |
| `requestPubKey` | Low (public) | `x-signature` request authentication |
| `publicKeyRing` (wallet row) | Privacy leak if exposed | Server-side `addressService` / `walletService.createAddress` |

### What the server does **not** store

- Mnemonic / seed
- `xPrivKey` or any key that can spend alone

### Current address flow (server-assisted)

```
Client                         Server                         Chain
  │ join (xPubKey plaintext) ──►│ store copayer + ring          │
  │                             │ derive address (xpubs)        │
  │◄── address ─────────────────│                               │
```

After migration to encrypted xpubs, the server **must not** call `deriveWalletAddress` or `deriveAddressFromRing` using DB-held plaintext xpubs.

---

## Threat model

| Threat | Plaintext xpub on server | Encrypted xpub on server |
|--------|--------------------------|---------------------------|
| Server DB leaked | Attacker can watch all wallets | Attacker gets useless ciphertext |
| Malicious server operator | Can monitor all wallets | Cannot read xpub blobs (if design is correct) |
| Steal funds | Needs **m private keys** on devices | Still needs **m private keys** |
| On-chain deanonymization | Same once addresses are used | Same once addresses are used |

**Conclusion:** This design is a **privacy / server-trust** improvement, not a custody upgrade. It is still worth doing if we want AbcPay to work with an untrusted or minimally trusted BWS host.

---

## Proposed architecture

### Principle

> **The server is a blind relay for encrypted key blobs and tx proposals. All HD derivation happens on clients.**

```
┌──────────────┐  encryptedXPub_A   ┌──────────────┐
│  Copayer A   │ ─────────────────► │              │
│  (client)    │                    │   BWS API    │
└──────────────┘                    │  (Postgres)  │
┌──────────────┐  encryptedXPub_B   │              │
│  Copayer B   │ ─────────────────► │  no xpubs    │
└──────────────┘                    │  in clear    │
┌──────────────┐  encryptedXPub_C   │              │
│  Copayer C   │ ─────────────────► └──────────────┘
└──────────────┘
        │
        │ each client decrypts blobs → local publicKeyRing
        ▼
   derive address / build tx locally → register address + proposals with server
```

### Per-copayer encrypted blobs (3-of-3 example)

For a wallet with copayers A, B, C the server stores:

```json
{
  "walletId": "…",
  "m": 2,
  "n": 3,
  "copayers": [
    {
      "copayerId": "A",
      "name": "Alice",
      "requestPubKey": "…",
      "encryptedKeyPackage": {
        "version": 1,
        "ciphertext": "…",
        "nonce": "…",
        "scheme": "copayer-self"
      }
    },
    {
      "copayerId": "B",
      "encryptedKeyPackage": { "…" }
    },
    {
      "copayerId": "C",
      "encryptedKeyPackage": { "…" }
    }
  ]
}
```

Each `encryptedKeyPackage` contains (when decrypted by the right party):

```json
{
  "xPubKey": "xpub…",
  "accountPath": "m/48'/1899'/0'",
  "coin": "xec"
}
```

The server never sees the decrypted payload.

---

## Encryption schemes (choose one for v1 of this feature)

### Option A — Copayer-self encryption (recommended for phase 1)

Each copayer encrypts their own xpub with a key derived from **device secret + wallet ID**:

```
encryptionKey_A = HKDF(deviceMasterSecret_A, salt = walletId, info = "abcpay-xpub-v1")
encryptedXPub_A = AES-256-GCM(xpubPayload_A, encryptionKey_A)
```

| Pros | Cons |
|------|------|
| Simple; no multi-party ceremony | Other copayers cannot decrypt A’s blob |
| Good for backup/sync of **own** key to server | Full `publicKeyRing` must be obtained elsewhere |

**Implication:** During join, copayers must still **exchange xpubs peer-to-peer** (invite QR, secure link) or rely on a **one-time join payload** that includes all keys. The encrypted server copy is for **restore**, not for other copayers to read.

**Restore flow:** Device loads mnemonic → derives own xpub → decrypts own `encryptedKeyPackage` from server to verify → fetches other copayers’ ciphertexts (cannot decrypt) → user must re-import invite / re-join / restore from local backup that cached the full ring.

### Option B — Wallet-group encryption (recommended for phase 2)

During join, participants run a short **wallet key agreement** and derive a shared `walletKey`. Each copayer uploads:

```
encryptedXPub_i = AES-256-GCM(xpubPayload_i, walletKey)
```

Any copayer with `walletKey` can decrypt **all** blobs and rebuild `publicKeyRing`.

| Pros | Cons |
|------|------|
| Any copayer can reconstruct full ring from server data | Join ceremony is more complex |
| Clean restore: mnemonic + wallet ID + walletKey re-derivation | If `walletKey` leaks, all xpubs leak |

**Wallet key derivation sketch:**

1. Each copayer contributes an ephemeral ECDH public key at join.
2. After all n copayers join, each computes the same `walletKey = HKDF(ECDH_shared_material, walletId)`.
3. Only then does each upload `encryptedXPub_i`.

Copay/BWC did not do this historically; we would be extending the join protocol.

### Option C — Hybrid (practical default)

- **Option B** for shared multisig wallets (`n > 1`).
- **Option A** or no server key storage for single-sig wallets (xpub optional; client-only is fine).

---

## Join and restore flows

### Create shared wallet (2-of-3)

1. **Creator (A)** generates keys locally; creates wallet on server with **no plaintext xpub** (only `pubKey` for wallet identity if still required by BWC).
2. **A** uploads `encryptedXPub_A` (Option A or B).
3. **A** shares invite secret / QR containing `walletId` and optionally an **E2E join secret** for wallet key (Option B).
4. **B joins:** derives keys → uploads `encryptedXPub_B` → downloads all ciphertexts → decrypts → caches `publicKeyRing` locally → derives first receive address → `POST /v3/addresses/` with `{ address, path, publicKeys }`.
5. **C joins:** same as B.
6. When `n` copayers present, wallet status → `complete`. No server-side address derivation.

### Send / receive (unchanged on-chain, changed on client)

| Step | Where |
|------|--------|
| Derive receive address | Client (`abcpay-wallet-core`) |
| Register address with server | `POST /v3/addresses/` |
| Fetch UTXOs | Server proxies Chronik (address is already public) |
| Build unsigned tx | Client |
| Create proposal | `POST /v3/txproposals/` |
| Sign | Client + existing proposal API |

### Restore after device loss

| Scheme | What user needs |
|--------|-----------------|
| Option A | Mnemonic + wallet ID + (invite backup **or** re-join) to rebuild others’ xpubs |
| Option B | Mnemonic + wallet ID (+ join secret if required to re-derive `walletKey`) |
| Local backup | Export encrypted wallet file containing full `publicKeyRing` (best UX) |

---

## Database schema changes

Add to `copayers` table (names illustrative):

```sql
ALTER TABLE copayers
  ADD COLUMN encrypted_key_package JSONB,
  ADD COLUMN key_package_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN encryption_scheme TEXT NOT NULL DEFAULT 'none'; -- 'none' | 'copayer-self' | 'wallet-group'

-- Migration: existing rows keep encryption_scheme = 'none' and plaintext x_pub_key
-- New wallets: x_pub_key nullable or deprecated; encrypted_key_package required
```

Wallet table:

```sql
-- Deprecate plaintext public_key_ring for new wallets
-- Optional: wallet.encryption_mode = 'legacy' | 'blind'
```

**Migration rule:** Wallets created before this feature keep `encryption_scheme = 'none'` and continue using plaintext xpubs until explicitly migrated.

---

## API changes

### Join / create copayer

**Request (new wallets):**

```http
POST /v2/wallets/:id/copayers
{
  "name": "Alice",
  "coin": "xec",
  "requestPubKey": "…",
  "copayerSignature": "…",
  "encryptedKeyPackage": {
    "version": 1,
    "scheme": "wallet-group",
    "ciphertext": "base64…",
    "nonce": "base64…"
  }
}
```

**No `xPubKey` in cleartext** for `encryption_scheme != 'none'`.

### Get wallet / copayers

Return `encryptedKeyPackage` per copayer. Do **not** return decrypted xpubs from server.

### Address registration (already partially supported)

Clients must use:

```http
POST /v3/addresses/
{
  "address": "ecash:…",
  "path": "m/48'/1899'/0'/0/0",
  "publicKeys": ["02…", "03…", "02…"],
  "isChange": false
}
```

Server validates structure only (optional: verify address matches registered `publicKeys` length vs wallet `m`/`n`).

### New endpoint (optional)

```http
GET /v1/wallets/:id/key-packages/
```

Returns all copayers’ `encryptedKeyPackage` blobs for clients rebuilding the ring.

---

## Client changes (`abcpay-web` + `abcpay-wallet-core`)

| Area | Change |
|------|--------|
| **Key generation** | Unchanged (`createCredentials` / `generateKeys`) |
| **Join** | Upload `encryptedKeyPackage`; download others’ packages; decrypt; cache ring in secure storage |
| **WalletContext** | Store `publicKeyRing` locally only; never expect server to return plaintext xpubs |
| **Receive** | Derive address locally; register with server |
| **Send** | Build tx locally using `abcpay-wallet-core` (`tx.ts`, `coinselect.ts`) |
| **Settings / backup** | Export local ring + encrypted server blobs; document restore requirements |
| **Legacy wallets** | Detect `encryption_scheme === 'none'` and use existing BWC path |

### Local storage

```typescript
interface LocalWalletSecrets {
  walletId: string;
  copayerId: string;
  credentials: WalletCredentials;      // private material — never upload
  publicKeyRing: PublicKeyRingEntry[]; // decrypted xpubs — local only for blind wallets
  encryptionScheme: 'none' | 'copayer-self' | 'wallet-group';
}
```

---

## Server code to remove or gate

After blind mode is default for new wallets, **disable** for `encryption_scheme != 'none'`:

- `addressService.createAddress` using DB `publicKeyRing`
- `walletService.createAddress` server-side derivation path
- Writing plaintext `xPubKey` / `publicKeyRing` on join

Keep:

- `requestPubKey` verification (`authMiddleware`)
- Tx proposal coordination
- Chronik proxy (balance, UTXO, history, broadcast)
- Address **registration** (client-supplied)

Feature flag suggestion: `WALLET_BLIND_XPUB_DEFAULT=true` after cutover.

---

## Implementation phases

### Phase 0 — Prerequisites (post–v1 migration)

- [ ] v1 user migration complete; v2 stable in production
- [ ] Client-side send path complete (not “coming soon”) for single-sig at minimum
- [ ] `abcpay-wallet-core` tests cover multisig derivation for XEC and DOGE

### Phase 1 — Schema + API (backward compatible)

- [ ] Add `encrypted_key_package`, `encryption_scheme` columns
- [ ] Accept optional `encryptedKeyPackage` on join; keep accepting plaintext `xPubKey`
- [ ] Add `wallet.encryption_mode` or infer from copayer rows
- [ ] Document API in OpenAPI / README

### Phase 2 — Client encrypt-on-join (Option A)

- [ ] Encrypt own xpub on join; peer xpub via invite payload
- [ ] Local `publicKeyRing` cache
- [ ] Client-only address derive + register
- [ ] Settings: export/import ring backup

### Phase 3 — Wallet-group encryption (Option B)

- [ ] Join ceremony for `walletKey`
- [ ] Any copayer can restore ring from server blobs alone
- [ ] Security review of key agreement

### Phase 4 — Deprecate plaintext

- [ ] New wallets default to blind mode
- [ ] Migration tool for existing wallets (re-upload encrypted packages; optional)
- [ ] Remove server-side derivation code paths for blind wallets

---

## Security review checklist

Before enabling by default:

- [ ] Ciphertext uses authenticated encryption (AES-GCM or XChaCha20-Poly1305)
- [ ] Nonces are unique per encryption
- [ ] Key derivation uses HKDF with wallet-scoped salt
- [ ] No xpub or xpriv in logs, error messages, or analytics
- [ ] `encryptedKeyPackage` cannot be swapped between copayers (bind `copayerId` in AAD)
- [ ] Join/replay attacks considered for wallet-group key agreement
- [ ] Threat model document updated for operators

---

## Open questions

1. **`requestPubKey` in cleartext** — Server must verify API signatures today. Alternatives: per-device TLS client certs, or signed requests with a key that is itself inside `encryptedKeyPackage` (chicken-and-egg on first join).

2. **BWC compatibility** — Plaintext xpub is part of the BitPay Wallet Client contract. Blind mode may be an **AbcPay v2 extension** with a capability flag (`walletCapabilities.blindXpub: true`).

3. **Single-sig wallets** — Simplest path: no xpub on server at all; client derives everything. Encrypted blob is optional for multi-device sync.

4. **Copayer leaves / rotates key** — Not supported in classic BWS; document as out of scope or require new wallet.

5. **Server validation** — Should server reject `POST /v3/addresses/` if `publicKeys.length !== wallet.n`? (Recommended yes.)

---

## References in this repo

| File | Relevance |
|------|-----------|
| `apps/abcpay-api/src/db/schema.ts` | `copayers.xPubKey`, `wallets.publicKeyRing` |
| `apps/abcpay-api/src/services/wallet.service.ts` | Server-side `createAddress`, join flow |
| `apps/abcpay-api/src/services/address.service.ts` | Legacy server derivation |
| `packages/abcpay-wallet-core/src/keys.ts` | `createCredentials`, xpub derivation |
| `packages/abcpay-wallet-core/src/address.ts` | Client-side `deriveWalletAddress` |
| `apps/abcpay-web/src/lib/wallet-client.ts` | Current join/create with plaintext xpub upload |

---

## Decision log (to fill during implementation)

| Date | Decision | Rationale |
|------|----------|-----------|
| TBD | Option A vs B for first release | |
| TBD | Keep or drop `publicKeyRing` column | |
| TBD | BWC compatibility strategy | |

---

*Last updated: 2026-08-30 — draft for post–v1 migration planning*
