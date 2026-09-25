# P1 — PSBT as the proposal and envelope format

Status: design · Depends on: [client-verification.md](client-verification.md) · Next:
[payment-requests.md](payment-requests.md), [payjoin.md](payjoin.md)

## Why PSBT

- **One standard format** for unsigned/partially signed transactions: offline signers,
  multi-party rounds, and PayJoin all need to move a tx under construction between
  parties.
- **Interop** with the eCash ecosystem (`ecash-lib` ships a `Psbt` implementation and
  Bitcoin ABC tooling speaks BIP174); we do not want a bespoke wire format.
- **Verifiability**: PSBT carries the unsigned tx plus per-input prevout data, so a
  signer can verify what it signs (ties directly into P0).

## Scope

- BIP174 **PSBT v0 subset** (no PSBTv2), matching what `ecash-lib` produces/consumes.
- Required fields:
  - `PSBT_GLOBAL_UNSIGNED_TX`
  - `PSBT_IN_NON_WITNESS_UTXO` for every input — eCash inherits the Bitcoin Cash
    format (no segwit), so the full previous transaction is required. The node (or
    client) fetches raw prev txs from Chronik (`rawTx(txid)`).
  - `PSBT_IN_PARTIAL_SIG` per signer pubkey (our ECDSA secp256k1 + forkid sighash).
  - `PSBT_IN_BIP32_DERIVATION` (optional) for hardware/offline signers.
  - `PSBT_OUT_*` minimal; **proprietary output keys** carry token metadata.
- Proprietary keys (0xFC) — proposed identifiers, to be frozen with implementation:

  | Key | Value | Purpose |
  |---|---|---|
  | `cws.output.tokenId` | 32-byte token id | token output identity |
  | `cws.output.protocol` | `"SLP"` \| `"ALP"` | encoder selection for verification |
  | `cws.output.atoms` | u64/u48 big-endian bytes | token amount on an output |
  | `cws.proposal.id` | 16-byte proposal id | correlates PSBT with node record (opaque) |

- **Transport**: PSBTs travel as base64 inside encrypted envelopes
  ([payment-requests.md](payment-requests.md)). The node stores opaque blobs and never
  needs to parse them (blind relay). For the legacy proposal flow the node may also
  store the PSBT next to the JSON proposal for compatibility.

## Guiding invariants

1. **Byte-identical assembly.** `assemble(PSBT)` must produce exactly the same raw tx as
   today's `unsignedTxFromProposal` + `mergeCopayerSignatures` + `assembleTxHex` path
   for every existing fixture. This is the migration safety net: the new encoder is
   added, the old path stays, and a test asserts equality byte-for-byte.
2. **No new cryptography.** Signatures are the same ECDSA + `SIGHASH_ALL|FORKID` we
   already produce; PSBT is only a container. Our `signTxInputs` stays the signer.
3. **Non-custodial always.** A PSBT that leaves a party is either unsigned or partially
   signed; a fully signed PSBT is broadcast immediately (never stored server-side in
   cleartext form with all signatures if we can avoid it — note: signatures are public
   once broadcast anyway, so storage is not a custody risk, only a privacy one).

## Module layout

- `packages/abcpay-wallet-core/src/psbt.ts`
  - `txToPsbt({ tx, prevTxsById, inputPaths, outputMeta })`
  - `parsePsbt(bytes) / serializePsbt(psbt)`
  - `addPartialSignature(psbt, inputIndex, pubkey, sig)`
  - `combinePsbts(a, b)` (same unsigned tx required)
  - `finalizePsbt(psbt)` → raw tx hex
  - Varint/var-slice codecs reused from existing `bytes.ts`.
- Dev-only fixture validation against `ecash-lib` (not a runtime dependency):
  generate a PSBT for a fixture tx with `ecash-lib`, parse it with ours, and
  cross-assemble; run in `wallet-core` tests with the dependency installed **in the
  test workspace only**.

## Node API (`/v5/psbt/`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v5/psbt/` | Create a PSBT from an intent (server-assisted selection, client verifies per P0) |
| GET | `/v5/psbt/:id` | Fetch an opaque stored PSBT (auth: wallet member) |
| POST | `/v5/psbt/:id/sign` | Attach a partial signature (from a copayer or the counterparty) |
| POST | `/v5/psbt/:id/finalize` | Assemble if complete; returns raw tx for broadcast |
| POST | `/v5/psbt/:id/relay` | Broadcast the final raw tx to Chronik (or client broadcasts itself) |

All routes stay authenticated with the existing `x-identity`/`x-signature` scheme. The
node validates only what it must to protect itself (size, membership, status
transitions) and stores the rest opaquely. Existing `/v3/txproposals/` responses gain an
optional `psbt` field (base64) so current clients can ignore it and new clients can use
it as the source of truth.

## Multi-party rounds

- **Single-sig (m=1)**: build → verify → sign → finalize → broadcast (one round).
- **Multisig (m-of-n)**: build → each copayer verifies (P0) and posts a partial sig →
  combine → finalize when `m` partial sigs exist → broadcast. This is exactly the
  current proposal lifecycle, with PSBTs as the payload instead of raw signature
  arrays; the existing SSE events (`proposal.signed`, ...) keep driving the UI.
- **Offline signers (roadmap)**: export/import PSBT as a file/QR; no server round
  required.

## Test plan

- Round-trip: encode → decode → equals original (fuzz a few hundred fixture txs).
- Byte-identity vs legacy assembly (all parity fixtures: XEC 899/1899/145, DOGE,
  2-of-2/2-of-3, token sends).
- `combinePsbts` mismatch rejection (different unsigned tx, different input count).
- `finalizePsbt` with insufficient signatures → error; with `m` → valid raw tx; txid
  equals legacy txid.
- Interop: parse an `ecash-lib`-produced PSBT (fixture checked into `__tests__`).
- Token metadata proprietary keys survive round-trip and are used by the P0 verifier.
- Node API: membership enforcement, size limits, status transitions (unit + e2e).
- E2E on Pi: existing proposal flow served as PSBT, signatures attached via PSBT route,
  broadcast, recipient sees funds; both SLP and ALP token sends covered.

## Acceptance criteria

- [ ] `psbt.ts` covers BIP174 v0 subset with the documented proprietary keys.
- [ ] Byte-identity tests pass for all existing fixtures and real mainnet txs.
- [ ] `/v5/psbt/` lifecycle works end-to-end on the Pi for single-sig and 2-of-2.
- [ ] Legacy clients unaffected (no field removals; `psbt` is additive).
- [ ] No new runtime dependencies in `wallet-core`.

## Open questions

1. PSBTv2 (field-based, better for hardware) — defer until a hardware wallet target is
   chosen.
2. Should the node ever *hold* fully signed PSBTs? Proposal: no — once complete, the
   client broadcasts and the node keeps only the txid.
3. Do we want `SIGHASH_SINGLE`/`ANYONECANPAY` variants for PayJoin optimization, or
   keep `ALL|FORKID` for simplicity? (PayJoin works with `ALL`; ANYONECANPAY could
   reduce re-signing rounds but weakens signature binding — research before use.)
