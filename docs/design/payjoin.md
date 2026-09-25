# PayJoin over the CWS PSBT channel (workstream #2)

Status: design · Depends on: [psbt.md](psbt.md), [payment-requests.md](payment-requests.md) ·
Flagship: this is the only per-transaction on-chain privacy feature in the roadmap.

## What it does (and what it does not)

**Does:**

- Breaks the **common-input-ownership heuristic** for that transaction: the receiver
  contributes at least one input, so inputs no longer belong to a single owner.
- Gives the **receiver** strong per-tx privacy: their received amount/address is hidden
  among their own UTXOs and outputs (the payment output is not obviously theirs, and
  change ownership is ambiguous).
- Gives the **sender** a modest anonymity bump and makes their change unlinkable to
  their inputs under naive clustering.

**Does not:**

- Provide anonymity or a large sender-side anonymity set; does not hide amounts from a
  motivated analyst; is **detectable as a PayJoin** with published heuristics; does
  nothing if the receiver reuses addresses or merges coins afterwards.

We will measure and report the per-tx effect (see "Measurement") instead of claiming
"sender untraceable".

## Protocol (async, over encrypted envelopes)

Use `ecash:` P2PKH/P2SH inputs, `SIGHASH_ALL|FORKID`. Single-sig first; multisig is a
later phase with the same message flow but more signing rounds.

**Scope of the MVP: XEC payments only.** A PayJoin contribution is restricted to
**plain, non-token XEC inputs** (no SLP/ALP token, no mint baton), and token sends are
not PayJoined in the MVP — the flow refuses to start with an explicit `unsupported`
reason rather than guessing at token accounting. When token PayJoin is designed later,
S4's OP_RETURN byte-identity and the R9/R10 token rules in
[client-verification.md](client-verification.md) apply unchanged, and contributed inputs
remain non-token.

**PSBTs never travel to the node in plaintext.** Every step below happens inside
end-to-end encrypted envelopes; `/v5/psbt/:id/sign` is copayer-only and is not part of
this flow ([psbt.md](psbt.md)).

```
Sender                                         Receiver
  | 1. build original PSBT (payment + change)     |
  |    verify per client-verification.md          |
  |--- 2. envelope(psbt, expect=contribute) ----->|
  |                                               | 3. verify: payment output amount/script,
  |                                               |    no extra outputs, fee sane
  |                                               | 4. add >=1 own non-token XEC input,
  |                                               |    adjust own change, rebalance fee,
  |                                               |    shuffle input/output order, then
  |                                               |    sign own input(s)
  |<-- 5. envelope(psbt', expect=finalize) -------|
  | 6. verify PSBT': my inputs unchanged, payment |
  |    output exactly as intended, new inputs     |
  |    only from receiver, fee within cap, and    |
  |    every new input's partial sig verifies (S9)|
  | 7. sign my inputs, assemble, broadcast        |
  |--- 8. envelope(receipt, txid) --------------->|
```

**Ordering freeze.** `SIGHASH_ALL|FORKID` commits to input/output order, so ordering
is part of what the signatures attest: the receiver shuffles in step 4 *before*
signing, and after step 5 the sender must not reorder anything — step 7 may only fill
in the sender's own scriptSigs (other inputs' scriptSigs are not covered by the BIP143
preimage, so this does not invalidate the receiver's signatures). The sender verifies
S9 against the received order and then does not touch it; any post-verification reorder
breaks the receiver's signatures and the broadcast fails. A shuffled-after-signing PSBT
is therefore rejected by S9 verification, not by a separate rule.

Fallback/abort rules:

- Receiver may decline (timeout or explicit `decline`) → sender proceeds with the
  original PSBT (today's flow). Timeout is configurable (default 30s) with an in-UI
  countdown.
- **Never broadcast both** the original and the PayJoin tx (double-spend attempt wires
  the inputs; the second broadcast fails and looks suspicious). Once a PayJoin attempt
  starts, cancel the original.
- Any S1–S9 rejection aborts the PayJoin and falls back to the original flow (or asks
  the user), logging the rule id; a rejected contribution is never "accepted with a
  warning".

## Sender verification rules (the critical security surface)

The receiver controls the returned PSBT; the sender must reject any mutation of its
intent:

- **S1** The unsigned tx context is the same transaction (same coin/network; the
  receiver may only *add inputs* and *adjust receiver-owned outputs*). Concretely: the
  returned unsigned tx must contain the sender's original inputs unchanged and the
  original outputs except as allowed by S3/S4.
- **S2** Payment output: exact satoshis as agreed (XEC-only MVP; token amounts return
  with the deferred token phase), and the payment script must
  be **byte-equal to the script of one of the receiver's own contributed inputs**
  (decoded scripts, lowercase hex — same comparison as R1). This is the MVP decision, and
  it is what ties the payment to a UTXO the receiver demonstrably controls and has signed
  for. "PayJoin to a fresh address" is *not* in the MVP: a receiver-signed output address
  is a weaker binding (the receiver could hand out an address it also gives to third
  parties) and needs a separate proof format before it is allowed here. So there is no
  redirect target for a MITM: any change to the payment script or amount is S2.
- **S3** Sender change: unchanged, or reduced by exactly the receiver's contribution
  necessary to keep the tx funded (never redirected to a non-sender output).
- **S4** Output set: no outputs added/removed beyond (a) payment, (b) sender change,
  (c) receiver change. (OP_RETURN byte-identity belongs to the deferred token phase;
  the XEC-only MVP has no OP_RETURN.)
- **S5** Input set: superset of sender inputs; all *new* inputs must be
  receiver-attributable (present in the receiver's contribution envelope/signature),
  never a third party's, **and must be plain non-token XEC** — an input carrying an
  SLP/ALP token or a mint baton is rejected in the MVP (token accounting for contributed
  inputs is not designed yet; silently mixing it would break R9/R10).
- **S6** Fee: recomputed from the new tx; within the sender's cap; ≥ min relay fee. The
  extra input's fee is absorbed by the sender by default and shown in the UI.
- **S7** PSBT integrity: no partial sigs from the sender are stripped; proprietary
  token keys unchanged; `proposalId` proprietary key matches.
- **S8** Idempotency: the returned PSBT's `proposalId` matches the one sent (prevents
  cross-request substitution), and the envelope `id`/`round` are fresh.
- **S9** New-input signature proof: for every added input, the `PSBT_IN_PARTIAL_SIG`
  (key type `0x02`) must be a valid ECDSA signature over that input's
  `SIGHASH_ALL|FORKID` preimage by the pubkey in the key, and that pubkey must belong to
  the input's `scriptPubKey` (P2PKH: hash160 match; P2SH: hash160 of the redeem script).
  Additionally: no partial sig whose pubkey is in the **sender's** key set may appear on
  a new input (an impersonation attempt), and the count of new inputs must equal the
  number of receiver signatures offered. This is what actually proves "the receiver
  contributed this input" without trusting the node or the receiver's self-description.

Attack table:

| Attack | Rule that blocks it |
|---|---|
| Reduce/redirect payment output | S2 |
| Swap payment address to attacker | S2 (script must equal a receiver input's script) |
| Insert extra output | S4 |
| Redirect sender change | S3 |
| Add a third-party input to frame someone | S5, S9 |
| Claim a contribution without signing for it | S9 |
| Forge a receiver signature on a new input | S9 (preimage + pubkey/script check) |
| Slip in a token input to poison token accounting | S5 (non-token-only in MVP) |
| Inflate fee to burn funds | S6 |
| Replace PSBT with a different tx | S1, S8 |
| Replay an old contribution | S8 + envelope TTL/ids |

## Fingerprint mitigations

PayJoin is detectable; reduce the obvious tells:

- Randomize output order and input order — but only before signing (receiver, step 4);
  see the ordering freeze above. Shuffling after anyone has signed breaks their
  signatures instead of improving privacy.
- Avoid the "receiver contributes exactly one input" signature when practical
  (receiver contributes 1–2 inputs based on their UTXO set; do not force equal in/out
  counts).
- Do not always pay round amounts; avoid creating an output that exactly matches an
  input value where it isn't structurally required.
- Prefer receiver change as a separate output (not merged into their existing UTXO).
- Never reuse the original payment address for the non-PayJoin fallback.

These are heuristics, not guarantees; document that PayJoin is an arms race.

## Multisig (phase 2)

- Both sides are m-of-n wallets → contribution becomes a PSBT round: each copayer
  verifies (P0) and attaches a partial sig to their side. S9 applies per receiver
  copayer: each added input needs a verifying signature from a key in that input's
  script ring, and the sender's own keys must not appear on new inputs.
- Complexity: rounds multiply (sender n_s signs + receiver n_r signs, combined via
  `combinePsbts`), and the receiver must keep their contribution funded/valid while
  waiting. Design notes: bounded round timeouts, cancel semantics, and never partially
  sign before verifying the counterparty's final output set.
- Do **not** ship multisig PayJoin until single-sig has survived review + a
  testnet/mainnet soak.

## Opt-in and UX

- Per-send toggle: "Improve privacy (receiver must support PayJoin)", off by default
  until adoption; receiver capability is advertised via `node-info.features.payjoin`
  and/or the recipient's envelope identity metadata.
- Timeout UX with clear abort (no half-built transactions left behind).
- Post-tx note: "This payment used PayJoin (privacy heuristic broken); Privacy gain
  depends on both wallets' behavior."
- Failure never blocks a normal payment: explicit fallback after timeout/decline.

## Measurement (no PII)

Log locally (client) and optionally report in aggregate:

- `payjoin_attempt`, `payjoin_success`, `decline`, `timeout`, `verification_rejected`
  with rule id.
- `anon_set_estimate = 1 + receiver_input_count` for the sender heuristic, and
  receiver-side `value_ambiguity = number of outputs with indistinguishable value
  ranges` (approximation, documented as such).
- Publish a periodic summary in the repo (e.g. `docs/design/payjoin-metrics.md`) rather
  than telemetry-in-the-node.

## Test plan

Unit (`wallet-core` + verifier):

- **Attack matrix S1–S9** (each crafted PSBT rejected with the expected rule), including
  the S9 cases specifically: partial sig by the wrong key, sig over a different preimage
  (input index/value swapped), pubkey not matching the input's scriptPubKey, sender-key
  sig attached to a new input, fewer sigs than new inputs.
- Happy-path contribution: receiver adds input + change, fee rebalance correct, final
  raw tx valid, txid stable.
- Token PayJoin: the flow **refuses to start** for a token send and for any contribution
  that includes a token input, with an explicit `unsupported` reason (this is the tested
  MVP behavior, not a gap).
- Randomization: output/input order shuffling does not break assembly — and the
  S1/S9 checks are order-insensitive (outpoint-canonical matching, not array indices).

E2E (Pi, real funds):

- Two funded single-sig wallets, one PayJoin send: assert final tx has inputs from both
  wallets, recipient receives the exact amount, sender change correct, fee ≤ cap.
- Decline + timeout fallback paths produce a normal single-owner tx.
- Malicious-receiver scenario in the harness (test-only): tampered PSBT is rejected by
  the sender (rule id surfaced).

## Acceptance criteria

- [ ] Sender verification rules S1–S9 implemented and covered by tests.
- [ ] Single-sig PayJoin completes end-to-end on mainnet with both wallets' inputs in
      the final tx.
- [ ] Fallback path is automatic and leaves no double-spend attempts.
- [ ] Anonymity-set estimate is measured and documented per transaction (local only).
- [ ] Multisig PayJoin explicitly out of scope until single-sig soak completes.

## Resolved decisions

- **Receiver-address binding (was open question 1)**: payment script must byte-equal one
  of the receiver's contributed input scripts (S2). A receiver-signed *fresh* address is
  deferred until it has a proof format; it is not an MVP alternative.
- **Contribution timing (was open question 2)**: async envelope flow, as drawn above. The
  sender cancels the original proposal when the attempt starts, holds the flow open for a
  bounded window (default 30s + UI countdown), and resumes the original path on decline,
  timeout, or any S-rule rejection.
- **Fee ownership (was open question 3)**: the sender absorbs the extra input's fee by
  default, and the confirm screen shows the fee delta explicitly.
- **Token PayJoin**: out of scope for the MVP (S5), with an explicit refusal instead of a
  best-effort attempt.

## Open questions

1. Anyonepay (`SIGHASH_ANYONECANPAY`) to reduce re-signing rounds — research before
   enabling; it weakens signature binding and changes the security model.
2. Whether a v2 receiver proof for "PayJoin to a fresh address" can be as strong as S2
   (e.g. a signature over a canonical bind message including the output script, the tx
   preimage hash, and a nonce), or whether the restriction is permanent.
3. Multisig phase 2 timing: reservation semantics for a receiver's contribution while
   sender copayers are still signing (bounded rounds, cancel on timeout).
4. Whether the anonymity-set estimate should be reported to the receiver too, or kept
   strictly sender-side (privacy of the measurement itself).
