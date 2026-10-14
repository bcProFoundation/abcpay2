# P1 — PSBT as the proposal and envelope format

Status: design · Wire format **verified against `ecash-lib@4.14.1` `src/psbt.ts`**
(Sept 2026) · Depends on: [client-verification.md](client-verification.md) · Next:
[payment-requests.md](payment-requests.md), [payjoin.md](payjoin.md)

## Why PSBT

- **One standard format** for unsigned/partially signed transactions: offline signers,
  multi-party rounds, and PayJoin all need to move a tx under construction between
  parties.
- **Interop**: `ecash-lib` ships a `Psbt` class implementing BIP174 v0 **field-level**
  serialization aligned with Bitcoin ABC, and the node's `decodepsbt`/`combinepsbt`
  speak the same format. We do not need a bespoke wire format.
- **Verifiability**: PSBT carries the unsigned tx plus per-input prevout data, so a
  signer can verify what it signs (ties directly into P0).

## Wire format (verified, not assumed)

What `ecash-lib@4.14.1` actually implements:

- Magic `psbt\xff`; then the global map, one map per input, one map per output. Each
  map is a sequence of `<compactSize keyLen><key><compactSize valueLen><value>`, pairs
  sorted lexicographically by key, terminated by a zero-length key. **Duplicate keys in
  a map are rejected.**
- **Global `0x00`** = unsigned tx, and its scriptSigs must be empty. Any other global
  pair is preserved verbatim.
- **Inputs**:
  - `0x00` (`PSBT_IN_UTXO`, ABC naming) — value is **either** the full previous
    transaction (non-witness UTXO) **or** a compact `CTxOut`
    (`u64 sats` ‖ `compactSize`-prefixed `scriptPubKey`).
  - `0x02` = partial signature: key is the type byte ‖ a 33-byte (compressed) or
    65-byte (uncompressed) pubkey; value is the DER signature ‖ sighash byte.
  - `0x03` = sighash type, `0x04` = redeem script, `0x06` = BIP32 derivation, `0x07` =
    final scriptSig. A BIP32 derivation value is a compactSize length prefix ‖ 4-byte
    fingerprint ‖ uint32 path components (the unprefixed BIP174-text shape is also
    accepted on read; **we always write the prefixed, ABC-compatible shape**).
  - BIP174's `0x01` is *not* read as a witness UTXO (ABC behaviour) and survives only as
    an unknown pair. We never write `0x01`.
- **Outputs**: `0x00` = redeem script, `0x02` = BIP32 derivation; everything else is
  unknown/preserved.
- **Unknown key–value pairs are preserved on round-trip in all three maps** — this is
  what lets our proprietary token keys live inside the PSBT.
- API surface: `Psbt.fromBytes(bytes)`, `psbt.toBytes()`, `Psbt.fromTx(tx, signDataPerInput, ecc)`,
  `psbt.toTx()`, `psbt.addMultisigSignature({ inputIdx, signature, signData, ecc? })`,
  `psbt.addMultisigSignatureFromKey({ inputIdx, sk, signData, sigHashType?, ecc? })`,
  `psbt.isFullySignedMultisig()`. Per-input state: `signDataPerInput[i] = { sats,
  redeemScript? | outputScript? }`, `inputPartialSigs[i]: Map<pubkeyHex, sig>`,
  `inputWitnessIncomplete[i]`.

**Decision (this closes the old "field-level vs ABC blob vs JSON+raw fork" question):
field-level BIP174 v0 is the wire format**, byte-compatible with `ecash-lib` and
Bitcoin ABC. No JSON+raw-hex sidecar, no ABC-proprietary envelope blob, no custom
`psbtVersion` field. The legacy JSON proposal stays as an *adapter* in wallet-core, and
the byte-identity test below is the migration safety net.

## Subset we produce

- Required: global unsigned tx, input `0x00` for **every** input, input `0x02` per
  signer pubkey, input `0x04` redeem script for every multisig input.
- Optional: input `0x06` BIP32 derivation (for hardware/offline signers), `0x03`
  sighash. Outputs stay minimal — token metadata uses proprietary keys.
- Prev-tx data: write the **full previous transaction** when available (eCash has no
  segwit, so the non-witness UTXO is the ABC-native shape). The compact `CTxOut` form
  is accepted on read and may be written only when the full prev tx is unavailable, in
  which case the client cross-checks scripts and satoshis against Chronik's `tx(txid)`
  (already wrapped by `getTxScripts` in `chronik.ts`). Any raw-hex prev tx is parsed
  with our own `Tx` deserializer, never trusted as an opaque blob.
- Proprietary keys (`0xFC`, framed as `0xFC ‖ compactSize(prefixLen) ‖ prefix ‖ keyData`),
  frozen with the implementation:

  | Key | Value | Purpose |
  |---|---|---|
  | `cws.output.token` | 32 bytes = the 64-char token id, hex-pair per byte, left to right (display order) | token output identity |
  | `cws.output.protocol` | ASCII `SLP` / `ALP` | encoder selection for verification |
  | `cws.output.atoms` | decimal ASCII, unsigned, no leading zeros (matches the JSON `atoms: string` on `/v3/txproposals/`) | token amount on an output |
  | `cws.proposal.id` | the 16 raw bytes behind our 32-char `proposalId` hex (`randomBytes(16).toString('hex')`) | correlates PSBT with the node record |

  Token metadata is **advisory**: the client recomputes the OP_RETURN and atom amounts
  from intent (R8–R10 in [client-verification.md](client-verification.md)); a mismatch
  between proprietary pairs and the recomputed values is a verification *failure*, not a
  hint. The pairs exist so a second implementation can read the tx without the JSON.
- **Transport**: base64 of the PSBT bytes inside encrypted envelopes
  ([payment-requests.md](payment-requests.md)). The node stores opaque blobs and never
  approves correctness. Note the size budget: base64 is ~1.33× raw and multisig + token
  pairs inflate the PSBT, so the 16 KiB default envelope cap is too small for PSBT
  payloads — size classes are specified in [payment-requests.md](payment-requests.md).
  Legacy `/v3/txproposals/` responses gain an optional `psbt` (base64) + `psbtSha256`
  field so current clients can ignore it and new clients can use it as the source of
  truth.

## Guiding invariants

1. **Byte-identical assembly.** `assemble(PSBT)` must produce exactly the same raw tx as
   today's `unsignedTxFromProposal` + `mergeCopayerSignatures` + `assembleTxHex` path
   for every existing fixture. The new encoder is added, the old path stays, and a test
   asserts equality byte-for-byte. This also holds per round: every `combinePsbts`
   result must serialize to the same unsigned tx bytes.
2. **Round-trip stability.** `toBytes(fromBytes(b)) === b` for every PSBT we produce,
   and every PSBT we produce must parse with `ecash-lib`'s `Psbt.fromBytes` and with
   the node's `decodepsbt` (dev-only interop check, never a runtime dependency).
3. **No new cryptography.** Signatures are the same ECDSA + `SIGHASH_ALL|FORKID` we
   already produce; PSBT is only a container, and `signTxInputs` stays the signer. (The
   envelope channel *does* introduce a new crypto composition — that is tracked as a
   ground rule and review gate in [architecture.md](architecture.md#ground-rules).)
4. **Non-custodial always.** A PSBT that leaves a party is either unsigned or partially
   signed; a fully signed PSBT is broadcast by the client and the node keeps only the
   txid. Signatures are public once broadcast, so node-side storage is a privacy
   consideration, not a custody one.

## Module layout

- `packages/abcpay-wallet-core/src/psbt.ts` (new):
  - `txToPsbt({ tx, prevTxsById, proposalIdHex, outputMeta })` — build via
    `Psbt.fromTx`, then attach proprietary output/global pairs.
  - `parsePsbt(bytes | base64) / serializePsbt(psbt)` — thin, strict wrappers over
    `Psbt.fromBytes` / `psbt.toBytes()` (strict base64: no whitespace tolerance).
  - `addPartialSignature(psbt, inputIndex, pubkey, sig)` — wraps
    `addMultisigSignature`; rejects a signature whose pubkey is not in the redeem
    script.
  - `combinePsbts(a, b)` — requires the **same unsigned tx**: compare the serialized
    unsigned-tx bytes (not object identity) and the same input count. A copy with
    *reordered* inputs is a different unsigned tx (input order is committed to by
    `SIGHASH_ALL|FORKID`) and is rejected outright — its signatures would not be valid
    for the surviving order. Union per input: `0x00`, `0x04`, `0x06`, and the `0x02`
    maps. Any proprietary/unknown pair that differs byte-for-byte between the two PSBTs
    → reject (no silent last-writer-wins). A conflicting `0x03` (sighash type) or `0x07`
    (final scriptSig) on the same input likewise rejects — combining must never pick a
    winner silently.
  - `finalizePsbt(psbt)` — `isFullySignedMultisig()` first, then `toTx()` → raw hex.
  - var-slice codecs: `bytes.ts` currently has `compactSize` (write only) and **no
    compactSize reader**. Add `readCompactSize(bytes, offset)` and `readVarSlice` to
    `bytes.ts` (shared with any future encoder) and fuzz them against `ecash-lib`'s
    `readVarSize`/`writeVarSize`.
- Dev-only fixture validation against `ecash-lib` (not a runtime dependency): generate a
  PSBT for a fixture tx with `ecash-lib`, parse it with ours, cross-assemble, and assert
  byte equality; the dependency is installed in the test workspace only.

## Node API (`/v5/psbt/`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v5/psbt/` | Create a PSBT from an intent (server-assisted selection, client verifies per P0) |
| GET | `/v5/psbt/:id` | Fetch an opaque stored PSBT (auth: wallet member) |
| POST | `/v5/psbt/:id/sign` | Attach a partial signature — **wallet copayers only** |
| POST | `/v5/psbt/:id/finalize` | Assemble if complete; returns raw tx for broadcast |
| POST | `/v5/psbt/:id/relay` | Fallback relay of the final raw tx to Chronik |

- **Counterparties never sign through the node.** A PayJoin receiver is not a copayer of
  the sender's wallet; it returns a PSBT inside an encrypted envelope, and the sender
  verifies it under S1–S9 in [payjoin.md](payjoin.md). `/v5/psbt/:id/sign` is
  copayer-only and the auth contract is in
  [architecture.md § v5 auth contract](architecture.md#v5-auth-contract).
- **Broadcast preference**: the client broadcasts the final raw tx **directly to
  Chronik** (or any compatible node) by default. `/relay` exists for clients behind
  networks that block direct broadcast; a self-hosted node can simply relay for its own
  clients.
- The node may parse a PSBT only to count inputs/partial signatures for authorization and
  quota enforcement. It never approves correctness — that is the client's job, and its
  parse result is untrusted by definition.
- Existing `/v3/txproposals/` responses gain optional `psbt` + `psbtSha256` fields
  (additive; no field removals).

## Multi-party rounds

- **Single-sig (m=1)**: build → verify → sign → finalize → broadcast (one round).
- **Multisig (m-of-n)**: build → each copayer verifies (P0) and posts a partial sig →
  combine → finalize when `m` partial sigs exist → broadcast. This is exactly the
  current proposal lifecycle, with PSBTs as the payload instead of raw signature
  arrays; the existing SSE events (`proposal.signed`, ...) keep driving the UI. The
  assembler is the only path to a raw tx, and both the legacy and PSBT paths must yield
  identical bytes (invariant 1).
- **Offline signers (roadmap)**: export/import PSBT as a file/QR; no server round
  required.

## Test plan

- Round-trip: encode → decode → byte-equal original (fuzz a few hundred fixture txs).
- Interop: parse an `ecash-lib`-produced PSBT (fixture checked into `__tests__`) and
  assert our bytes parse with `Psbt.fromBytes`; a `decodepsbt` check runs in CI against
  a node when one is available.
- Unknown/proprietary pairs survive a full `ecash-lib` `fromBytes`/`toBytes` round trip
  (critical: the reference implementation must not drop our token keys).
- BIP32 derivation: prefixed (ABC) and unprefixed (BIP174 text) values both parse; we
  emit the prefixed form.
- Byte-identity vs legacy assembly (all parity fixtures: XEC 899/1899/145, DOGE,
  2-of-2/2-of-3, token sends).
- `combinePsbts`: two partial-sig sets for the same unsigned tx combine; different
  unsigned tx (including a reordered-inputs copy), different input count, a conflicting
  proprietary pair, or a conflicting `0x03`/`0x07` on the same input → rejected.
- `finalizePsbt` with insufficient signatures → error; with `m` → valid raw tx; txid
  equals legacy txid.
- Proprietary encodings: `cws.output.atoms` round-trips for `1`, `100000000`, and large
  values; non-decimal, signed, and leading-zero forms are rejected.
- var-slice codec fuzz against `ecash-lib` `readVarSize`/`writeVarSize`.
- Node API: membership enforcement, size limits, status transitions (unit + e2e).
- E2E on Pi: existing proposal flow served as PSBT, signatures attached via PSBT route,
  broadcast, recipient sees funds; both SLP and ALP token sends covered.

## Acceptance criteria

- [ ] `psbt.ts` covers the documented BIP174 v0 subset, and every PSBT we emit is
      accepted by both `ecash-lib` and `decodepsbt`.
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
4. Incoming `0x01` (BIP174 witness UTXO) PSBTs: today they parse as inputs with no UTXO
   data and are rejected. Do we add explicit `0x01` support for cross-chain tooling, or
   keep ABC parity and reject?
5. Publish the proprietary prefix strings and encodings as a short spec with test vectors
   so another implementation can read our token metadata.
