import { secp256k1 } from '@noble/curves/secp256k1';
import type { SupportedCoin } from '@bcpros/abcpay-models';
import {
  bytesToHex,
  compactSize,
  concatBytes,
  hexToBytes,
  reverseBytes,
  u32LE,
  u64LE
} from './bytes';
import { hash256 } from './hash';
import { derivePrivateKey, derivePublicKey, publicKeyFromPrivate } from './keys';
import {
  p2pkhScriptSig,
  p2shMultisigScriptSig,
  scriptCodeForSighash,
  sortPublicKeys
} from './script';
import { scriptPubKeyFromAddress, validateAddress } from './address';

export const SIGHASH_ALL = 0x01;
export const SIGHASH_FORKID = 0x40;
export const SIGHASH_ALL_FORKID = SIGHASH_ALL | SIGHASH_FORKID;

export interface UnsignedInput {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  path: string;
  publicKeys: string[];
  redeemScript?: string;
  scriptPubKey?: string;
  sequence?: number;
}

export interface TxOutput {
  address: string;
  satoshis: number;
}

export interface UnsignedTx {
  coin: SupportedCoin;
  inputs: UnsignedInput[];
  outputs: TxOutput[];
  version?: number;
  locktime?: number;
}

function txidBytes(txid: string): Uint8Array {
  return reverseBytes(hexToBytes(txid));
}

function serializeOutput(output: TxOutput, coin: SupportedCoin): Uint8Array {
  if (!validateAddress(coin, output.address)) {
    throw new Error(`Invalid output address: ${output.address}`);
  }
  const script = scriptPubKeyFromAddress(coin, output.address);
  return concatBytes(u64LE(output.satoshis), compactSize(script.length), script);
}

function serializeOutpoint(input: UnsignedInput): Uint8Array {
  return concatBytes(txidBytes(input.txid), u32LE(input.vout));
}

function inputScriptPubKey(input: UnsignedInput, coin: SupportedCoin): Uint8Array {
  if (input.scriptPubKey) return hexToBytes(input.scriptPubKey);
  return scriptPubKeyFromAddress(coin, input.address);
}

function serializeTx(opts: {
  version: number;
  inputs: Array<{ input: UnsignedInput; scriptSig: Uint8Array }>;
  outputs: TxOutput[];
  locktime: number;
  coin: SupportedCoin;
}): Uint8Array {
  const parts: Uint8Array[] = [u32LE(opts.version), compactSize(opts.inputs.length)];
  for (const item of opts.inputs) {
    parts.push(
      serializeOutpoint(item.input),
      compactSize(item.scriptSig.length),
      item.scriptSig,
      u32LE(item.input.sequence ?? 0xffffffff)
    );
  }
  parts.push(compactSize(opts.outputs.length));
  for (const output of opts.outputs) {
    parts.push(serializeOutput(output, opts.coin));
  }
  parts.push(u32LE(opts.locktime));
  return concatBytes(...parts);
}

function sighashType(coin: SupportedCoin): number {
  return coin === 'xec' ? SIGHASH_ALL_FORKID : SIGHASH_ALL;
}

function bip143Sighash(tx: UnsignedTx, index: number): Uint8Array {
  const version = tx.version ?? 2;
  const locktime = tx.locktime ?? 0;
  const input = tx.inputs[index];
  const hashPrevouts = hash256(concatBytes(...tx.inputs.map(serializeOutpoint)));
  const hashSequence = hash256(concatBytes(...tx.inputs.map(i => u32LE(i.sequence ?? 0xffffffff))));
  const hashOutputs = hash256(concatBytes(...tx.outputs.map(o => serializeOutput(o, tx.coin))));
  const scriptCode = scriptCodeForSighash({
    scriptPubKey: inputScriptPubKey(input, tx.coin),
    redeemScript: input.redeemScript ? hexToBytes(input.redeemScript) : undefined
  });

  const preimage = concatBytes(
    u32LE(version),
    hashPrevouts,
    hashSequence,
    serializeOutpoint(input),
    scriptCode,
    u64LE(input.satoshis),
    u32LE(input.sequence ?? 0xffffffff),
    hashOutputs,
    u32LE(locktime),
    u32LE(SIGHASH_ALL_FORKID)
  );
  return hash256(preimage);
}

function legacySighash(tx: UnsignedTx, index: number): Uint8Array {
  const version = tx.version ?? 1;
  const locktime = tx.locktime ?? 0;
  const serialized = serializeTx({
    version,
    coin: tx.coin,
    outputs: tx.outputs,
    locktime,
    inputs: tx.inputs.map((input, i) => {
      if (i !== index) {
        return { input, scriptSig: new Uint8Array() };
      }
      const script = input.redeemScript
        ? hexToBytes(input.redeemScript)
        : inputScriptPubKey(input, tx.coin);
      return { input, scriptSig: script };
    })
  });
  return hash256(concatBytes(serialized, u32LE(SIGHASH_ALL)));
}

export function sighashForInput(tx: UnsignedTx, index: number): Uint8Array {
  return tx.coin === 'xec' ? bip143Sighash(tx, index) : legacySighash(tx, index);
}

export function signHash(privateKey: Uint8Array, sighash: Uint8Array, coin: SupportedCoin): string {
  const sig = secp256k1.sign(sighash, privateKey);
  return bytesToHex(concatBytes(sig.toDERRawBytes(), Uint8Array.of(sighashType(coin))));
}

export function verifyInputSignature(
  signatureHex: string,
  sighash: Uint8Array,
  publicKeyHex: string,
  coin?: SupportedCoin
): boolean {
  try {
    if (coin && signatureHex.slice(-2).toLowerCase() !== sighashType(coin).toString(16).padStart(2, '0')) {
      return false;
    }
    const der = hexToBytes(signatureHex.slice(0, -2));
    return secp256k1.verify(der, sighash, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export function signTxInputs(tx: UnsignedTx, xPrivKey: string): string[] {
  return tx.inputs.map((input, index) => {
    const priv = derivePrivateKey(xPrivKey, input.path);
    return signHash(priv, sighashForInput(tx, index), tx.coin);
  });
}

export function copayerPubkeysAtInputs(tx: UnsignedTx, xPubKey: string): string[] {
  return tx.inputs.map(input => derivePublicKey(xPubKey, input.path));
}

function scriptSigForInput(input: UnsignedInput, signaturesByPubkey: Record<string, string>): Uint8Array {
  const ordered = sortPublicKeys(input.publicKeys);
  if (ordered.length === 1) {
    const sig = signaturesByPubkey[ordered[0]];
    if (!sig) throw new Error('Missing signature for P2PKH input');
    return p2pkhScriptSig(hexToBytes(sig), hexToBytes(ordered[0]));
  }

  const signatures: Uint8Array[] = [];
  for (const pubkey of ordered) {
    const sig = signaturesByPubkey[pubkey];
    if (sig) signatures.push(hexToBytes(sig));
  }
  if (!input.redeemScript) throw new Error('Missing redeem script for multisig input');
  return p2shMultisigScriptSig(signatures, hexToBytes(input.redeemScript));
}

export function assembleTxHex(tx: UnsignedTx, signatures: Array<Record<string, string>>): string {
  const version = tx.version ?? (tx.coin === 'xec' ? 2 : 1);
  const raw = serializeTx({
    version,
    coin: tx.coin,
    outputs: tx.outputs,
    locktime: tx.locktime ?? 0,
    inputs: tx.inputs.map((input, i) => ({
      input,
      scriptSig: scriptSigForInput(input, signatures[i] ?? {})
    }))
  });
  return bytesToHex(raw);
}

export function txidFromRaw(rawHex: string): string {
  return bytesToHex(reverseBytes(hash256(hexToBytes(rawHex))));
}

export function estimateTxSize(inputCount: number, outputCount: number, n = 1, m = 1): number {
  const overhead = 10;
  const outputSize = 34 * outputCount;
  const inputSize = n === 1 ? 148 * inputCount : (73 * m + 34 * n + 50) * inputCount;
  return overhead + outputSize + inputSize;
}

export function signAndAssemble(tx: UnsignedTx, xPrivKey: string): {
  raw: string;
  txid: string;
  signatures: string[];
} {
  const signatures = signTxInputs(tx, xPrivKey);
  const byInput = tx.inputs.map((input, i) => {
    const priv = derivePrivateKey(xPrivKey, input.path);
    const pubkey = publicKeyFromPrivate(priv);
    return { [pubkey]: signatures[i] };
  });
  const raw = assembleTxHex(tx, byInput);
  return { raw, txid: txidFromRaw(raw), signatures };
}

export function mergeCopayerSignatures(opts: {
  tx: UnsignedTx;
  copayers: Array<{ copayerId: string; xPubKey: string }>;
  signatures: Record<string, string[]>;
}): Array<Record<string, string>> {
  return opts.tx.inputs.map((_input, inputIndex) => {
    const map: Record<string, string> = {};
    for (const copayer of opts.copayers) {
      const sigs = opts.signatures[copayer.copayerId];
      if (!sigs?.[inputIndex]) continue;
      map[derivePublicKey(copayer.xPubKey, opts.tx.inputs[inputIndex].path)] = sigs[inputIndex];
    }
    return map;
  });
}

export function unsignedTxFromProposal(opts: {
  coin: SupportedCoin;
  inputs: UnsignedInput[];
  outputs: Array<{ toAddress: string; amount: number }>;
  amount: number;
  fee: number;
  changeAddress?: { address: string; path: string };
}): UnsignedTx {
  const totalIn = opts.inputs.reduce((sum, i) => sum + i.satoshis, 0);
  const change = totalIn - opts.amount - opts.fee;
  const outputs: TxOutput[] = opts.outputs.map(o => ({ address: o.toAddress, satoshis: o.amount }));
  if (change > 0 && opts.changeAddress) {
    outputs.push({ address: opts.changeAddress.address, satoshis: change });
  }
  return { coin: opts.coin, inputs: opts.inputs, outputs };
}

export function signaturesByPubkeyFromCopayer(
  tx: UnsignedTx,
  xPubKey: string,
  signatures: string[]
): Array<Record<string, string>> {
  return tx.inputs.map((input, i) => ({
    [derivePublicKey(xPubKey, input.path)]: signatures[i]
  }));
}
