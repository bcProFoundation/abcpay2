# P0 — Client verification (don't trust the node's proposal)

Status: design · Depends on: [architecture.md](architecture.md) · Next: [psbt.md](psbt.md)

## Problem

Today the node builds the transaction: it selects UTXOs, computes change, and returns a
proposal that the client signs (`unsignedTxFromProposal(proposal)`). The user sees the
intent in the UI, but the bytes being signed come from the node. A malicious node could
redirect an output, inflate the fee, or substitute inputs — and a single-sig client would
sign it.

Multisig already limits the damage (the node cannot forge m signatures), but single-sig
sends, and every future feature (PSBT, PayJoin, envelopes), inherit this gap.

## Goal

The client derives **intent** from user input, then **verifies** every field of the
proposal against that intent before signing. The node becomes an untrusted assistant:
if it misbehaves, the client refuses to sign and reports the node.

## Inputs

| Source | Data | Trust |
|---|---|---|
| User | recipient address, amount (sats or token atoms), tokenId, fee level | trusted |
| Node | proposal (inputs, outputs, fee, changeAddress, feePerKb, token fields) | untrusted |
| Chain (via node or directly) | UTXOs (txid, vout, satoshis, address, path, scriptPubKey) and raw prev txs when needed | cross-checkable |

Client-side facts available for verification: wallet xPubKeys / m / n, wallet coin,
network, coinType, derivation helpers (`deriveWalletAddress`, `addressMatchesDerivation`,
`scriptPubKeyHexFromAddress`, token encoders).

## Verification rules

The client runs these before showing the confirm screen; any failure blocks signing.

**Intent (XEC)**

- **R1** Exactly one payment output: `toAddress` equals the user's recipient exactly
  (compare decoded script, not just string; accept only the wallet's coin format).
- **R2** Payment amount equals the user's amount. For `sendMax`, amount is recomputed
  independently: `sum(inputs) − fee` and must be ≥ dust.
- **R3** Total outputs = payment + at most one change output + (token sends only)
  OP_RETURN. No other output types.
- **R4** Change output (if any) pays a script owned by the wallet: run the derivation
  check (`xPubKeys`, `m`, `n`, path present in the wallet's address set or freshly
  derived at the expected next index).
- **R5** `fee = sum(inputs) − sum(outputs)`; `fee > 0`, `fee ≤ feeCap` (client sets the
  cap from the selected fee level + tolerance, e.g. ×1.5), and
  `fee ≥ estimateTxSize(...) × minRelayFeePerKb`.
- **R6** Every input's `address`/`scriptPubKey` is wallet-owned (see R4 machinery) — the
  node cannot sneak in a foreign input.

**Intent (tokens)**

- **R7** When the user sends a token, the proposal must carry `tokenId`/`protocol`
  matching the user's selected token (protocol is fetched from Chronik by the client
  too, not taken from the node's word).
- **R8** The client **recomputes the expected OP_RETURN script** from
  `(protocol, tokenId, atoms[recipient, change])` with `slpSendScript`/`alpSendScript`
  and requires a byte-equal match to the proposal's `scriptHex`.
- **R9** Recipient token output: exact address, `atoms` equal to the user's amount,
  `satoshis ≥ dust`. Token change output: wallet-owned address and
  `atoms = tokenInputs − recipientAtoms` exactly (computed from the proposal's inputs).
- **R10** Token inputs carry the same `tokenId` and no mint batons; XEC inputs are
  plain; total in ≥ dust × token outputs + fee.

**Common**

- **R11** The assembled unsigned tx the client signs is built **from the verified
  fields**, and the raw tx assembled after signing must match the PSBT/raw the node
  expects to relay (byte-compare before broadcast, see [psbt.md](psbt.md)).
- **R12** Fee level: the node's `feePerKb` must be within the requested level's band
  (from `/v2/feelevels/`, cross-checked against a second source when available).

## Failure handling

- Any R-rule failure: do not sign; show a diff view (expected vs proposed).
- Log an **untrusted-node signal** (locally; optionally a signed report to the user's
  own node) so operators can detect buggy or malicious nodes.
- If the node omits data needed for verification (e.g. no `path` on inputs), the client
  fetches the prev txs from Chronik and derives what it needs; failure to verify =
  failure to sign. No silent fallback to "trust the node".

## Implementation notes

- Move `addressMatchesDerivation` / `scriptKey` from
  `apps/abcpay-api/src/lib/address-validation.ts` into `abcpay-wallet-core` (shared by
  server and client), alongside a new `verifyProposal({ intent, proposal, wallet })`
  returning `{ ok } | { ok: false, rule, detail }`.
- The web app obtains the UTXO list from its node (fast path) and verifies ownership by
  derivation; for stronger guarantees it can query Chronik directly for the raw prev
  txs of the proposal inputs (roadmap: dual-source check).
- The node keeps its current selection logic — it just stops being trusted for
  correctness. No wire change in P0; the same `/v3/txproposals/` response is verified.
- Multisig copayers run the same verification independently before each signature, so a
  malicious node cannot get a partially verified transaction signed by m copayers.

## Test plan

Unit (`wallet-core`):

- Tamper matrix: redirected output address; reduced/raised amount; extra output;
  foreign input; wrong change address; inflated fee; token: wrong tokenId, wrong
  protocol script, altered atoms, mint-baton input, missing OP_RETURN, changed change
  atoms. Each must fail with the expected rule id.
- `sendMax` recomputation: amount must match independent math.
- Token OP_RETURN byte-equality against the encoder vectors (both protocols).

Integration / e2e (Pi harness):

- Happy path unchanged: fixtures still create/sign/broadcast.
- "Malicious node" simulation: a test-only proposal endpoint (or unit-level crafted
  response) returns a tampered proposal; client-side verifier must reject it and the
  e2e check asserts the refusal.
- Token send: verifier accepts the real proposal (regression against false positives).

## Acceptance criteria

- [ ] `verifyProposal` covers R1–R12 with rule-specific errors.
- [ ] The web send/token-send flows refuse to sign a tampered proposal (test proves it).
- [ ] Same rules applied by every copayer in multisig flows.
- [ ] Byte-identity: raw tx assembled from verified fields equals the current
      assembler output for all existing fixtures.
- [ ] No regression: 47/47 staging checks + token e2e still pass.

## Open questions

1. Should the client fetch UTXOs directly from Chronik by default (privacy: leaks the
   wallet's address set to Chronik; today the node already queries Chronik)? Consider a
   per-wallet toggle.
2. Fee cap: hard ×1.5 or user-visible override for deliberate high-fee situations?
