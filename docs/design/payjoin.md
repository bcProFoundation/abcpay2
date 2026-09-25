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

```
Sender                                         Receiver
  | 1. build original PSBT (payment + change)     |
  |    verify per client-verification.md          |
  |--- 2. envelope(psbt, expect=contribute) ----->|
  |                                               | 3. verify: payment output amount/script,
  |                                               |    no extra outputs, fee sane
  |                                               | 4. add >=1 own input, adjust own change,
  |                                               |    rebalance fee, sign own input(s)
  |<-- 5. envelope(psbt', expect=finalize) -------|
  | 6. verify PSBT': my inputs unchanged, payment |
  |    output exactly as intended, new inputs     |
  |    only from receiver, fee within cap         |
  | 7. sign my inputs, assemble, broadcast        |
  |--- 8. envelope(receipt, txid) --------------->|
```

Fallback/abort rules:

- Receiver may decline (timeout or explicit `decline`) → sender proceeds with the
  original PSBT (today's flow). Timeout is configurable (default 30s) with an in-UI
  countdown.
- **Never broadcast both** the original and the PayJoin tx (double-spend attempt wires
  the inputs; the second broadcast fails and looks suspicious). Once a PayJoin attempt
  starts, cancel the original.

## Sender verification rules (the critical security surface)

The receiver controls the returned PSBT; the sender must reject any mutation of its
intent:

- **S1** The unsigned tx context is the same transaction (same coin/network; the
  receiver may only *add inputs* and *adjust receiver-owned outputs*).
- **S2** Payment output: exact `atoms/satoshis` as agreed, paid to a script the
  receiver proved control of (their input's address ring or an address they sign for —
  design choice: require the payment script to be one of the receiver's input
  addresses to avoid redirection by a MITM).
- **S3** Sender change: unchanged, or reduced by exactly the receiver's contribution
  necessary to keep the tx funded (never redirected to a non-sender output).
- **S4** Output set: no outputs added/removed beyond (a) payment, (b) sender change,
  (c) receiver change; OP_RETURN (token sends) byte-identical to the sender's original.
- **S5** Input set: superset of sender inputs; all *new* inputs must be
  receiver-attributable (present in the receiver's contribution envelope/signature),
  never a third party's.
- **S6** Fee: recomputed from the new tx; within the sender's cap; ≥ min relay fee.
- **S7** PSBT integrity: no partial sigs from the sender are stripped; proprietary
  token keys unchanged.
- **S8** Idempotency: the returned PSBT's `proposalId` matches the one sent (prevents
  cross-request substitution).

Attack table:

| Attack | Rule that blocks it |
|---|---|
| Reduce/redirect payment output | S2 |
| Swap payment address to attacker | S2 (script tied to receiver's inputs) |
| Insert extra output | S4 |
| Redirect sender change | S3 |
| Add a third-party input to frame someone | S5 |
| Inflate fee to burn funds | S6 |
| Replace PSBT with a different tx | S1, S8 |
| Replay an old contribution | S8 + envelope TTL/ids |

## Fingerprint mitigations

PayJoin is detectable; reduce the obvious tells:

- Randomize output order and input order in the final tx.
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
  verifies (P0) and attaches a partial sig to their side.
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

- Attack matrix S1–S8 (each crafted PSBT rejected with the expected rule).
- Happy-path contribution: receiver adds input + change, fee rebalance correct, final
  raw tx valid, txid stable.
- Token PayJoin: OP_RETURN untouched; token atoms accounting holds; change atoms exact.
- Randomization: output/input order shuffling does not break assembly.

E2E (Pi, real funds):

- Two funded single-sig wallets, one PayJoin send: assert final tx has inputs from both
  wallets, recipient receives the exact amount, sender change correct, fee ≤ cap.
- Decline + timeout fallback paths produce a normal single-owner tx.
- Malicious-receiver scenario in the harness (test-only): tampered PSBT is rejected by
  the sender (rule id surfaced).

## Acceptance criteria

- [ ] Sender verification rules S1–S8 implemented and covered by tests.
- [ ] Single-sig PayJoin completes end-to-end on mainnet with both wallets' inputs in
      the final tx.
- [ ] Fallback path is automatic and leaves no double-spend attempts.
- [ ] Anonymity-set estimate is measured and documented per transaction (local only).
- [ ] Multisig PayJoin explicitly out of scope until single-sig soak completes.

## Open questions

1. Receiver-address binding for S2: require payment output script to equal one of the
   receiver's input scripts, or accept a receiver-signed output address? (The former is
   simpler and stronger; the latter supports "PayJoin to a fresh address".)
2. Contribution timing: synchronous online handshake (BIP78-style) vs the async
   envelope flow; async is friendlier for mobile but widens the change-theft window —
   consider a short-lived reservation of the sender's original PSBT.
3. Fee ownership: who pays the extra input's fee in the UI (sender absorbs by default)?
4. Anyonepay (`SIGHASH_ANYONECANPAY`) to reduce re-signing rounds — research before
   enabling; it weakens signature binding and changes the security model.
