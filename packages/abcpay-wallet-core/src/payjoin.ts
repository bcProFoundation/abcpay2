import type { SupportedCoin } from '@bcpros/abcpay-models';
import { scriptPubKeyHexFromAddress } from './address';
import { compactSize, equalBytes, hexToBytes } from './bytes';
import { dustThreshold, minRelayFeePerKb } from './coinselect';
import { derivePrivateKey } from './keys';
import {
  CWS_PREFIX_PROPOSAL_ID,
  findProprietaryValue,
  psbtUtxoAt,
  pubkeyMatchesInputScript,
  type Psbt,
  type PsbtInputData,
  type PsbtOutputData
} from './psbt';
import { parseMultisigRedeemScript } from './script';
import {
  signHash,
  sighashForInput,
  verifyInputSignature,
  type TxOutput,
  type UnsignedTx
} from './tx';

export interface PayjoinIntent {
  toAddress: string;
  amountSat: number;
  feePerKb?: number;
  feeMultiplier?: number;
  feeCapSat?: number;
}

export interface PayjoinInputToken {
  tokenId: string | null;
  atoms: string;
  isMintBaton?: boolean;
}

export interface PayjoinChainData {
  inputTokens?: Map<string, PayjoinInputToken>;
  minRelayFeePerKb?: number;
}

export type PayjoinVerifyResult =
  | { ok: true; feeSat: number; feeTargetSat: number; feeCapSat: number; newInputCount: number }
  | { ok: false; rule: string; detail: string };

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

function scriptOutputSize(output: TxOutput): number {
  if (output.scriptHex !== undefined) {
    const script = hexToBytes(output.scriptHex);
    if (script[0] === 0x6a) {
      return 8 + compactSize(script.length).length + script.length;
    }
  }
  return 34;
}

function psbtInputSize(input: { redeemScriptHex?: string }): number {
  if (input.redeemScriptHex) {
    try {
      const { m, n } = parseMultisigRedeemScript(hexToBytes(input.redeemScriptHex));
      return 73 * m + 34 * n + 50;
    } catch {
      return 148;
    }
  }
  return 148;
}

function psbtSize(
  inputs: Array<{ redeemScriptHex?: string }>,
  outputs: TxOutput[]
): number {
  return (
    10 +
    outputs.reduce((sum, output) => sum + scriptOutputSize(output), 0) +
    inputs.reduce((sum, input) => sum + psbtInputSize(input), 0)
  );
}

function outputScriptHex(coin: SupportedCoin, output: TxOutput): string {
  if (output.scriptHex) return output.scriptHex.toLowerCase();
  try {
    return scriptPubKeyHexFromAddress(coin, output.address).toLowerCase();
  } catch {
    return `raw:${output.address}`;
  }
}

export function verifyPayjoinContribution(opts: {
  coin: SupportedCoin;
  network: 'livenet' | 'testnet';
  original: Psbt;
  contribution: Psbt;
  intent: PayjoinIntent;
  senderPubKeyHexes: string[];
  chain?: PayjoinChainData;
}): PayjoinVerifyResult {
  const { coin, original, contribution, intent, chain } = opts;
  const fail = (rule: string, detail: string): PayjoinVerifyResult => ({ ok: false, rule, detail });
  const senderKeys = new Set(opts.senderPubKeyHexes.map(key => key.toLowerCase()));
  const originalTx = original.unsignedTx;
  const contributionTx = contribution.unsignedTx;

  const originalOutpoints = new Map<string, number>();
  originalTx.inputs.forEach((input, index) => {
    originalOutpoints.set(outpointKey(input.txid, input.vout), index);
  });
  const contributionOutpoints = new Map<string, number>();
  contributionTx.inputs.forEach((input, index) => {
    contributionOutpoints.set(outpointKey(input.txid, input.vout), index);
  });

  for (const [key, originalIndex] of originalOutpoints) {
    const contributionIndex = contributionOutpoints.get(key);
    if (contributionIndex === undefined) {
      return fail('S1', `sender input ${key} is missing from the contribution`);
    }
    const left = psbtUtxoAt(original, originalIndex);
    const right = psbtUtxoAt(contribution, contributionIndex);
    if (left && right && (left.sats !== right.sats || left.scriptPubKeyHex !== right.scriptPubKeyHex)) {
      return fail('S1', `sender input ${key} was altered by the contribution`);
    }
    if (
      originalTx.inputs[originalIndex]!.redeemScript !==
      contributionTx.inputs[contributionIndex]!.redeemScript
    ) {
      return fail('S1', `sender input ${key} redeem script was altered`);
    }
  }

  const newInputIndexes: number[] = [];
  contributionTx.inputs.forEach((input, index) => {
    if (!originalOutpoints.has(outpointKey(input.txid, input.vout))) {
      newInputIndexes.push(index);
    }
  });
  if (newInputIndexes.length === 0) {
    return fail('S5', 'contribution adds no inputs');
  }

  const newInputScripts = new Set<string>();
  let newInputSats = 0;
  for (const index of newInputIndexes) {
    const input = contributionTx.inputs[index]!;
    const utxo = psbtUtxoAt(contribution, index);
    if (!utxo) {
      return fail('S5', `new input ${outpointKey(input.txid, input.vout)} has no UTXO data`);
    }
    newInputSats += utxo.sats;
    newInputScripts.add(utxo.scriptPubKeyHex.toLowerCase());
    const key = outpointKey(input.txid, input.vout);
    const tokenInfo = chain?.inputTokens?.get(key);
    if (tokenInfo === undefined) {
      return fail('S5', `new input ${key} has no chain-verified token status`);
    }
    if (tokenInfo.tokenId !== null) {
      return fail('S5', `new input ${key} carries token ${tokenInfo.tokenId}; only plain XEC inputs are allowed`);
    }
  }

  const intentScript = scriptPubKeyHexFromAddress(coin, intent.toAddress).toLowerCase();
  const paymentIndexes = contributionTx.outputs
    .map((output, index) => ({ output, index }))
    .filter(
      entry =>
        entry.output.satoshis === intent.amountSat &&
        outputScriptHex(coin, entry.output) === intentScript
    );
  if (paymentIndexes.length !== 1) {
    return fail('S2', `expected exactly one payment output of ${intent.amountSat} to the intended script, found ${paymentIndexes.length}`);
  }
  const paymentIndex = paymentIndexes[0]!.index;
  if (!newInputScripts.has(intentScript)) {
    return fail('S2', 'payment script is not one of the receiver contributed input scripts');
  }

  const originalPaymentIndexes = originalTx.outputs
    .map((output, index) => ({ output, index }))
    .filter(
      entry =>
        entry.output.satoshis === intent.amountSat &&
        outputScriptHex(coin, entry.output) === intentScript
    );
  if (originalPaymentIndexes.length !== 1) {
    return fail('S1', 'original PSBT does not carry the intended payment output');
  }
  const originalChange = originalTx.outputs
    .map((output, index) => ({ output, index }))
    .filter(entry => entry.index !== originalPaymentIndexes[0]!.index);
  if (originalChange.length > 1) {
    return fail('S4', 'original PSBT has more than one non-payment output');
  }
  const originalChangeEntry = originalChange[0];
  const originalChangeScript = originalChangeEntry
    ? outputScriptHex(coin, originalChangeEntry.output)
    : undefined;
  const originalChangeSats = originalChangeEntry?.output.satoshis ?? 0;

  let senderChangeSats = 0;
  let receiverChangeSats = 0;
  let senderChangeCount = 0;
  let receiverChangeCount = 0;
  for (const [index, output] of contributionTx.outputs.entries()) {
    if (index === paymentIndex) continue;
    if (output.scriptHex !== undefined && hexToBytes(output.scriptHex)[0] === 0x6a) {
      return fail('S4', `output ${index} is an OP_RETURN; not allowed in a PayJoin`);
    }
    const scriptHex = outputScriptHex(coin, output);
    if (originalChangeScript !== undefined && scriptHex === originalChangeScript) {
      senderChangeSats += output.satoshis;
      senderChangeCount += 1;
      if (senderChangeCount > 1) {
        return fail('S4', 'more than one sender change output');
      }
      continue;
    }
    receiverChangeSats += output.satoshis;
    receiverChangeCount += 1;
    if (receiverChangeCount > 1) {
      return fail('S4', 'more than one receiver change output');
    }
  }
  if (originalChangeScript === undefined && senderChangeSats > 0) {
    return fail('S3', 'contribution created a sender change output the original did not have');
  }

  const originalFee =
    originalTx.inputs.reduce((sum, input) => sum + input.satoshis, 0) -
    originalTx.outputs.reduce((sum, output) => sum + output.satoshis, 0);
  const totalOut = contributionTx.outputs.reduce((sum, output) => sum + output.satoshis, 0);
  const totalIn = contributionTx.inputs.reduce((sum, input) => sum + input.satoshis, 0);
  const fee = totalIn - totalOut;
  if (fee <= 0) {
    return fail('S6', `fee must be positive, got ${fee}`);
  }
  const deltaFee = fee - originalFee;
  if (newInputSats < receiverChangeSats + deltaFee) {
    return fail(
      'S3',
      `receiver extracts ${receiverChangeSats + deltaFee - newInputSats} sats from the sender's change`
    );
  }
  if (originalChangeScript !== undefined && senderChangeSats < originalChangeSats + newInputSats - receiverChangeSats - deltaFee) {
    return fail('S3', 'sender change was reduced beyond the receiver contribution accounting');
  }

  const estimatedSize = psbtSize(contribution.inputs, contributionTx.outputs);
  const minRelay = chain?.minRelayFeePerKb ?? minRelayFeePerKb(coin);
  const feeFloorSat = ceilDiv(estimatedSize * minRelay, 1000);
  if (fee < feeFloorSat) {
    return fail('S6', `fee ${fee} is below the relay floor ${feeFloorSat}`);
  }
  const feePerKbUsed = intent.feePerKb ?? minRelay;
  const multiplier = intent.feeMultiplier ?? 1.5;
  const feeTargetSat = ceilDiv(estimatedSize * feePerKbUsed, 1000);
  const feeCapSat = intent.feeCapSat ?? ceilDiv(estimatedSize * feePerKbUsed * multiplier, 1000);
  if (fee > feeCapSat) {
    return fail('S6', `fee ${fee} exceeds the fee cap ${feeCapSat}`);
  }

  for (const [originalIndex, input] of original.inputs.entries()) {
    for (const sig of input.partialSigs) {
      const contributionIndex = contributionOutpoints.get(
        outpointKey(originalTx.inputs[originalIndex]!.txid, originalTx.inputs[originalIndex]!.vout)
      )!;
      const match = contribution.inputs[contributionIndex]!.partialSigs.find(
        candidate => candidate.pubKeyHex.toLowerCase() === sig.pubKeyHex.toLowerCase()
      );
      if (!match) {
        return fail('S7', `sender partial signature for ${sig.pubKeyHex} was stripped`);
      }
      if (match.signatureHex !== sig.signatureHex.toLowerCase()) {
        return fail('S7', `sender partial signature for ${sig.pubKeyHex} was altered`);
      }
    }
  }

  const originalProposalId = findProprietaryValue(original.globalUnknownPairs, CWS_PREFIX_PROPOSAL_ID);
  const contributionProposalId = findProprietaryValue(
    contribution.globalUnknownPairs,
    CWS_PREFIX_PROPOSAL_ID
  );
  if (originalProposalId || contributionProposalId) {
    if (!originalProposalId || !contributionProposalId || !equalBytes(originalProposalId, contributionProposalId)) {
      return fail('S8', 'cws.proposal.id does not match between the original and the contribution');
    }
  }

  for (const index of newInputIndexes) {
    const input = contribution.inputs[index]!;
    const utxo = psbtUtxoAt(contribution, index)!;
    const script = hexToBytes(utxo.scriptPubKeyHex);
    const redeemScript = input.redeemScriptHex ? hexToBytes(input.redeemScriptHex) : undefined;
    const verifying = input.partialSigs.filter(sig => {
      if (senderKeys.has(sig.pubKeyHex.toLowerCase())) return false;
      if (!pubkeyMatchesInputScript(script, redeemScript, sig.pubKeyHex)) return false;
      try {
        const sighash = sighashForInput(contributionTx, index);
        return verifyInputSignature(sig.signatureHex, sighash, sig.pubKeyHex, coin);
      } catch {
        return false;
      }
    });
    if (verifying.length === 0) {
      return fail('S9', `new input ${outpointKey(contributionTx.inputs[index]!.txid, contributionTx.inputs[index]!.vout)} has no verifying receiver signature`);
    }
    if (input.partialSigs.some(sig => senderKeys.has(sig.pubKeyHex.toLowerCase()))) {
      return fail('S9', 'contribution attached a sender-key signature to a new input');
    }
  }

  return {
    ok: true,
    feeSat: fee,
    feeTargetSat,
    feeCapSat,
    newInputCount: newInputIndexes.length
  };
}

export interface PayjoinReceiverUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  path: string;
  publicKeys: string[];
  redeemScript?: string;
  scriptPubKeyHex: string;
  token?: { tokenId: string; atoms: string; isMintBaton: boolean } | null;
}

export interface PayjoinContributionPlan {
  tx: UnsignedTx;
  inputIndex: number;
  input: PayjoinReceiverUtxo;
  feeSat: number;
  receiverChangeSats: number;
}

export function buildPayjoinContribution(opts: {
  coin: SupportedCoin;
  original: Psbt;
  paymentScriptPubKeyHex: string;
  receiverUtxos: PayjoinReceiverUtxo[];
  changeAddress: { address: string; path: string };
  feePerKb?: number;
  dustSats?: number;
  maxContributionSats?: number;
}): PayjoinContributionPlan {
  const tx = opts.original.unsignedTx;
  const paymentScript = opts.paymentScriptPubKeyHex.toLowerCase();
  const paymentOutputs = tx.outputs.filter(
    output => outputScriptHex(opts.coin, output) === paymentScript
  );
  if (paymentOutputs.length !== 1) {
    throw new Error('Original PSBT does not have exactly one payment output at the requested script');
  }
  const totalIn = tx.inputs.reduce((sum, input) => sum + input.satoshis, 0);
  const totalOut = tx.outputs.reduce((sum, output) => sum + output.satoshis, 0);
  const originalFee = totalIn - totalOut;
  const originalSize = psbtSize(opts.original.inputs, tx.outputs);
  const originalRate = ceilDiv(originalFee * 1000, Math.max(originalSize, 1));
  const rateCap = (opts.feePerKb ?? minRelayFeePerKb(opts.coin)) * 3;
  if (originalRate > rateCap) {
    throw new Error('Original PSBT fee rate exceeds the receiver fee cap');
  }
  const baseRate = Math.max(
    opts.feePerKb ?? 0,
    originalRate,
    minRelayFeePerKb(opts.coin)
  );
  const dust = opts.dustSats ?? dustThreshold(opts.coin);

  const candidates = opts.receiverUtxos
    .filter(
      utxo =>
        utxo.scriptPubKeyHex.toLowerCase() === paymentScript &&
        !utxo.token &&
        (opts.maxContributionSats === undefined || utxo.satoshis <= opts.maxContributionSats)
    )
    .sort((a, b) => a.satoshis - b.satoshis);

  for (const input of candidates) {
    const size = psbtSize(
      [...opts.original.inputs, { redeemScriptHex: input.redeemScript }],
      [...tx.outputs, { address: opts.changeAddress.address, satoshis: 0 }]
    );
    const targetFee = ceilDiv(size * baseRate, 1000);
    const deltaFee = Math.max(0, targetFee - originalFee);
    const receiverChange = input.satoshis - deltaFee;
    const unsignedInput = {
      txid: input.txid,
      vout: input.vout,
      satoshis: input.satoshis,
      address: input.address,
      path: input.path,
      publicKeys: input.publicKeys,
      redeemScript: input.redeemScript,
      scriptPubKey: input.scriptPubKeyHex
    };
    const inputs = [...tx.inputs, unsignedInput];
    if (receiverChange >= dust) {
      return {
        tx: {
          ...tx,
          inputs,
          outputs: [
            ...tx.outputs,
            { address: opts.changeAddress.address, satoshis: receiverChange }
          ]
        },
        inputIndex: tx.inputs.length,
        input,
        feeSat: originalFee + deltaFee,
        receiverChangeSats: receiverChange
      };
    }
    const donatedFee = originalFee + input.satoshis;
    const donationCap = ceilDiv(size * baseRate * 3, 2000);
    if (receiverChange >= 0 && donatedFee <= donationCap) {
      return {
        tx: { ...tx, inputs, outputs: [...tx.outputs] },
        inputIndex: tx.inputs.length,
        input,
        feeSat: donatedFee,
        receiverChangeSats: 0
      };
    }
  }
  throw new Error('No receiver UTXO can fund a PayJoin contribution within fee limits');
}

export function applyPayjoinContribution(
  original: Psbt,
  plan: PayjoinContributionPlan
): Psbt {
  const inputs: PsbtInputData[] = [
    ...original.inputs,
    {
      utxo: { sats: plan.input.satoshis, scriptPubKeyHex: plan.input.scriptPubKeyHex },
      redeemScriptHex: plan.input.redeemScript,
      partialSigs: [],
      unknownPairs: []
    }
  ];
  const outputs: PsbtOutputData[] = plan.tx.outputs.map(
    (_output, index) => original.outputs[index] ?? { unknownPairs: [] }
  );
  return {
    unsignedTx: plan.tx,
    inputs,
    outputs,
    globalUnknownPairs: original.globalUnknownPairs
  };
}

export function signPayjoinContribution(
  plan: PayjoinContributionPlan,
  xPrivKey: string,
  coin?: SupportedCoin
): string {
  return signHash(
    derivePrivateKey(xPrivKey, plan.input.path),
    sighashForInput(plan.tx, plan.inputIndex),
    coin ?? plan.tx.coin
  );
}
