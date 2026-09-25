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
| Chain (via node or directly) | UTXOs (txid, vout, satoshis, address, path, scriptPubKey) and raw prev txs when needed | cross-checkable — **required** for R6 amount verification |

Client-side facts available for verification: wallet xPubKeys / m / n, wallet coin,
network, coinType, derivation helpers (`deriveWalletAddress`, `addressMatchesDerivation`,
`scriptPubKeyHexFromAddress`, token encoders).

## Verification rules

The client runs these before showing the confirm screen; any failure blocks signing.

**Intent (XEC)**

- **R1** Exactly one payment output: the recipient address is the one the user entered.
  Compare the **decoded script**, not the string: `scriptPubKeyHexFromAddress(address)`
  on both sides, compared as lowercase hex; accept only the wallet's coin format (cashaddr
  for eCash). A string-equal address that decodes to a different script is a failure, and
  so is a script-equal address in the wrong format.
- **R2** Payment amount equals the user's amount. For `sendMax`, amount is recomputed
  independently: `sum(inputs) − fee` and must be ≥ dust.
- **R3** Total outputs = payment + at most one change output + (token sends only)
  OP_RETURN. No other output types.
- **R4** Change output (if any) pays a **fresh, never-used** wallet address: the next
  unused index on the wallet's change branch (`wallets.changeAddressIndex`), and the
  script must not appear in the wallet's known address set, in any previous proposal or
  tx history, or on-chain for the wallet. Run the derivation check (`xPubKeys`, `m`, `n`,
  path at the expected next index) **and** the freshness check. A change output to a
  reused or previously exposed address is a failure even though it is wallet-owned —
  address reuse is the main clustering leak this design is trying to avoid.
- **R5** `fee = sum(inputs) − sum(outputs)`; `fee > 0`, `fee ≤ feeCap`, and
  `fee ≥ estimatedSize × minRelayFeePerKb`, where `estimatedSize` is **not** the current
  `estimateTxSize(inputCount, outputCount, n, m)` alone: that helper counts
  `10 + 34 × outputs + inputs` and ignores the OP_RETURN output, so token sends add
  `compactSize(scriptLen) + scriptLen` (our own OP_RETURN, recomputed per R8) to the size
  before the floor is applied. Under-estimating here lets the node set a fee that looks
  compliant but fails relay.
- **R5a** The cap is **user-visible**: the confirm screen shows the exact fee in sats, the
  selected fee level, and the multiplier/tolerance applied (default ×1.5), plus a warning
  when the proposal's fee lands in the tolerance band rather than at the level's target.
  A fee above the user's chosen level must be confirmed explicitly, not auto-accepted.
- **R6** Every input is wallet-owned (see R4 machinery) — the node cannot sneak in a
  foreign input — **and every input's satoshi value is verified**, not taken on the
  node's word. Preferred order: (a) the input amount matches the value the client already
  has from its own UTXO source; (b) otherwise the client fetches the prev tx from Chronik
  (`tx(txid)`, wrapped by `getTxScripts`) or the raw hex and re-derives the value itself.
  An input whose amount cannot be corroborated is a **hard failure** — do not sign, do not
  "assume the node is right here". This matters because a single wrong input amount
  silently changes the fee (R5) and can hide a fee-inflation or redirect attack behind a
  plausible-looking transaction.

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
  expects to relay (byte-compare before broadcast, see [psbt.md](psbt.md)). When P1
  lands, the same rules run against the *parsed PSBT* (unsigned tx + per-input UTXO +
  proprietary token keys), and the JSON proposal is only the adapter — a node that
  returns a PSBT cannot downgrade verification by omitting JSON fields.
- **R12** Fee level: the node's `feePerKb` must be within the requested level's band
  (from `/v2/feelevels/`, cross-checked against a second source when available).
- **R13** The proposal must belong to **this** wallet before anything else is checked:
  `proposal.walletId` equals the local wallet id (a proposal addressed to another wallet,
  or with a missing/foreign id, is rejected outright), the coin/network match, and every
  copayer in `wallet.publicKeyRing` is a member of the local wallet. This closes the gap
  where a valid-looking proposal for a *different* wallet (or a replayed one from another
  wallet's flow) is signed by a client that only verifies amounts and outputs.

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
  returning `{ ok } | { ok: false, rule, detail }`. Reuse `scriptPubKeyHexFromAddress`
  (wallet-core `address.ts`) for every script comparison so R1/R4/R6 share one decoder.
- The verifier needs a **used-address set** for R4 freshness (wallet `addresses` table +
  the wallet's proposal/tx history + on-chain scan). Cache it per wallet; the next change
  index comes from `wallets.changeAddressIndex`.
- The web app obtains the UTXO list from its node (fast path) and verifies ownership by
  derivation; for stronger guarantees it can query Chronik directly for the raw prev
  txs of the proposal inputs (roadmap: dual-source check). R6 is the floor, not the
  ceiling: dual-source is where the design wants to land.
- The node keeps its current selection logic — it just stops being trusted for
  correctness. No wire change in P0; the same `/v3/txproposals/` response is verified.
- Multisig copayers run the same verification independently before each signature, so a
  malicious node cannot get a partially verified transaction signed by m copayers.

## Test plan

Unit (`wallet-core`):

- Tamper matrix: redirected output address; reduced/raised amount; extra output;
  foreign input; wrong change address; reused change address; inflated fee;
  fee below the OP_RETURN-aware floor; unverifiable input amount (no chain source);
  wrong `proposal.walletId`; key ring containing a foreign copayer; token: wrong
  tokenId, wrong protocol script, altered atoms, mint-baton input, missing OP_RETURN,
  changed change atoms. Each must fail with the expected rule id.
- `sendMax` recomputation: amount must match independent math.
- Token OP_RETURN byte-equality against the encoder vectors (both protocols).

Integration / e2e (Pi harness):

- Happy path unchanged: fixtures still create/sign/broadcast.
- "Malicious node" simulation: a test-only proposal endpoint (or unit-level crafted
  response) returns a tampered proposal; client-side verifier must reject it and the
  e2e check asserts the refusal.
- Token send: verifier accepts the real proposal (regression against false positives).

## Acceptance criteria

- [ ] `verifyProposal` covers R1–R13 with rule-specific errors.
- [ ] The web send/token-send flows refuse to sign a tampered proposal (test proves it).
- [ ] Same rules applied by every copayer in multisig flows.
- [ ] Byte-identity: raw tx assembled from verified fields equals the current
      assembler output for all existing fixtures.
- [ ] No regression: 47/47 staging checks + token e2e still pass.

## Open questions

1. Should the client fetch UTXOs directly from Chronik by default (privacy: leaks the
   wallet's address set to Chronik; today the node already queries Chronik)? Consider a
   per-wallet toggle. Note R6 needs *some* independent amount source even when the UTXO
   list comes from the node, so a dual-source check may become mandatory rather than a
   roadmap item.
2. Fee cap: ×1.5 default (always displayed per R5a) or a user-set absolute ceiling in
   sats for deliberate high-fee situations? The rule is settled — the cap is shown and
   over-level fees need explicit confirmation — only the default number is open.
