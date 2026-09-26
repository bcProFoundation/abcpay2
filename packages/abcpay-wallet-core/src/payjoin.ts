import type { SupportedCoin } from '@bcpros/abcpay-models';
import { scriptPubKeyHexFromAddress } from './address';
import { equalBytes, hexToBytes } from './bytes';
import { minRelayFeePerKb } from './coinselect';
import {
  CWS_PREFIX_PROPOSAL_ID,
  findProprietaryValue,
  psbtUtxoAt,
  pubkeyMatchesInputScript,
  type Psbt
} from './psbt';
import {
  estimateTxSize,
  sighashForInput,
  verifyInputSignature,
  type TxOutput
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
  for (const [index, output] of contributionTx.outputs.entries()) {
    if (index === paymentIndex) continue;
    const scriptHex = outputScriptHex(coin, output);
    if (originalChangeScript !== undefined && scriptHex === originalChangeScript) {
      senderChangeSats += output.satoshis;
      continue;
    }
    if (newInputScripts.has(scriptHex)) {
      receiverChangeSats += output.satoshis;
      continue;
    }
    return fail('S4', `unexpected output ${index} is neither payment, sender change, nor receiver change`);
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

  const regularOutputCount = contributionTx.outputs.length;
  const estimatedSize = estimateTxSize(contributionTx.inputs.length, regularOutputCount, 1, 1);
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
