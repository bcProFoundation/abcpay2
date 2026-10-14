import type { SupportedCoin } from '@bcpros/abcpay-models';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import {
  addressMatchesDerivation,
  decodeAddress,
  deriveWalletAddress,
  scriptKey,
  scriptPubKeyHexFromAddress
} from './address';
import { compactSize, equalBytes, hexToBytes } from './bytes';
import { dustThreshold, minRelayFeePerKb } from './coinselect';
import { copayerIdFromXpub, parsePath } from './keys';
import { sortPublicKeys } from './script';
import { tokenSendScript, type TokenProtocol } from './tokens';
import { estimateTxSize, type TxOutput, type UnsignedInput, type UnsignedTx } from './tx';

export interface VerifyProposalIntent {
  toAddress: string;
  amountSat?: number;
  sendMax?: boolean;
  tokenId?: string;
  protocol?: TokenProtocol;
  tokenType?: number;
  atoms?: string;
  feePerKb?: number;
  feeMultiplier?: number;
  feeCapSat?: number;
}

export interface VerifyInputToken {
  tokenId: string | null;
  atoms: string;
  isMintBaton?: boolean;
}

export interface VerifyWalletFacts {
  walletId: string;
  coin: SupportedCoin;
  network: 'livenet' | 'testnet';
  m: number;
  n: number;
  memberXpubKeys: string[];
  changeAddressIndex: number;
  usedAddresses?: string[];
}

export interface VerifyChainData {
  inputAmounts: Map<string, number>;
  inputTokens?: Map<string, VerifyInputToken>;
  feePerKbBand?: { min: number; max: number };
}

export interface VerifyProposalInput {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  path: string;
  publicKeys: string[];
  redeemScript?: string;
  scriptPubKey?: string;
}

export interface VerifyProposalOutput {
  toAddress: string;
  amount: number;
  message?: string;
  scriptHex?: string;
  atoms?: string;
  tokenId?: string;
}

export interface VerifyProposalShape {
  walletId: string;
  coin: SupportedCoin;
  network: string;
  outputs: VerifyProposalOutput[];
  amount: number;
  fee: number;
  feePerKb: number;
  tokenId?: string;
  protocol?: TokenProtocol;
  tokenType?: number;
  changeAddress?: { address: string; path: string };
  inputs?: VerifyProposalInput[];
  signatures?: Record<string, string[]>;
  actions?: Array<{ copayerId: string }>;
}

export type VerifyProposalResult =
  | {
      ok: true;
      verifiedTx: UnsignedTx;
      feeSat: number;
      feeTargetSat: number;
      feeCapSat: number;
      estimatedSize: number;
      feeAboveTarget: boolean;
    }
  | { ok: false; rule: string; detail: string };

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function addressScriptHex(coin: SupportedCoin, address: string): string | undefined {
  try {
    return scriptPubKeyHexFromAddress(coin, address).toLowerCase();
  } catch {
    return undefined;
  }
}

function addressPrefixOk(
  coin: SupportedCoin,
  network: 'livenet' | 'testnet',
  address: string
): boolean {
  if (coin !== 'xec' || !address.includes(':')) return true;
  try {
    const expected = COIN_CONFIGS.xec.protocolPrefix[network].toLowerCase();
    const actual = (decodeAddress(coin, address).prefix ?? '').toLowerCase();
    return !actual || actual === expected;
  } catch {
    return false;
  }
}

function sameAddressScript(
  coin: SupportedCoin,
  network: 'livenet' | 'testnet',
  a: string,
  b: string
): boolean {
  if (!addressPrefixOk(coin, network, a) || !addressPrefixOk(coin, network, b)) return false;
  const scriptA = addressScriptHex(coin, a);
  const scriptB = addressScriptHex(coin, b);
  return scriptA !== undefined && scriptA === scriptB;
}

function parsedChangePath(path: string): { isChange: boolean; index: number } | undefined {
  try {
    const parsed = parsePath(path);
    if (!Number.isInteger(parsed.index) || parsed.index < 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function serializedOutputSize(output: VerifyProposalOutput): number {
  if (output.scriptHex !== undefined) {
    const script = hexToBytes(output.scriptHex);
    return 8 + compactSize(script.length).length + script.length;
  }
  return 34;
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

export function verifyProposal(opts: {
  intent: VerifyProposalIntent;
  proposal: VerifyProposalShape;
  wallet: VerifyWalletFacts;
  chain: VerifyChainData;
}): VerifyProposalResult {
  const { intent, proposal, wallet, chain } = opts;
  const fail = (rule: string, detail: string): VerifyProposalResult => ({ ok: false, rule, detail });
  const { coin, network } = wallet;
  const dust = dustThreshold(coin);
  const isTokenSend = intent.tokenId !== undefined;
  const inputs = proposal.inputs ?? [];

  if (proposal.walletId !== wallet.walletId) {
    return fail('R13', `proposal walletId ${proposal.walletId} does not match local wallet ${wallet.walletId}`);
  }
  if (proposal.coin !== coin) {
    return fail('R13', `proposal coin ${proposal.coin} does not match wallet coin ${coin}`);
  }
  if (proposal.network !== network) {
    return fail('R13', `proposal network ${proposal.network} does not match wallet network ${network}`);
  }
  if (inputs.length === 0) {
    return fail('R13', 'proposal has no inputs');
  }
  const memberIds = new Set(wallet.memberXpubKeys.map(xpub => copayerIdFromXpub(coin, xpub)));
  const attributed = [
    ...Object.keys(proposal.signatures ?? {}),
    ...(proposal.actions ?? []).map(action => action.copayerId)
  ];
  for (const copayerId of attributed) {
    if (!memberIds.has(copayerId)) {
      return fail('R13', `proposal attributes an action to non-member copayer ${copayerId}`);
    }
  }

  const verifiedInputs: UnsignedInput[] = [];
  let totalIn = 0;
  let tokenInputAtoms = 0n;
  for (const input of inputs) {
    const key = outpointKey(input.txid, input.vout);
    const derived = (() => {
      try {
        return deriveWalletAddress({
          coin,
          network,
          xPubKeys: wallet.memberXpubKeys,
          m: wallet.m,
          n: wallet.n,
          path: input.path
        });
      } catch {
        return undefined;
      }
    })();
    if (!derived || !sameAddressScript(coin, network, derived.address, input.address)) {
      return fail('R6', `input ${key} at ${input.path} is not owned by this wallet`);
    }
    if (input.scriptPubKey !== undefined) {
      const declared = input.scriptPubKey.toLowerCase();
      const expected = (derived.scriptPubKey ?? '').toLowerCase();
      if (declared !== expected) {
        return fail('R6', `input ${key} scriptPubKey does not match its address`);
      }
    }
    const derivedKeys = sortPublicKeys(derived.publicKeys);
    const inputKeys = sortPublicKeys(input.publicKeys ?? []);
    if (derivedKeys.join(',') !== inputKeys.join(',')) {
      return fail('R6', `input ${key} public keys do not match wallet derivation`);
    }
    if ((input.redeemScript ?? '') !== (derived.redeemScript ?? '')) {
      return fail('R6', `input ${key} redeem script does not match wallet derivation`);
    }
    const amount = chain.inputAmounts.get(key);
    if (amount === undefined) {
      return fail('R6', `input ${key} has no chain-verified amount; refusing to sign`);
    }
    if (amount !== input.satoshis) {
      return fail('R6', `input ${key} amount ${input.satoshis} does not match chain value ${amount}`);
    }
    totalIn += amount;

    const tokenInfo = chain.inputTokens?.get(key);
    if (tokenInfo !== undefined && tokenInfo.tokenId !== null) {
      tokenInputAtoms += BigInt(tokenInfo.atoms);
    } else if (isTokenSend && tokenInfo === undefined) {
      return fail('R10', `input ${key} has no chain-verified token status; refusing to sign`);
    }
    verifiedInputs.push({
      txid: input.txid,
      vout: input.vout,
      satoshis: amount,
      address: input.address,
      path: input.path,
      publicKeys: input.publicKeys ?? [],
      redeemScript: input.redeemScript,
      scriptPubKey: input.scriptPubKey
    });
  }

  const spentKeys = inputs.map(input => outpointKey(input.txid, input.vout));
  if (!isTokenSend && chain.inputTokens) {
    for (const key of spentKeys) {
      const tokenInfo = chain.inputTokens.get(key);
      if (tokenInfo && tokenInfo.tokenId !== null) {
        return fail('R10', `input ${key} carries token ${tokenInfo.tokenId} in a non-token send`);
      }
    }
  }

  const outputs = proposal.outputs ?? [];
  if (outputs.length === 0) {
    return fail('R3', 'proposal has no outputs');
  }
  const outputsAmount = outputs.reduce((sum, output) => sum + output.amount, 0);
  if (outputsAmount !== proposal.amount) {
    return fail('R3', `proposal.amount ${proposal.amount} does not match output sum ${outputsAmount}`);
  }

  const changeAmount = totalIn - proposal.amount - proposal.fee;
  if (changeAmount < 0) {
    return fail('R5', `outputs exceed inputs by ${-changeAmount} sats`);
  }
  let changeOut: { address: string; path: string; satoshis: number } | undefined;
  if (changeAmount > 0) {
    if (!proposal.changeAddress) {
      return fail('R5', 'positive change but proposal carries no change address');
    }
    changeOut = { ...proposal.changeAddress, satoshis: changeAmount };
  }

  const assembled: VerifyProposalOutput[] = [...outputs];
  if (changeOut) {
    assembled.push({ toAddress: changeOut.address, amount: changeOut.satoshis });
  }

  const opReturnOutputs = assembled.filter(output => output.scriptHex !== undefined);
  const tokenOutputs = assembled.filter(output => output.atoms !== undefined);
  const plainOutputs = assembled.filter(
    output => output.scriptHex === undefined && output.atoms === undefined
  );

  if (isTokenSend) {
    const intentTokenId = intent.tokenId!.toLowerCase();
    if ((proposal.tokenId ?? '').toLowerCase() !== intentTokenId) {
      return fail('R7', `proposal tokenId ${proposal.tokenId} does not match intent ${intent.tokenId}`);
    }
    if (proposal.protocol !== intent.protocol) {
      return fail('R7', `proposal protocol ${proposal.protocol} does not match intent ${intent.protocol}`);
    }
    if (intent.tokenType !== undefined && proposal.tokenType !== intent.tokenType) {
      return fail('R7', `proposal tokenType ${proposal.tokenType} does not match intent ${intent.tokenType}`);
    }
    if (opReturnOutputs.length !== 1) {
      return fail('R3', `token send requires exactly one OP_RETURN output, found ${opReturnOutputs.length}`);
    }
    if (tokenOutputs.length < 1 || tokenOutputs.length > 2) {
      return fail('R3', `token send requires 1 or 2 token outputs, found ${tokenOutputs.length}`);
    }
    if (plainOutputs.length > 1) {
      return fail('R3', `token send allows at most one plain XEC change output, found ${plainOutputs.length}`);
    }
  } else {
    if (
      proposal.tokenId !== undefined ||
      proposal.protocol !== undefined ||
      proposal.tokenType !== undefined
    ) {
      return fail('R7', 'non-token send must not carry token fields');
    }
    if (tokenOutputs.length > 0 || opReturnOutputs.length > 0) {
      return fail('R3', 'non-token send must not carry token outputs or OP_RETURN');
    }
    if (plainOutputs.length > 2 || plainOutputs.length < 1) {
      return fail('R3', `XEC send requires payment plus optional change, found ${plainOutputs.length} outputs`);
    }
    if (assembled.length > 2) {
      return fail('R3', `XEC send must have at most 2 outputs, found ${assembled.length}`);
    }
  }

  const paymentOutput = isTokenSend
    ? tokenOutputs.find(output =>
        sameAddressScript(coin, network, output.toAddress, intent.toAddress)
      )
    : plainOutputs.find(output => sameAddressScript(coin, network, output.toAddress, intent.toAddress));

  if (!paymentOutput) {
    return fail('R1', 'no payment output matches the intended recipient script');
  }
  if (
    !addressPrefixOk(coin, network, intent.toAddress) ||
    !addressPrefixOk(coin, network, paymentOutput.toAddress)
  ) {
    return fail('R1', 'payment address uses the wrong network prefix');
  }
  const paymentCount = (isTokenSend ? tokenOutputs : plainOutputs).filter(output =>
    sameAddressScript(coin, network, output.toAddress, intent.toAddress)
  ).length;
  if (paymentCount !== 1) {
    return fail('R1', `expected exactly one payment output, found ${paymentCount}`);
  }

  if (isTokenSend) {
    if (BigInt(intent.atoms ?? '0') <= 0n) {
      return fail('R9', 'token intent amount must be greater than zero');
    }
  } else if (intent.sendMax) {
    const recomputed = totalIn - proposal.fee;
    if (paymentOutput.amount !== recomputed) {
      return fail('R2', `sendMax amount ${paymentOutput.amount} does not match inputs minus fee ${recomputed}`);
    }
    if (recomputed < dust) {
      return fail('R2', `sendMax amount ${recomputed} is below dust ${dust}`);
    }
    if (changeOut) {
      return fail('R2', 'sendMax proposal must not produce change');
    }
  } else {
    if (intent.amountSat === undefined) {
      return fail('R2', 'intent carries no amount for an XEC send');
    }
    if (paymentOutput.amount !== intent.amountSat) {
      return fail('R2', `payment amount ${paymentOutput.amount} does not match intent ${intent.amountSat}`);
    }
    if (intent.amountSat < dust) {
      return fail('R2', `payment amount ${intent.amountSat} is below dust ${dust}`);
    }
  }

  const changeOutputs = assembled.filter(
    output =>
      output !== paymentOutput &&
      proposal.changeAddress !== undefined &&
      sameAddressScript(coin, network, output.toAddress, proposal.changeAddress.address)
  );
  const foreignOutputs = assembled.filter(
    output =>
      output !== paymentOutput &&
      !changeOutputs.includes(output) &&
      !(isTokenSend && output.scriptHex !== undefined)
  );
  if (foreignOutputs.length > 0) {
    return fail('R3', 'proposal contains outputs that are neither payment nor change');
  }

  const usedScripts = new Set((wallet.usedAddresses ?? []).map(address => scriptKey(coin, address)));
  const checkedChangePaths = new Set<string>();
  for (const changeOutput of changeOutputs) {
    const changeAddress = proposal.changeAddress!;
    const parsed = parsedChangePath(changeAddress.path);
    if (!parsed || !parsed.isChange) {
      return fail('R4', `change path ${changeAddress.path} is not on the change branch`);
    }
    if (parsed.index < wallet.changeAddressIndex) {
      return fail(
        'R4',
        `change index ${parsed.index} is below the wallet change pointer ${wallet.changeAddressIndex}`
      );
    }
    if (!addressMatchesDerivation({
      coin,
      network,
      xPubKeys: wallet.memberXpubKeys,
      m: wallet.m,
      n: wallet.n,
      path: changeAddress.path,
      address: changeOutput.toAddress
    })) {
      return fail('R4', `change output ${changeOutput.toAddress} does not match wallet derivation`);
    }
    const changeKey = scriptKey(coin, changeOutput.toAddress);
    if (usedScripts.has(changeKey)) {
      return fail('R4', `change address ${changeOutput.toAddress} has been used before`);
    }
    checkedChangePaths.add(changeAddress.path);
  }
  if (isTokenSend) {
    for (const tokenOutput of tokenOutputs) {
      if (tokenOutput === paymentOutput) continue;
      if (!changeOutputs.includes(tokenOutput)) {
        return fail('R9', 'token change output does not pay the proposal change address');
      }
    }
    if (changeOut && !checkedChangePaths.has(changeOut.path)) {
      return fail('R4', 'appended change output does not match the verified change address');
    }
  }

  const regularOutputCount = assembled.filter(output => output.scriptHex === undefined).length;
  const scriptBytes = opReturnOutputs.reduce(
    (sum, output) => sum + serializedOutputSize(output),
    0
  );
  const estimatedSize =
    estimateTxSize(inputs.length, regularOutputCount, wallet.n, wallet.m) + scriptBytes;
  const fee = totalIn - assembled.reduce((sum, output) => sum + output.amount, 0);
  if (fee !== proposal.fee) {
    return fail('R5', `proposal fee ${proposal.fee} does not match recomputed fee ${fee}`);
  }
  if (fee <= 0) {
    return fail('R5', `fee must be positive, got ${fee}`);
  }
  const minRelay = minRelayFeePerKb(coin);
  const feeFloorSat = ceilDiv(estimatedSize * minRelay, 1000);
  if (fee < feeFloorSat) {
    return fail('R5', `fee ${fee} is below the relay floor ${feeFloorSat}`);
  }
  const feePerKbUsed = intent.feePerKb ?? proposal.feePerKb;
  const multiplier = intent.feeMultiplier ?? 1.5;
  const feeTargetSat = ceilDiv(estimatedSize * feePerKbUsed, 1000);
  const feeCapSat = intent.feeCapSat ?? ceilDiv(estimatedSize * feePerKbUsed * multiplier, 1000);
  if (fee > feeCapSat) {
    return fail('R5', `fee ${fee} exceeds the fee cap ${feeCapSat}`);
  }
  if (chain.feePerKbBand) {
    if (proposal.feePerKb < chain.feePerKbBand.min || proposal.feePerKb > chain.feePerKbBand.max) {
      return fail(
        'R12',
        `feePerKb ${proposal.feePerKb} is outside the requested level band ${chain.feePerKbBand.min}-${chain.feePerKbBand.max}`
      );
    }
  } else if (proposal.feePerKb < minRelay) {
    return fail('R12', `feePerKb ${proposal.feePerKb} is below the minimum relay rate ${minRelay}`);
  }

  if (isTokenSend) {
    const intentAtoms = BigInt(intent.atoms ?? '0');
    const recipientTokenId = intent.tokenId!.toLowerCase();
    for (const key of spentKeys) {
      const tokenInfo = chain.inputTokens?.get(key);
      if (!tokenInfo) continue;
      if (tokenInfo.tokenId !== null && tokenInfo.tokenId.toLowerCase() !== recipientTokenId) {
        return fail('R10', `input ${key} carries unexpected token ${tokenInfo.tokenId}`);
      }
      if (tokenInfo.isMintBaton) {
        return fail('R10', `input ${key} is a mint baton and must not be spent`);
      }
    }
    if (tokenInputAtoms < intentAtoms) {
      return fail('R10', `token inputs carry ${tokenInputAtoms} atoms, less than the payment ${intentAtoms}`);
    }
    const tokenOutputCount = tokenOutputs.length;
    if (totalIn < dust * tokenOutputCount + fee) {
      return fail('R10', `inputs ${totalIn} cannot cover token output dust and fee`);
    }

    const changeAtoms = tokenInputAtoms - intentAtoms;
    const expectedAtoms = changeAtoms > 0n ? [intentAtoms, changeAtoms] : [intentAtoms];
    const expectedScript = tokenSendScript(
      intent.protocol!,
      recipientTokenId,
      intent.tokenType ?? (intent.protocol === 'ALP' ? 0 : 1),
      expectedAtoms
    );
    const actualScript = hexToBytes(opReturnOutputs[0]!.scriptHex!);
    if (!equalBytes(expectedScript, actualScript)) {
      return fail('R8', 'OP_RETURN does not match the recomputed token send script');
    }

    const recipientTokenOutput = tokenOutputs.find(output => output === paymentOutput);
    if (!recipientTokenOutput) {
      return fail('R9', 'recipient token output missing');
    }
    if (BigInt(recipientTokenOutput.atoms ?? '0') !== intentAtoms) {
      return fail('R9', `payment atoms ${recipientTokenOutput.atoms} do not match intent ${intent.atoms}`);
    }
    if ((recipientTokenOutput.tokenId ?? '').toLowerCase() !== recipientTokenId) {
      return fail('R9', `recipient token output tokenId ${recipientTokenOutput.tokenId} is wrong`);
    }
    if (recipientTokenOutput.amount < dust) {
      return fail('R9', `recipient token output sats ${recipientTokenOutput.amount} is below dust`);
    }
    const changeTokenOutput = tokenOutputs.find(output => output !== paymentOutput);
    if (changeAtoms > 0n) {
      if (!changeTokenOutput) {
        return fail('R9', 'token change output missing');
      }
      if (BigInt(changeTokenOutput.atoms ?? '0') !== changeAtoms) {
        return fail(
          'R9',
          `token change atoms ${changeTokenOutput.atoms} do not match input minus payment ${changeAtoms}`
        );
      }
      if ((changeTokenOutput.tokenId ?? '').toLowerCase() !== recipientTokenId) {
        return fail('R9', `token change output tokenId ${changeTokenOutput.tokenId} is wrong`);
      }
      if (changeTokenOutput.amount < dust) {
        return fail('R9', `token change output sats ${changeTokenOutput.amount} is below dust`);
      }
    } else if (changeTokenOutput) {
      return fail('R9', 'token change output present but there are no change atoms');
    }
    for (const plainOutput of plainOutputs) {
      if (plainOutput !== paymentOutput && !changeOutputs.includes(plainOutput)) {
        return fail('R3', 'unexpected plain output in token send');
      }
    }
  }

  const verifiedTx: UnsignedTx = {
    coin,
    inputs: verifiedInputs,
    outputs: assembled.map(
      (output): TxOutput => ({
        address: output.toAddress,
        satoshis: output.amount,
        scriptHex: output.scriptHex,
        atoms: output.atoms,
        tokenId: output.tokenId
      })
    )
  };

  return {
    ok: true,
    verifiedTx,
    feeSat: fee,
    feeTargetSat,
    feeCapSat,
    estimatedSize,
    feeAboveTarget: fee > feeTargetSat
  };
}
