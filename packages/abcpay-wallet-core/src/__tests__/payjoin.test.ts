import { describe, expect, it } from 'vitest';
import {
  addPartialSignature,
  applyPayjoinContribution,
  buildPayjoinContribution,
  createCredentials,
  derivePrivateKey,
  deriveWalletAddress,
  signHash,
  signPayjoinContribution,
  sighashForInput,
  txToPsbt,
  unsignedTxFromProposal,
  verifyPayjoinContribution,
  type Psbt
} from '../index';

const TXID_S = 'aa'.repeat(32);
const TXID_R = 'bb'.repeat(32);

function expectRule(result: { ok: boolean; rule?: string }, rule: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.rule).toBe(rule);
}

function payjoinScenario() {
  const sender = createCredentials({ coin: 'xec' });
  const receiver = createCredentials({ coin: 'xec' });
  const senderIn = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [sender.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  });
  const senderChange = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [sender.xPubKey],
    m: 1,
    n: 1,
    path: 'm/1/0'
  });
  const receiverIn = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [receiver.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  });
  const payment = receiverIn.address;

  const senderInput = {
    txid: TXID_S,
    vout: 0,
    satoshis: 10000,
    address: senderIn.address,
    path: 'm/0/0',
    publicKeys: senderIn.publicKeys,
    scriptPubKey: senderIn.scriptPubKey
  };
  const receiverInput = {
    txid: TXID_R,
    vout: 1,
    satoshis: 20000,
    address: receiverIn.address,
    path: 'm/0/0',
    publicKeys: receiverIn.publicKeys,
    scriptPubKey: receiverIn.scriptPubKey
  };

  const originalTx = unsignedTxFromProposal({
    coin: 'xec',
    inputs: [senderInput],
    outputs: [{ toAddress: payment, amount: 5000 }],
    amount: 5000,
    fee: 452,
    changeAddress: { address: senderChange.address, path: 'm/1/0' }
  });
  const original = txToPsbt({ tx: originalTx, proposalIdHex: '77'.repeat(16) });

  const contributionTx = unsignedTxFromProposal({
    coin: 'xec',
    inputs: [senderInput, receiverInput],
    outputs: [
      { toAddress: payment, amount: 5000 },
      { toAddress: senderChange.address, amount: 4548 },
      { toAddress: receiverIn.address, amount: 19636 }
    ],
    amount: 29184,
    fee: 816
  });
  const receiverSighash = sighashForInput(contributionTx, 1);
  const receiverSig = signHash(
    derivePrivateKey(receiver.xPrivKey, 'm/0/0'),
    receiverSighash,
    'xec'
  );
  const signed = addPartialSignature(
    txToPsbt({ tx: contributionTx, proposalIdHex: '77'.repeat(16) }),
    1,
    receiverIn.publicKeys[0]!,
    receiverSig
  );
  const unsigned = txToPsbt({ tx: contributionTx, proposalIdHex: '77'.repeat(16) });

  const intent = { toAddress: payment, amountSat: 5000, feePerKb: 2000 };
  const chain = {
    inputTokens: new Map([[`${TXID_R}:1`, { tokenId: null, atoms: '0' }]])
  };
  const verify = (contribution: Psbt, overrides: Record<string, unknown> = {}) =>
    verifyPayjoinContribution({
      coin: 'xec',
      network: 'livenet',
      original,
      contribution,
      intent,
      senderPubKeyHexes: [senderIn.publicKeys[0]!],
      chain,
      ...overrides
    });
  return {
    sender,
    receiver,
    senderIn,
    senderChange,
    receiverIn,
    payment,
    original,
    contribution: signed,
    unsignedContribution: unsigned,
    receiverSig,
    verify
  };
}

describe('payjoin contribution happy path', () => {
  it('accepts a receiver contribution that adds one input and its change', () => {
    const s = payjoinScenario();
    const result = s.verify(s.contribution);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feeSat).toBe(816);
      expect(result.newInputCount).toBe(1);
      expect(result.feeCapSat).toBeGreaterThan(result.feeSat);
    }
  });

  it('accepts a contribution that also lowers the overall fee within bounds', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.outputs[2]!.satoshis = 19680;
    clone.unsignedTx.outputs[1]!.satoshis = 4548;
    clone.inputs[1]!.partialSigs[0]!.signatureHex = signHash(
      derivePrivateKey(s.receiver.xPrivKey, 'm/0/0'),
      sighashForInput(clone.unsignedTx, 1),
      'xec'
    );
    const result = s.verify(clone);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.feeSat).toBe(772);
  });
});

describe('payjoin attack matrix', () => {
  it('S1: dropping a sender input is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.inputs = [clone.unsignedTx.inputs[1]!];
    clone.inputs = [clone.inputs[1]!];
    expectRule(s.verify(clone), 'S1');
  });

  it('S1: altering a sender input is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.inputs[0]!.satoshis = 12000;
    clone.inputs[0]!.utxo = { sats: 12000, scriptPubKeyHex: clone.unsignedTx.inputs[0]!.scriptPubKey! };
    expectRule(s.verify(clone), 'S1');
  });

  it('S2: reduced payment amount is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.outputs[0]!.satoshis = 4999;
    expectRule(s.verify(clone), 'S2');
  });

  it('S2: payment redirected to a non-contributor script is rejected', () => {
    const s = payjoinScenario();
    const stranger = createCredentials({ coin: 'xec' });
    const strangerIn = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [stranger.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/0'
    });
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.outputs[0]!.address = strangerIn.address;
    clone.unsignedTx.outputs[0]!.scriptHex = undefined;
    expectRule(s.verify(clone), 'S2');
  });

  it('S3: receiver extracting value from sender change is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.outputs[1]!.satoshis = 4048;
    clone.unsignedTx.outputs[2]!.satoshis = 20136;
    expectRule(s.verify(clone), 'S3');
  });

  it('S4: an extra output to a third party is rejected', () => {
    const s = payjoinScenario();
    const stranger = createCredentials({ coin: 'xec' });
    const strangerIn = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [stranger.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/0'
    });
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.outputs.push({ address: strangerIn.address, satoshis: 100 });
    clone.outputs.push({ unknownPairs: [] });
    expectRule(s.verify(clone), 'S4');
  });

  it('S5: a contribution with no new inputs is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.inputs = [clone.unsignedTx.inputs[0]!];
    clone.inputs = [clone.inputs[0]!];
    expectRule(s.verify(clone), 'S5');
  });

  it('S5: token inputs are rejected in the MVP', () => {
    const s = payjoinScenario();
    const chain = {
      inputTokens: new Map([
        [`${TXID_R}:1`, { tokenId: 'ab'.repeat(32), atoms: '10', isMintBaton: false }]
      ])
    };
    expectRule(s.verify(s.contribution, { chain }), 'S5');
  });

  it('S5: unverifiable token status is rejected', () => {
    const s = payjoinScenario();
    expectRule(s.verify(s.contribution, { chain: {} }), 'S5');
  });

  it('S6: fee inflation beyond the cap is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.outputs[1]!.satoshis = 4548;
    clone.unsignedTx.outputs[2]!.satoshis = 18636;
    expectRule(s.verify(clone), 'S6');
  });

  it('S6: fee below the relay floor is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.unsignedTx.outputs[2]!.satoshis = 20100;
    expectRule(s.verify(clone), 'S6');
  });

  it('S7: stripping the sender partial signature is rejected', () => {
    const s = payjoinScenario();
    const senderSig = signHash(
      derivePrivateKey(s.sender.xPrivKey, 'm/0/0'),
      sighashForInput(s.contribution.unsignedTx, 0),
      'xec'
    );
    const withSenderSig = addPartialSignature(
      s.contribution,
      0,
      s.senderIn.publicKeys[0]!,
      senderSig
    );
    const originalWithSig = addPartialSignature(
      s.original,
      0,
      s.senderIn.publicKeys[0]!,
      senderSig
    );
    const stripped = structuredClone(s.contribution) as Psbt;
    const result = verifyPayjoinContribution({
      coin: 'xec',
      network: 'livenet',
      original: originalWithSig,
      contribution: stripped,
      intent: { toAddress: s.payment, amountSat: 5000, feePerKb: 2000 },
      senderPubKeyHexes: [s.senderIn.publicKeys[0]!],
      chain: { inputTokens: new Map([[`${TXID_R}:1`, { tokenId: null, atoms: '0' }]]) }
    });
    expectRule(result, 'S7');
    const preserved = verifyPayjoinContribution({
      coin: 'xec',
      network: 'livenet',
      original: originalWithSig,
      contribution: withSenderSig,
      intent: { toAddress: s.payment, amountSat: 5000, feePerKb: 2000 },
      senderPubKeyHexes: [s.senderIn.publicKeys[0]!],
      chain: { inputTokens: new Map([[`${TXID_R}:1`, { tokenId: null, atoms: '0' }]]) }
    });
    expect(preserved.ok).toBe(true);
  });

  it('S8: a mismatched proposal id is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    for (const pair of clone.globalUnknownPairs) {
      pair.value = pair.value.map((byte, index) => (index === 0 ? byte ^ 0xff : byte));
    }
    expectRule(s.verify(clone), 'S8');
  });

  it('S9: a new input without a signature is rejected', () => {
    const s = payjoinScenario();
    expectRule(s.verify(s.unsignedContribution), 'S9');
  });

  it('S9: a signature from a key outside the input script is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.unsignedContribution) as Psbt;
    clone.inputs[1]!.partialSigs.push({
      pubKeyHex: s.senderIn.publicKeys[0]!,
      signatureHex: s.receiverSig
    });
    expectRule(s.verify(clone), 'S9');
  });

  it('S9: a sender-key signature on a new input is rejected', () => {
    const s = payjoinScenario();
    const senderSig = signHash(
      derivePrivateKey(s.sender.xPrivKey, 'm/0/0'),
      sighashForInput(s.contribution.unsignedTx, 1),
      'xec'
    );
    const clone = structuredClone(s.contribution) as Psbt;
    clone.inputs[1]!.partialSigs.push({
      pubKeyHex: s.senderIn.publicKeys[0]!,
      signatureHex: senderSig
    });
    expectRule(s.verify(clone), 'S9');
  });

  it('S9: an invalid receiver signature is rejected', () => {
    const s = payjoinScenario();
    const clone = structuredClone(s.contribution) as Psbt;
    clone.inputs[1]!.partialSigs[0]!.signatureHex = '30'.repeat(20);
    expectRule(s.verify(clone), 'S9');
  });
});

describe('payjoin receiver contribution builder', () => {
  function receiverScenario() {
    const s = payjoinScenario();
    const receiverChange = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [s.receiver.xPubKey],
      m: 1,
      n: 1,
      path: 'm/1/0'
    });
    const receiverUtxo = {
      txid: TXID_R,
      vout: 1,
      satoshis: 20000,
      address: s.receiverIn.address,
      path: 'm/0/0',
      publicKeys: s.receiverIn.publicKeys,
      scriptPubKeyHex: s.receiverIn.scriptPubKey!
    };
    return { ...s, receiverChange, receiverUtxo };
  }

  it('reproduces the verified happy-path contribution end-to-end', () => {
    const s = receiverScenario();
    const plan = buildPayjoinContribution({
      coin: 'xec',
      original: s.original,
      paymentScriptPubKeyHex: s.receiverIn.scriptPubKey!,
      receiverUtxos: [s.receiverUtxo],
      changeAddress: { address: s.receiverIn.address, path: 'm/1/0' },
      feePerKb: 2000
    });
    expect(plan.inputIndex).toBe(1);
    expect(plan.feeSat).toBe(816);
    expect(plan.receiverChangeSats).toBe(19636);
    expect(plan.tx.outputs[2]!.satoshis).toBe(19636);

    let contribution = applyPayjoinContribution(s.original, plan);
    contribution = addPartialSignature(
      contribution,
      plan.inputIndex,
      s.receiverIn.publicKeys[0]!,
      signPayjoinContribution(plan, s.receiver.xPrivKey)
    );
    const result = s.verify(contribution);
    expect(result.ok).toBe(true);
  });

  it('supports receiver change to a fresh address (S4 relaxation)', () => {
    const s = receiverScenario();
    const plan = buildPayjoinContribution({
      coin: 'xec',
      original: s.original,
      paymentScriptPubKeyHex: s.receiverIn.scriptPubKey!,
      receiverUtxos: [s.receiverUtxo],
      changeAddress: { address: s.receiverChange.address, path: 'm/1/0' },
      feePerKb: 2000
    });
    let contribution = applyPayjoinContribution(s.original, plan);
    contribution = addPartialSignature(
      contribution,
      plan.inputIndex,
      s.receiverIn.publicKeys[0]!,
      signPayjoinContribution(plan, s.receiver.xPrivKey)
    );
    const result = s.verify(contribution);
    expect(result.ok).toBe(true);
    expect(contribution.unsignedTx.outputs[2]!.address).toBe(s.receiverChange.address);
  });

  it('declines when the receiver holds no UTXO at the payment script', () => {
    const s = receiverScenario();
    const other = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [s.receiver.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/9'
    });
    expect(() =>
      buildPayjoinContribution({
        coin: 'xec',
        original: s.original,
        paymentScriptPubKeyHex: s.receiverIn.scriptPubKey!,
        receiverUtxos: [{ ...s.receiverUtxo, scriptPubKeyHex: other.scriptPubKey! }],
        changeAddress: { address: s.receiverChange.address, path: 'm/1/0' },
        feePerKb: 2000
      })
    ).toThrow(/No receiver UTXO/);
  });

  it('respects the max contribution bound', () => {
    const s = receiverScenario();
    expect(() =>
      buildPayjoinContribution({
        coin: 'xec',
        original: s.original,
        paymentScriptPubKeyHex: s.receiverIn.scriptPubKey!,
        receiverUtxos: [s.receiverUtxo],
        changeAddress: { address: s.receiverChange.address, path: 'm/1/0' },
        feePerKb: 2000,
        maxContributionSats: 10000
      })
    ).toThrow(/No receiver UTXO/);
  });

  it('refuses token UTXOs as contributions', () => {
    const s = receiverScenario();
    expect(() =>
      buildPayjoinContribution({
        coin: 'xec',
        original: s.original,
        paymentScriptPubKeyHex: s.receiverIn.scriptPubKey!,
        receiverUtxos: [
          { ...s.receiverUtxo, token: { tokenId: 'ab'.repeat(32), atoms: '1', isMintBaton: false } }
        ],
        changeAddress: { address: s.receiverChange.address, path: 'm/1/0' },
        feePerKb: 2000
      })
    ).toThrow(/No receiver UTXO/);
  });
});
