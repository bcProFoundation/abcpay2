# AbcPay v1 → v2 Migration Plan (XEC / DOGE)

**Status:** Scope accepted — implementation planning  
**Date:** 2026-09-13  
**Audience:** Backend, frontend, migration reviewers  
**Related:** `docs/post-v1/encrypted-xpub-architecture.md`, `README.md`

---

## Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | v2 supports XEC and DOGE only; no v1 BWS protocol/API compatibility layer | Avoids maintaining two client stacks; legacy app is sunset with an update/restore path |
| D2 | v2 is the single system of record; legacy BWS runs read-only during transition, then retires | One coordinator, one security surface, no divergence |
| D3 | Migrate wallet + copayer metadata only; re-derive addresses; do not migrate proposals/history | Chronik is the history source; minimal data = minimal risk |
| D4 | v2 freezes legacy BWC derivation/identity conventions as the canonical spec | Existing wallets, request keys, and join secrets keep working; kills the hash160/sha256 and `m/1'/0` vs `m/1'/0'` split |
| D5 | XPI (and other legacy coins) out of scope for v2 migration | Different chain/workstream, low current value; separate future design |
| D6 | Legacy BWS stays read-only for XPI/other-coin holders until they export or migrate manually | Avoid stranding funds without blocking v2 |

---

## Scope

**In scope**

- XEC/DOGE wallets: single-sig (1-of-1) and multisig (m-of-n)
- Import of wallet + copayer metadata from legacy MongoDB BWS into v2 Postgres
- Stable wallet IDs, copayer IDs, copayer set, and join-secret compatibility
- v2 restore flow (mnemonic + wallet ID) validated for imported wallets
- Derivation parity harness using legacy bitcore-wallet-client/BWS as oracle

**Out of scope**

- XPI, BTC, BCH, LTC, ETH, ERC-20/SLP tokens
- Tx proposals, notifications, preferences, push subscriptions, fiat-rate data
- Legacy app compatibility against the v2 API
- Server-side key custody and encrypted-xpub/blind mode (post-v1, see related doc)
- Migrating legacy accounts/channels (paypro, buy crypto, card, gift cards)

---

## Derivation spec freeze (v2 = legacy BWC)

`packages/abcpay-wallet-core` must produce byte-identical results to legacy. Known required fixes vs current `wallet-core/src/keys.ts`:

| Convention | Canonical value (legacy BWC 8.25.45) | v2 state |
|------------|----------------------------------------|----------|
| Copayer ID | `sha256(lowercase(chain) + xPubKey)` hex; no prefix for `btc` only (`Utils.xPubToCopayerId`) | `wallet-core` now matches; `bws-utils.ts` already matched |
| Request key path | `m/1'/0` from root (`Constants.PATHS.REQUEST_KEY`) | `wallet-core` matches; web `wallet-client.ts` uses `m/1'/0'` — must change |
| Account purpose | 44' single-sig, 48' multisig (`Key.getBaseAddressDerivationPath`) | Matches |
| Coin type | XEC 899 (native, Electrum ABC) and 1899 (token-aware, Cashtab/ecash-wallet); DOGE 3 | v2 stores per-wallet `coinType`; defaults: XEC single-sig 1899, XEC multisig 899, DOGE 3; explicit override for imported wallets |
| Address types | P2PKH n=1; P2SH multisig; script built from **sorted** pubkeys | Matches (wallet-core sorts for script) |
| Public key ring | `publicKeys` returned in **copayer ring order** (bitcore sorts internally only for the script) | `wallet-core` now preserves ring order |
| XEC address encoding | Legacy emits prefixless cashaddr (`toString(true)`); `ecash:`/`bitcoincash:` are equivalent encodings of the same hash | Parity asserted on normalized address; v2 emits `ecash:` |
| Request signing | `method.toLowerCase() + '|' + url + '|' + JSON.stringify(args)`, ECDSA over `sha256d(message)`, DER hex signature (net semantics of `Utils.signMessage(..., 'little')`) | `wallet-core` now matches byte-for-byte; web/server wrappers still use the Bitcoin-message hash — must change |
| Join signature | `signMessage(encryptedCopayerName\|xPubKey\|requestPubKey, walletPrivKey)` | web `wallet-client.ts` matches structure once `signMessage` is legacy-compatible |
| Join secret | `base58(walletId) + WIF + 'L'/'T' + coin` (`API._buildSecret`) | web `wallet-client.ts` matches format |

**Rule:** no v1-only branch in v2 code. Imported and new wallets use the same spec; only `createdOn`/indexes differ.

### Derivation variants (899 vs 1899)

v2 stores the account variant per wallet as `coin_type` (`wallets.coinType`) and returns it in wallet and join-info responses. Defaults:

| Wallet | coinType | Rationale |
|--------|----------|-----------|
| XEC single-sig | 1899 | Cashtab / ecash-wallet compatibility; SLP-capable addresses |
| XEC multisig | 899 | Electrum ABC compatibility; SLP-capable P2SH |
| XEC RaiPay (legacy import) | 145 | Legacy Raipay token wallets restore on their original path |
| DOGE | 3 | single variant |

Explicit override is supported (`createCredentials({ coinType })`; `POST /v2/wallets/` accepts `coinType`) so v1 wallets restore on their original path — v1 main single-sig XEC wallets are **899**, v1 SLP XEC wallets are **1899**, v1 RaiPay wallets are **145**.

Legacy flag mapping during import:

| Legacy wallet flags | v2 coinType |
|---------------------|-------------|
| `xec` (no SLP flags) | 899 |
| `xec`, `isSlpToken`, `!isPath899` | 1899 |
| `xec`, `isSlpToken`, `isPath899` | 899 |
| `xec`, `isFromRaipay` (SLP) | 145 |
| `doge` | 3 |

Request key (`m/1'/0`) and copayer ID derive from the seed/coin and are variant-independent. Addresses derive relative to the account xpub, so both variants share one server-side code path.

---

## Data mapping (legacy MongoDB → v2 Postgres)

Verify exact collection and field names against the `bcProFoundation/bitcore` fork and `AbcPay` repos before writing the importer.

| Legacy field | v2 column | Notes |
|--------------|-----------|-------|
| `wallets.id` / `walletId` | `wallets.wallet_id` | Keep stable |
| `wallets.name` | `wallets.name` | |
| `wallets.m`, `wallets.n` | `wallets.m`, `wallets.n` | |
| `wallets.coin` | `wallets.coin` | Import only `xec`/`doge`; report others |
| `wallets.network` | `wallets.network` | |
| `wallets.addressType` | `wallets.address_type` | |
| `wallets.status` | `wallets.status` | |
| `wallets.pubKey` | `wallets.pub_key` | |
| `wallets.publicKeyRing` | recomputed from copayers | Do not trust server copy |
| `singleAddress`, `nativeCashAddr`, `usePurpose48` | same | Carry over flags |
| `addressIndex`, `changeAddressIndex` | same columns | Import to preserve address sequence; reconcile against `addresses` |
| `copayers.copayerId`/`id` | `copayers.copayer_id` | Must equal canonical `sha256(coin+xpub)` |
| `copayers.xPubKey` | `copayers.x_pub_key` | Watch-only |
| `copayers.requestPubKey` | `copayers.request_pub_key` | Needed for auth continuity |
| `copayers.name`, `customData` | same | |
| `addresses.*` | optional import | Use for audit only; re-derivable |
| `txproposals`, `notifications`, `preferences`, push, fiat | not migrated | |

Reconciliation: import idempotently (upsert by `wallet_id` / `copayer_id`), emit a report (counts, skipped coins, duplicates, index conflicts). Wallet and join-secret values must survive unchanged.

---

## Oracle and parity harness

1. Run legacy `bitcore-wallet-client` / legacy BWS locally to generate golden fixtures:
   - 1-of-1, 2-of-2, 2-of-3 for XEC and DOGE
   - copayer IDs, request pubkeys, account xpubs, join secrets
   - first N receive + change addresses (N ≥ 20), including address strings as legacy emitted them
   - signed tx vectors: XEC BIP143+FORKID, DOGE legacy, P2PKH and P2SH multisig
2. Commit fixtures and assert `abcpay-wallet-core` reproduces every value exactly in CI.
3. Migration audit: for every imported wallet, re-derive first N addresses in v2 and compare against legacy `addresses` rows; mismatch = hard fail.

This harness is written **before** the bug fixes, because it defines correctness for both existing and new wallets.

---

## Phases and gates

### Phase 0 — Parity (gate: vectors green)

- [x] Extract golden fixtures from legacy stack → `packages/abcpay-wallet-core/src/__tests__/fixtures/legacy-parity.json` (generated with `@abcpros/bitcore-wallet-client@8.25.45` + `@abcpros/crypto-wallet-core@8.25.45`)
- [x] Align `wallet-core` to the frozen spec (copayer ID sha256, XEC coin type 899, ring-order publicKeys, legacy request signing)
- [x] Delete dead server auth (`apps/abcpay-api/src/auth.ts`)
- [x] Align v2 clients and server to the same helpers: web `wallet-client.ts` (request key `m/1'/0`, coinType defaults, `signMessage`), web `api.ts` and `apps/abcpay-api/src/middleware/auth.ts` (wallet-core sign/verify; GET body `{}`), server `/v4/addresses/` derivation via wallet-core
- [x] CI: parity vectors run on every change (`.github/workflows/ci.yml` runs type-check, tests, build)

**Phase 0 results (2026-09-13):** 58 divergences found and resolved in `wallet-core` (XEC account path 1899→899 for legacy parity, copayer ID hash160→sha256(coin+xpub), multisig `publicKeys` sorted→ring order, request auth scheme). Per-wallet `coinType` variant added (defaults: single-sig 1899, multisig 899) with explicit override and dry-run restore probe. Clients/server now share `wallet-core` sign/verify (fixes the authenticated GET-with-query 401), `REQUIRE_AUTH=0` is honored, and `/v4/addresses/` uses wallet-core derivation. Parity suite: 22 tests covering credentials (`rootPath`, `xPubKey`, `xPrivKey`, request keys, copayer ID), first 3 receive + 3 change addresses per wallet shape, ring order, and byte-for-byte request signatures across XEC 899, XEC 1899, and DOGE for 1-of-1, 2-of-2, and 2-of-3.

### Phase 1 — Import tool (gate: dry-run audit clean)

- [x] Read-only Mongo reader; Postgres writer; dry-run by default, `--apply`, `--report`, `--address-audit`, `--wallet` options (`apps/abcpay-api/src/migration/import-legacy.ts`)
- [x] Idempotent upserts (`ON CONFLICT DO NOTHING`); coinType mapping (899/1899/exclusions) and copayer ID mapping unit-tested (`legacy-map.test.ts`)
- [x] Dry run + apply on the production `bws` snapshot (2026-09-16): 5,157 wallets seen, 5,131 imported (XEC 899: 1,892 / XEC 1899: 2,984 / XEC 145: 15 / DOGE: 240), 26 testnet skipped, 0 failed, 5,434 addresses audited with 0 mismatches; ring size equals copayer count for every wallet

### Import tool usage

```bash
# dry run (default): reads Mongo, audits addresses, writes a JSON report, no writes to Postgres
LEGACY_MONGO_URL=mongodb://... DATABASE_URL=postgresql://... \
  pnpm --filter @bcpros/abcpay-api import:legacy

# apply: also imports wallets, copayers and copayer lookups (--yes is mandatory)
LEGACY_MONGO_URL=mongodb://... DATABASE_URL=postgresql://... \
  pnpm --filter @bcpros/abcpay-api import:legacy -- --apply --yes --report import-report.json --address-audit 5
```

- Source collections: `wallets` (copayers embedded) and `addresses`; database defaults to `bitcore-wallet-service` (`LEGACY_MONGO_DB`).
- Filter: XEC and DOGE only. Rejected/skipped (recorded in the report): other coins, non-livenet networks, invalid m-of-n, missing keys.
- Report includes totals, coinType breakdown, copayer ID mismatches, address audit mismatches and errors. Exit code is non-zero on errors or any audit mismatch.
- Idempotent: wallets already present by `wallet_id` are counted and skipped; re-runs are safe.
- Address continuity: `addressIndex`/`changeAddressIndex` continue after the highest legacy path index per branch, and server `createAddress` honors and persists those counters, so migrated wallets never reuse addresses.
- Address audit compares decoded scripts (type + hash160) rather than raw strings, so legacy prefixless cashaddr encodings (different padding bits/checksum) still match; wallet-core now decodes and validates those legacy addresses everywhere.
- Non-livenet wallets are skipped until v2 has testnet Chronik endpoints.
- Legacy wallet and copayer names are sjcl-encrypted JSON (key derived from `walletPrivKey`, held only by clients) and cannot be decrypted server-side. Imported wallets get fallback display names (`Wallet <id8>`, `Copayer <id6>`); users can rename after restoring.
- Production sizing: in-scope BSON is ~10 MB of wallet/copayer docs plus ~2.7 MB of address docs (XEC/DOGE), versus 13 GB for the whole `bws` database — so no dump/restore is needed; the importer streams over a tunnel.

### Phase 2 — Staging E2E (gate: migrated wallet usable end-to-end)

- [ ] Import subset into staging; restore in v2 web (mnemonic + wallet ID) for XEC and DOGE
- [ ] Verify balance/UTXO/history via Chronik, copayer list, multisig proposal sign + broadcast
- [ ] Verify a joined copayer's existing device credentials would still authenticate (signature compatibility)

### Phase 3 — Production cutover

- [ ] Freeze legacy writes (new wallets/proposals/signatures); announce sunset
- [ ] Final delta import; run audit
- [ ] Enable v2 as primary; legacy BWS read-only for XPI/other-coin exports
- [ ] Retain Mongo snapshot ≥ 12 months for rollback/audit

### Phase 4 — Legacy retirement

- [ ] Publish manual export instructions for XPI/other-coin holders
- [ ] Decommission legacy BWS when export requests stop
- [ ] Revisit XPI migration as a separate design doc

**Rollback:** if a gate fails after cutover, re-point clients to the legacy snapshot (read-only) and re-run Phase 1/2 before retrying.

---

## Client UX

- Restore: existing `RestorePage` flow (mnemonic + wallet ID) becomes the standard migration path; imported wallets use the `coinType` returned by join-info. When metadata lacks `coinType`, a public dry-run join probe (`dryRun: true`) identifies the 899 vs 1899 variant without mutating the wallet.
- Multisig: each copayer restores independently; server already holds all xpubs from import, so no copayer needs to re-invite peers
- New wallets: created natively in v2, same derivation spec
- Legacy app: in-app sunset notice + key/seed export guidance; no v2 API compatibility work
- Device credentials: users who still have the legacy app keep their keys; they migrate by entering the same mnemonic in v2

---

## Acceptance criteria

- [ ] Parity vectors pass for XEC and DOGE, single-sig and multisig
- [ ] Imported wallet IDs, copayer IDs, and join secrets are unchanged from legacy
- [ ] Every sampled imported wallet re-derives identical addresses to legacy records
- [ ] A migrated 2-of-3 wallet can restore, display balance, receive, create/sign/broadcast in v2
- [ ] Legacy BWS has no write traffic after cutover except documented XPI/export reads
- [ ] Rollback procedure tested at least once on staging
- [ ] No private key material or mnemonic ever written to v2 Postgres or logs

---

## Open items

- [x] Confirm legacy conventions against `bcProFoundation/bitcore` and `AbcPay` sources (request key `m/1'/0`, copayer ID `sha256(chain+xpub)`, XEC coin type 899, prefixless cashaddr, request signing)
- [ ] SLP: 2,984 XEC SLP wallets are imported on the 1899 path; v2 does not surface token balances, so warn users before spending from token-bearing addresses (or add token-UTXO detection) before enabling sends for them
- [ ] Confirm legacy BWS MongoDB collection/field names against the deployed server version (v8.25.x-era fork)
- [ ] Decide whether to import legacy `addresses` rows (audit only vs source of truth for index continuity)
- [ ] Decide transition length for legacy read-only and store-update policy for the old mobile app
- [ ] XPI: who owns the future migration design; export tooling requirements

---

*Last updated: 2026-09-13*
