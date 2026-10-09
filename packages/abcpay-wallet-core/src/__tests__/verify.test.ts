import { describe, expect, it } from 'vitest';
import {
  assembleTxHex,
  createCredentials,
  decodeAddress,
  deriveWalletAddress,
  encodeHashAddress,
  estimateTxSize,
  signaturesByPubkeyFromCopayer,
  signTxInputs,
  tokenSendScript,
  unsignedTxFromProposal,
  verifyProposal,
  bytesToHex,
  type VerifyProposalResult,
  type VerifyProposalShape
} from '../index';

function expectRule(result: VerifyProposalResult, rule: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.rule).toBe(rule);
  }
}

const TXID_A = 'aa'.repeat(32);
const TXID_B = 'bb'.repeat(32);
const TXID_T = 'cc'.repeat(32);

function xecScenario() {
  const creds = createCredentials({ coin: 'xec' });
  const counterparty = createCredentials({ coin: 'xec' });
  const receive0 = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  });
  const change0 = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/1/0'
  });
  const change1 = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/1/1'
  });
  const toAddress = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [counterparty.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  }).address;
  const wallet = {
    walletId: 'wallet-xec-1',
    coin: 'xec' as const,
    network: 'livenet' as const,
    m: 1,
    n: 1,
    memberXpubKeys: [creds.xPubKey],
    changeAddressIndex: 0,
    usedAddresses: [] as string[]
  };
  const proposal: VerifyProposalShape = {
    walletId: 'wallet-xec-1',
    coin: 'xec',
    network: 'livenet',
    outputs: [{ toAddress, amount: 5000 }],
    amount: 5000,
    fee: 452,
    feePerKb: 2000,
    changeAddress: { address: change0.address, path: 'm/1/0' },
    inputs: [
      {
        txid: TXID_A,
        vout: 0,
        satoshis: 10000,
        address: receive0.address,
        path: 'm/0/0',
        publicKeys: receive0.publicKeys,
        scriptPubKey: receive0.scriptPubKey
      }
    ]
  };
  const chain = { inputAmounts: new Map([[`${TXID_A}:0`, 10000]]) };
  const intent = { toAddress, amountSat: 5000 };
  return { creds, wallet, proposal, chain, intent, receive0, change0, change1, toAddress };
}

function tokenScenario() {
  const creds = createCredentials({ coin: 'xec' });
  const counterparty = createCredentials({ coin: 'xec' });
  const tokenIn = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  });
  const xecIn = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/1'
  });
  const change0 = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/1/0'
  });
  const toAddress = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [counterparty.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  }).address;
  const tokenId = 'ab'.repeat(32);
  const opReturn = tokenSendScript('SLP', tokenId, 1, [60n, 40n]);
  const wallet = {
    walletId: 'wallet-token-1',
    coin: 'xec' as const,
    network: 'livenet' as const,
    m: 1,
    n: 1,
    memberXpubKeys: [creds.xPubKey],
    changeAddressIndex: 0,
    usedAddresses: [] as string[]
  };
  const proposal: VerifyProposalShape = {
    walletId: 'wallet-token-1',
    coin: 'xec',
    network: 'livenet',
    outputs: [
      { toAddress: '', amount: 0, scriptHex: bytesToHex(opReturn) },
      { toAddress, amount: 546, atoms: '60', tokenId },
      { toAddress: change0.address, amount: 546, atoms: '40', tokenId },
      { toAddress: change0.address, amount: 3436 }
    ],
    amount: 4528,
    fee: 1018,
    feePerKb: 2000,
    tokenId,
    protocol: 'SLP',
    tokenType: 1,
    changeAddress: { address: change0.address, path: 'm/1/0' },
    inputs: [
      {
        txid: TXID_T,
        vout: 1,
        satoshis: 546,
        address: tokenIn.address,
        path: 'm/0/0',
        publicKeys: tokenIn.publicKeys,
        scriptPubKey: tokenIn.scriptPubKey
      },
      {
        txid: TXID_B,
        vout: 0,
        satoshis: 5000,
        address: xecIn.address,
        path: 'm/0/1',
        publicKeys: xecIn.publicKeys,
        scriptPubKey: xecIn.scriptPubKey
      }
    ]
  };
  const chain = {
    inputAmounts: new Map([
      [`${TXID_T}:1`, 546],
      [`${TXID_B}:0`, 5000]
    ]),
    inputTokens: new Map([
      [`${TXID_T}:1`, { tokenId, atoms: '100', isMintBaton: false }],
      [`${TXID_B}:0`, { tokenId: null, atoms: '0' }]
    ])
  };
  const intent = { toAddress, tokenId, protocol: 'SLP' as const, tokenType: 1, atoms: '60' };
  return { creds, wallet, proposal, chain, intent, toAddress, change0 };
}

describe('verifyProposal happy paths', () => {
  it('accepts a well-formed XEC proposal and rebuilds the verified tx', () => {
    const s = xecScenario();
    const result = verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain: s.chain });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feeSat).toBe(452);
      expect(result.feeTargetSat).toBe(452);
      expect(result.feeCapSat).toBe(678);
      expect(result.feeAboveTarget).toBe(false);
      expect(result.verifiedTx.outputs).toHaveLength(2);
      expect(result.verifiedTx.outputs[0]!.address).toBe(s.toAddress);
      expect(result.verifiedTx.outputs[1]!.satoshis).toBe(4548);
    }
  });

  it('produces byte-identical assembly to unsignedTxFromProposal', () => {
    const s = xecScenario();
    const result = verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain: s.chain });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legacy = unsignedTxFromProposal({
      coin: 'xec',
      inputs: s.proposal.inputs!,
      outputs: s.proposal.outputs,
      amount: s.proposal.amount,
      fee: s.proposal.fee,
      changeAddress: s.proposal.changeAddress
    });
    const sigs = signTxInputs(legacy, s.creds.xPrivKey);
    const rawLegacy = assembleTxHex(legacy, signaturesByPubkeyFromCopayer(legacy, s.creds.xPubKey, sigs));
    const rawVerified = assembleTxHex(
      result.verifiedTx,
      signaturesByPubkeyFromCopayer(result.verifiedTx, s.creds.xPubKey, sigs)
    );
    expect(rawVerified).toBe(rawLegacy);
  });

  it('accepts a well-formed token proposal', () => {
    const s = tokenScenario();
    const result = verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain: s.chain });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feeSat).toBe(1018);
      expect(result.estimatedSize).toBe(481);
      expect(result.feeAboveTarget).toBe(true);
      expect(result.verifiedTx.outputs).toHaveLength(4);
    }
  });

  it('accepts sendMax recomputed from inputs minus fee', () => {
    const s = xecScenario();
    const proposal: VerifyProposalShape = {
      ...s.proposal,
      outputs: [{ toAddress: s.toAddress, amount: 9548 }],
      amount: 9548,
      changeAddress: undefined
    };
    const result = verifyProposal({
      intent: { toAddress: s.toAddress, sendMax: true },
      proposal,
      wallet: s.wallet,
      chain: s.chain
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedTx.outputs).toHaveLength(1);
    }
  });
});

describe('verifyProposal tamper matrix', () => {
  it('R1: redirected payment address', () => {
    const s = xecScenario();
    const other = createCredentials({ coin: 'xec' });
    const attacker = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [other.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/0'
    }).address;
    const proposal = structuredClone(s.proposal);
    proposal.outputs[0]!.toAddress = attacker;
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R1');
  });

  it('R1: wrong network prefix on the payment address', () => {
    const s = xecScenario();
    const decoded = decodeAddress('xec', s.toAddress);
    const wrongNetwork = encodeHashAddress('xec', decoded.type, decoded.hash, 'testnet');
    const result = verifyProposal({
      intent: { ...s.intent, toAddress: wrongNetwork },
      proposal: s.proposal,
      wallet: s.wallet,
      chain: s.chain
    });
    expectRule(result, 'R1');
  });

  it('R2: payment amount off by one sat', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.outputs[0]!.amount = 5001;
    proposal.amount = 5001;
    proposal.fee = 451;
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R2');
  });

  it('R2: sendMax amount does not match inputs minus fee', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.outputs[0]!.amount = 9000;
    proposal.amount = 9000;
    expectRule(
      verifyProposal({ intent: { toAddress: s.toAddress, sendMax: true }, proposal, wallet: s.wallet, chain: s.chain }),
      'R2'
    );
  });

  it('R3: extra output sneaked into the proposal', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.outputs.push({ toAddress: s.toAddress, amount: 1 });
    proposal.amount = 5001;
    proposal.fee = 451;
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R3');
  });

  it('R3: token fields on a plain XEC send', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.tokenId = 'ab'.repeat(32);
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R7');
  });

  it('R4: change address already used', () => {
    const s = xecScenario();
    const wallet = { ...s.wallet, usedAddresses: [s.change0.address] };
    expectRule(verifyProposal({ intent: s.intent, proposal: s.proposal, wallet, chain: s.chain }), 'R4');
  });

  it('R4: change index below the wallet change pointer', () => {
    const s = xecScenario();
    const wallet = { ...s.wallet, changeAddressIndex: 1 };
    expectRule(verifyProposal({ intent: s.intent, proposal: s.proposal, wallet, chain: s.chain }), 'R4');
  });

  it('R4: change address that does not derive from the wallet', () => {
    const s = xecScenario();
    const other = createCredentials({ coin: 'xec' });
    const foreignChange = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [other.xPubKey],
      m: 1,
      n: 1,
      path: 'm/1/0'
    }).address;
    const proposal = structuredClone(s.proposal);
    proposal.changeAddress = { address: foreignChange, path: 'm/1/0' };
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R4');
  });

  it('R4: change path not on the change branch', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.changeAddress = { address: s.change0.address, path: 'm/0/5' };
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R4');
  });

  it('R5: inflated fee above the cap', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.fee = 1000;
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R5');
  });

  it('R5: fee below the relay floor', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.fee = 1;
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R5');
  });

  it('R5: outputs exceed inputs', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.outputs[0]!.amount = 9700;
    proposal.amount = 9700;
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R5');
  });

  it('R5a: fee above the level target is surfaced, above the cap is rejected', () => {
    const s = xecScenario();
    const aboveTarget = verifyProposal({
      intent: { ...s.intent, feePerKb: 1900 },
      proposal: s.proposal,
      wallet: s.wallet,
      chain: s.chain
    });
    expect(aboveTarget.ok).toBe(true);
    if (aboveTarget.ok) expect(aboveTarget.feeAboveTarget).toBe(true);
    const overCap = verifyProposal({
      intent: { ...s.intent, feePerKb: 1000 },
      proposal: s.proposal,
      wallet: s.wallet,
      chain: s.chain
    });
    expectRule(overCap, 'R5');
  });

  it('R6: input amount does not match the chain value', () => {
    const s = xecScenario();
    const chain = { inputAmounts: new Map([[`${TXID_A}:0`, 12000]]) };
    expectRule(verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain }), 'R6');
  });

  it('R6: input amount not chain-verified at all', () => {
    const s = xecScenario();
    const chain = { inputAmounts: new Map<string, number>() };
    expectRule(verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain }), 'R6');
  });

  it('R6: foreign input not owned by the wallet', () => {
    const s = xecScenario();
    const other = createCredentials({ coin: 'xec' });
    const foreign = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [other.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/0'
    });
    const proposal = structuredClone(s.proposal);
    proposal.inputs = [
      {
        txid: TXID_A,
        vout: 0,
        satoshis: 10000,
        address: foreign.address,
        path: 'm/0/0',
        publicKeys: foreign.publicKeys,
        scriptPubKey: foreign.scriptPubKey
      }
    ];
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R6');
  });

  it('R7: wrong token id', () => {
    const s = tokenScenario();
    const proposal = structuredClone(s.proposal);
    proposal.tokenId = 'dd'.repeat(32);
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R7');
  });

  it('R8: tampered OP_RETURN', () => {
    const s = tokenScenario();
    const proposal = structuredClone(s.proposal);
    proposal.outputs[0]!.scriptHex = bytesToHex(tokenSendScript('SLP', 'ab'.repeat(32), 1, [61n, 39n]));
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R8');
  });

  it('R9: recipient token atoms altered', () => {
    const s = tokenScenario();
    const proposal = structuredClone(s.proposal);
    proposal.outputs[1]!.atoms = '61';
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R9');
  });

  it('R9: token change atoms do not match inputs minus payment', () => {
    const s = tokenScenario();
    const proposal = structuredClone(s.proposal);
    proposal.outputs[2]!.atoms = '39';
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R9');
  });

  it('R10: mint baton input must not be spent', () => {
    const s = tokenScenario();
    const chain = {
      inputAmounts: s.chain.inputAmounts,
      inputTokens: new Map([
        [`${TXID_T}:1`, { tokenId: 'ab'.repeat(32), atoms: '100', isMintBaton: true }],
        [`${TXID_B}:0`, { tokenId: null, atoms: '0' }]
      ])
    };
    expectRule(verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain }), 'R10');
  });

  it('R10: token input without chain-verified token status', () => {
    const s = tokenScenario();
    const chain = {
      inputAmounts: s.chain.inputAmounts,
      inputTokens: new Map([[`${TXID_B}:0`, { tokenId: null, atoms: '0' }]])
    };
    expectRule(verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain }), 'R10');
  });

  it('R10: token input carrying a different token', () => {
    const s = tokenScenario();
    const chain = {
      inputAmounts: s.chain.inputAmounts,
      inputTokens: new Map([
        [`${TXID_T}:1`, { tokenId: 'ee'.repeat(32), atoms: '100', isMintBaton: false }],
        [`${TXID_B}:0`, { tokenId: null, atoms: '0' }]
      ])
    };
    expectRule(verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain }), 'R10');
  });

  it('R10: unspent token UTXOs and mint batons do not fail a plain XEC send', () => {
    const s = xecScenario();
    const chain = {
      inputAmounts: s.chain.inputAmounts,
      inputTokens: new Map([
        [`${TXID_A}:0`, { tokenId: null, atoms: '0' }],
        [`${TXID_T}:9`, { tokenId: 'ab'.repeat(32), atoms: '50', isMintBaton: false }],
        [`${TXID_B}:7`, { tokenId: 'cd'.repeat(32), atoms: '0', isMintBaton: true }]
      ])
    };
    const result = verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain });
    expect(result.ok).toBe(true);
  });

  it('R10: unspent other-token UTXOs do not fail a token send of a different id', () => {
    const s = tokenScenario();
    const chain = {
      inputAmounts: s.chain.inputAmounts,
      inputTokens: new Map([
        [`${TXID_T}:1`, { tokenId: 'ab'.repeat(32), atoms: '100', isMintBaton: false }],
        [`${TXID_B}:0`, { tokenId: null, atoms: '0' }],
        [`${TXID_A}:3`, { tokenId: 'ee'.repeat(32), atoms: '9', isMintBaton: false }],
        [`${TXID_A}:4`, { tokenId: 'ab'.repeat(32), atoms: '0', isMintBaton: true }]
      ])
    };
    const result = verifyProposal({ intent: s.intent, proposal: s.proposal, wallet: s.wallet, chain });
    expect(result.ok).toBe(true);
  });

  it('R12: feePerKb outside the requested level band', () => {
    const s = xecScenario();
    const chain = { inputAmounts: s.chain.inputAmounts, feePerKbBand: { min: 1500, max: 2500 } };
    const proposal = structuredClone(s.proposal);
    proposal.feePerKb = 3000;
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain }), 'R12');
  });

  it('R13: proposal for a different wallet', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.walletId = 'wallet-other';
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R13');
  });

  it('R13: action attributed to a non-member copayer', () => {
    const s = xecScenario();
    const proposal = structuredClone(s.proposal);
    proposal.signatures = { 'not-a-member': ['deadbeef'] };
    expectRule(verifyProposal({ intent: s.intent, proposal, wallet: s.wallet, chain: s.chain }), 'R13');
  });
});

describe('verifyProposal multisig', () => {
  function multisigScenario() {
    const a = createCredentials({ coin: 'xec' });
    const b = createCredentials({ coin: 'xec' });
    const xPubKeys = [a.xPubKey, b.xPubKey];
    const receive = deriveWalletAddress({ coin: 'xec', xPubKeys, m: 2, n: 2, path: 'm/0/0' });
    const change = deriveWalletAddress({ coin: 'xec', xPubKeys, m: 2, n: 2, path: 'm/1/0' });
    const counterparty = createCredentials({ coin: 'xec' });
    const toAddress = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [counterparty.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/0'
    }).address;
    const wallet = {
      walletId: 'wallet-2of2',
      coin: 'xec' as const,
      network: 'livenet' as const,
      m: 2,
      n: 2,
      memberXpubKeys: xPubKeys,
      changeAddressIndex: 0,
      usedAddresses: [] as string[]
    };
    const proposal: VerifyProposalShape = {
      walletId: 'wallet-2of2',
      coin: 'xec',
      network: 'livenet',
      outputs: [{ toAddress, amount: 3000 }],
      amount: 3000,
      fee: estimateTxSize(1, 2, 2, 2) * 2,
      feePerKb: 2000,
      changeAddress: { address: change.address, path: 'm/1/0' },
      inputs: [
        {
          txid: TXID_A,
          vout: 0,
          satoshis: 10000,
          address: receive.address,
          path: 'm/0/0',
          publicKeys: receive.publicKeys,
          redeemScript: receive.redeemScript,
          scriptPubKey: receive.scriptPubKey
        }
      ]
    };
    const chain = { inputAmounts: new Map([[`${TXID_A}:0`, 10000]]) };
    return { a, b, wallet, proposal, chain, toAddress, change };
  }

  it('accepts a well-formed 2-of-2 proposal', () => {
    const s = multisigScenario();
    const result = verifyProposal({
      intent: { toAddress: s.toAddress, amountSat: 3000 },
      proposal: s.proposal,
      wallet: s.wallet,
      chain: s.chain
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedTx.outputs).toHaveLength(2);
      expect(result.verifiedTx.inputs[0]!.redeemScript).toBe(s.proposal.inputs![0]!.redeemScript);
    }
  });

  it('rejects a proposal whose input keys are not the wallet ring', () => {
    const s = multisigScenario();
    const outsider = createCredentials({ coin: 'xec' });
    const proposal = structuredClone(s.proposal);
    proposal.inputs![0]!.publicKeys = [outsider.xPubKey, s.b.xPubKey];
    expectRule(
      verifyProposal({
        intent: { toAddress: s.toAddress, amountSat: 3000 },
        proposal,
        wallet: s.wallet,
        chain: s.chain
      }),
      'R6'
    );
  });
});

describe('verifyProposal sized like the node', () => {
  it('matches the node fee math for plain XEC sends', () => {
    const s = xecScenario();
    const size = estimateTxSize(1, 2, 1, 1);
    const expectedFee = Math.max(1, Math.ceil((size * 2000) / 1000));
    expect(s.proposal.fee).toBe(expectedFee);
  });
});
