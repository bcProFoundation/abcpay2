import type { SupportedCoin } from '@bcpros/abcpay-models';
import type { Network } from '@bcpros/abcpay-models';
import {
  bytesToHex,
  compactSize,
  concatBytes,
  equalBytes,
  hexToBytes,
  readVarSlice,
  utf8ToBytes,
  u64LE,
  varSlice
} from './bytes';
import {
  scriptPubKeyHexFromAddress,
  scriptPubKeyToAddress
} from './address';
import { hash160 } from './hash';
import { parseMultisigRedeemScript } from './script';
import type { TokenProtocol } from './tokens';
import {
  assembleTxHex,
  deserializeTx,
  serializeUnsignedTx,
  txidFromRaw,
  type UnsignedInput,
  type UnsignedTx
} from './tx';

export const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

const PSBT_GLOBAL_UNSIGNED_TX = 0x00;
const PSBT_IN_UTXO = 0x00;
const PSBT_IN_PARTIAL_SIG = 0x02;
const PSBT_IN_REDEEM_SCRIPT = 0x04;
const PSBT_IN_BIP32_DERIVATION = 0x06;
const PSBT_PROPRIETARY = 0xfc;

export const CWS_PREFIX_TOKEN = 'cws.output.token';
export const CWS_PREFIX_PROTOCOL = 'cws.output.protocol';
export const CWS_PREFIX_ATOMS = 'cws.output.atoms';
export const CWS_PREFIX_PROPOSAL_ID = 'cws.proposal.id';

export interface PsbtKeyValue {
  key: Uint8Array;
  value: Uint8Array;
}

export interface PsbtPartialSig {
  pubKeyHex: string;
  signatureHex: string;
}

export interface PsbtInputData {
  utxo?: { sats: number; scriptPubKeyHex: string } | { prevTxHex: string };
  utxoRaw?: Uint8Array;
  redeemScriptHex?: string;
  partialSigs: PsbtPartialSig[];
  unknownPairs: PsbtKeyValue[];
}

export interface PsbtOutputData {
  unknownPairs: PsbtKeyValue[];
}

export interface Psbt {
  unsignedTx: UnsignedTx;
  inputs: PsbtInputData[];
  outputs: PsbtOutputData[];
  globalUnknownPairs: PsbtKeyValue[];
}

export interface PsbtOutputMeta {
  tokenId?: string;
  protocol?: TokenProtocol;
  atoms?: string;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function serializeMap(pairs: PsbtKeyValue[]): Uint8Array {
  const sorted = [...pairs].sort((x, y) => compareBytes(x.key, y.key));
  return concatBytes(
    ...sorted.map(pair => concatBytes(varSlice(pair.key), varSlice(pair.value))),
    compactSize(0)
  );
}

function parseMapPairs(
  bytes: Uint8Array,
  offset: number
): { pairs: PsbtKeyValue[]; offset: number } {
  const pairs: PsbtKeyValue[] = [];
  const seen = new Set<string>();
  for (;;) {
    const key = readVarSlice(bytes, offset);
    offset += key.size;
    if (key.value.length === 0) break;
    const value = readVarSlice(bytes, offset);
    offset += value.size;
    const keyHex = bytesToHex(key.value);
    if (seen.has(keyHex)) throw new Error('PSBT: duplicate key in map');
    seen.add(keyHex);
    pairs.push({ key: key.value, value: value.value });
  }
  return { pairs, offset };
}

function proprietaryKey(prefix: string, keyData: Uint8Array = new Uint8Array(0)): Uint8Array {
  return concatBytes(
    Uint8Array.of(PSBT_PROPRIETARY),
    varSlice(utf8ToBytes(prefix)),
    keyData
  );
}

export function findProprietaryValue(
  pairs: PsbtKeyValue[],
  prefix: string
): Uint8Array | undefined {
  const key = proprietaryKey(prefix);
  return pairs.find(pair => equalBytes(pair.key, key))?.value;
}

export function psbtUtxoAt(
  psbt: Psbt,
  index: number
): { sats: number; scriptPubKeyHex: string } | undefined {
  const input = psbt.inputs[index];
  if (!input?.utxo) return undefined;
  if ('scriptPubKeyHex' in input.utxo) return input.utxo;
  const outpoint = psbt.unsignedTx.inputs[index];
  if (!outpoint) return undefined;
  try {
    return resolveUtxo(hexToBytes(input.utxo.prevTxHex), outpoint);
  } catch {
    return undefined;
  }
}

function encodeUtxoValue(sats: number, scriptPubKey: Uint8Array): Uint8Array {
  return concatBytes(u64LE(sats), varSlice(scriptPubKey));
}

function decodeUtxoValue(value: Uint8Array): { sats: number; scriptPubKeyHex: string } {
  if (value.length < 9) throw new Error('PSBT: invalid PSBT_IN_UTXO value');
  const sats = Number(new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0, true));
  const script = readVarSlice(value, 8);
  if (8 + script.size !== value.length) throw new Error('PSBT: invalid PSBT_IN_UTXO value');
  return { sats, scriptPubKeyHex: bytesToHex(script.value) };
}

function resolveUtxo(
  value: Uint8Array,
  prevOut: { txid: string; vout: number }
): { sats: number; scriptPubKeyHex: string } {
  try {
    const parsed = deserializeTx(value);
    if (parsed.inputs.length > 0 && parsed.outputs.length > 0) {
      const rawTxid = txidFromRaw(bytesToHex(value));
      if (rawTxid === prevOut.txid && parsed.outputs[prevOut.vout]) {
        const out = parsed.outputs[prevOut.vout]!;
        return { sats: out.sats, scriptPubKeyHex: out.scriptHex };
      }
    }
  } catch {
    /* not a full previous transaction */
  }
  return decodeUtxoValue(value);
}

export function pubkeyMatchesInputScript(
  scriptPubKey: Uint8Array,
  redeemScript: Uint8Array | undefined,
  pubKeyHex: string
): boolean {
  const normalized = pubKeyHex.toLowerCase();
  let pubKeyBytes: Uint8Array;
  try {
    pubKeyBytes = hexToBytes(normalized);
  } catch {
    return false;
  }
  if (redeemScript) {
    if (
      scriptPubKey.length !== 23 ||
      scriptPubKey[0] !== 0xa9 ||
      scriptPubKey[22] !== 0x87 ||
      !equalBytes(hash160(redeemScript), scriptPubKey.slice(2, 22))
    ) {
      return false;
    }
    try {
      return parseMultisigRedeemScript(redeemScript).publicKeysHex.includes(normalized);
    } catch {
      return false;
    }
  }
  if (
    scriptPubKey.length === 25 &&
    scriptPubKey[0] === 0x76 &&
    scriptPubKey[1] === 0xa9 &&
    scriptPubKey[2] === 0x14 &&
    scriptPubKey[23] === 0x88 &&
    scriptPubKey[24] === 0xac
  ) {
    return equalBytes(hash160(pubKeyBytes), scriptPubKey.slice(3, 23));
  }
  return false;
}

function inputScriptPubKey(input: PsbtInputData): Uint8Array | undefined {
  if (!input.utxo) return undefined;
  if ('scriptPubKeyHex' in input.utxo) return hexToBytes(input.utxo.scriptPubKeyHex);
  return undefined;
}

function reconstructPublicKeys(input: PsbtInputData): string[] {
  if (input.redeemScriptHex) {
    try {
      return parseMultisigRedeemScript(hexToBytes(input.redeemScriptHex)).publicKeysHex;
    } catch {
      return [];
    }
  }
  const script = inputScriptPubKey(input);
  if (!script) return input.partialSigs.map(sig => sig.pubKeyHex.toLowerCase());
  return input.partialSigs
    .map(sig => sig.pubKeyHex.toLowerCase())
    .filter(pubKeyHex => pubkeyMatchesInputScript(script, undefined, pubKeyHex));
}

function bip32KeyHexes(input: PsbtInputData): string[] {
  return input.unknownPairs
    .filter(pair => pair.key.length === 34 || pair.key.length === 66)
    .filter(pair => pair.key[0] === PSBT_IN_BIP32_DERIVATION)
    .map(pair => bytesToHex(pair.key.slice(1)));
}

function inputUtxoToParsed(input: PsbtInputData, coin: SupportedCoin, network: Network): UnsignedInput {
  const utxo =
    input.utxo && 'scriptPubKeyHex' in input.utxo
      ? input.utxo
      : { sats: 0, scriptPubKeyHex: '' };
  const scriptBytes = hexToBytes(utxo.scriptPubKeyHex);
  let address = '';
  try {
    address = scriptPubKeyToAddress(coin, scriptBytes, network);
  } catch {
    address = '';
  }
  return {
    txid: '',
    vout: 0,
    satoshis: utxo.sats,
    address,
    path: '',
    publicKeys: reconstructPublicKeys(input),
    redeemScript: input.redeemScriptHex,
    scriptPubKey: utxo.scriptPubKeyHex
  };
}

export function txToPsbt(opts: {
  tx: UnsignedTx;
  prevTxsById?: Record<string, string>;
  proposalIdHex?: string;
  outputMeta?: Array<PsbtOutputMeta | undefined>;
}): Psbt {
  const inputs = opts.tx.inputs.map(input => {
    const prevTxHex = opts.prevTxsById?.[input.txid];
    const scriptPubKeyHex =
      input.scriptPubKey ?? scriptPubKeyHexFromAddress(opts.tx.coin, input.address);
    return {
      utxo:
        prevTxHex !== undefined
          ? ({ prevTxHex } as const)
          : ({ sats: input.satoshis, scriptPubKeyHex } as const),
      redeemScriptHex: input.redeemScript,
      partialSigs: [] as PsbtPartialSig[],
      unknownPairs: [] as PsbtKeyValue[]
    };
  });
  const outputs = opts.tx.outputs.map((output, index) => {
    const meta = opts.outputMeta?.[index] ?? { tokenId: output.tokenId, atoms: output.atoms };
    const unknownPairs: PsbtKeyValue[] = [];
    if (meta.tokenId) {
      unknownPairs.push({
        key: proprietaryKey(CWS_PREFIX_TOKEN),
        value: hexToBytes(meta.tokenId)
      });
    }
    if (meta.protocol) {
      unknownPairs.push({
        key: proprietaryKey(CWS_PREFIX_PROTOCOL),
        value: utf8ToBytes(meta.protocol)
      });
    }
    if (meta.atoms !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(meta.atoms)) {
        throw new Error(`PSBT: cws.output.atoms must be unsigned decimal ASCII, got ${meta.atoms}`);
      }
      unknownPairs.push({
        key: proprietaryKey(CWS_PREFIX_ATOMS),
        value: utf8ToBytes(meta.atoms)
      });
    }
    return { unknownPairs };
  });
  const globalUnknownPairs: PsbtKeyValue[] = opts.proposalIdHex
    ? [{ key: proprietaryKey(CWS_PREFIX_PROPOSAL_ID), value: hexToBytes(opts.proposalIdHex) }]
    : [];
  return { unsignedTx: opts.tx, inputs, outputs, globalUnknownPairs };
}

export function serializePsbt(psbt: Psbt): Uint8Array {
  const globalPairs: PsbtKeyValue[] = [
    {
      key: Uint8Array.of(PSBT_GLOBAL_UNSIGNED_TX),
      value: serializeUnsignedTx(psbt.unsignedTx)
    },
    ...psbt.globalUnknownPairs
  ];
  const parts: Uint8Array[] = [PSBT_MAGIC, serializeMap(globalPairs)];
  if (psbt.inputs.length !== psbt.unsignedTx.inputs.length) {
    throw new Error('PSBT: input count does not match the unsigned transaction');
  }
  if (psbt.outputs.length !== psbt.unsignedTx.outputs.length) {
    throw new Error('PSBT: output count does not match the unsigned transaction');
  }
  for (const input of psbt.inputs) {
    const pairs: PsbtKeyValue[] = [...input.unknownPairs];
    if (input.utxo || input.utxoRaw) {
      const value =
        input.utxoRaw ??
        ('prevTxHex' in input.utxo!
          ? hexToBytes(input.utxo.prevTxHex)
          : encodeUtxoValue(input.utxo!.sats, hexToBytes(input.utxo!.scriptPubKeyHex)));
      pairs.push({ key: Uint8Array.of(PSBT_IN_UTXO), value });
    }
    if (input.redeemScriptHex) {
      pairs.push({
        key: Uint8Array.of(PSBT_IN_REDEEM_SCRIPT),
        value: hexToBytes(input.redeemScriptHex)
      });
    }
    for (const sig of input.partialSigs) {
      pairs.push({
        key: concatBytes(Uint8Array.of(PSBT_IN_PARTIAL_SIG), hexToBytes(sig.pubKeyHex)),
        value: hexToBytes(sig.signatureHex)
      });
    }
    parts.push(serializeMap(pairs));
  }
  for (const output of psbt.outputs) {
    parts.push(serializeMap(output.unknownPairs));
  }
  return concatBytes(...parts);
}

export function psbtToBase64(psbt: Psbt): string {
  const bytes = serializePsbt(psbt);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('PSBT: invalid base64');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function parsePsbt(
  data: Uint8Array | string,
  opts?: { coin?: SupportedCoin; network?: Network }
): Psbt {
  const bytes = typeof data === 'string' ? base64ToBytes(data) : data;
  const coin = opts?.coin ?? 'xec';
  const network = opts?.network ?? 'livenet';
  for (let i = 0; i < PSBT_MAGIC.length; i++) {
    if (bytes[i] !== PSBT_MAGIC[i]) throw new Error('PSBT: bad magic');
  }
  let offset = PSBT_MAGIC.length;

  const global = parseMapPairs(bytes, offset);
  offset = global.offset;
  let unsignedRaw: Uint8Array | undefined;
  const globalUnknownPairs: PsbtKeyValue[] = [];
  for (const pair of global.pairs) {
    if (pair.key.length === 1 && pair.key[0] === PSBT_GLOBAL_UNSIGNED_TX) {
      unsignedRaw = pair.value;
    } else {
      globalUnknownPairs.push(pair);
    }
  }
  if (!unsignedRaw) throw new Error('PSBT: missing global unsigned transaction');
  const parsedTx = deserializeTx(unsignedRaw);
  const unsignedTx: UnsignedTx = {
    coin,
    version: parsedTx.version,
    locktime: parsedTx.locktime,
    inputs: [],
    outputs: parsedTx.outputs.map(out => ({ address: '', satoshis: out.sats, scriptHex: out.scriptHex }))
  };

  const inputs: PsbtInputData[] = [];
  for (let i = 0; i < parsedTx.inputs.length; i++) {
    const parsedInput = parsedTx.inputs[i]!;
    const map = parseMapPairs(bytes, offset);
    offset = map.offset;
    const input: PsbtInputData = {
      partialSigs: [],
      unknownPairs: []
    };
    for (const pair of map.pairs) {
      const type = pair.key[0]!;
      if (type === PSBT_IN_UTXO && pair.key.length === 1) {
        input.utxo = resolveUtxo(pair.value, { txid: parsedInput.txid, vout: parsedInput.vout });
        input.utxoRaw = pair.value;
      } else if (type === PSBT_IN_REDEEM_SCRIPT && pair.key.length === 1) {
        input.redeemScriptHex = bytesToHex(pair.value);
      } else if (type === PSBT_IN_PARTIAL_SIG && (pair.key.length === 34 || pair.key.length === 66)) {
        input.partialSigs.push({
          pubKeyHex: bytesToHex(pair.key.slice(1)),
          signatureHex: bytesToHex(pair.value)
        });
      } else {
        input.unknownPairs.push(pair);
      }
    }
    const utxo =
      input.utxo && 'scriptPubKeyHex' in input.utxo
        ? input.utxo
        : { sats: 0, scriptPubKeyHex: '' };
    unsignedTx.inputs.push({
      txid: parsedInput.txid,
      vout: parsedInput.vout,
      satoshis: utxo.sats,
      address: inputUtxoToParsed(input, coin, network).address,
      path: '',
      publicKeys: [...reconstructPublicKeys(input), ...bip32KeyHexes(input)].filter(
        (value, index, all) => all.indexOf(value) === index
      ),
      redeemScript: input.redeemScriptHex,
      scriptPubKey: utxo.scriptPubKeyHex,
      sequence: parsedInput.sequence
    });
    inputs.push(input);
  }

  const outputs: PsbtOutputData[] = [];
  for (let i = 0; i < parsedTx.outputs.length; i++) {
    const map = parseMapPairs(bytes, offset);
    offset = map.offset;
    outputs.push({ unknownPairs: map.pairs });
  }
  if (offset !== bytes.length) throw new Error('PSBT: trailing bytes after output maps');
  return { unsignedTx, inputs, outputs, globalUnknownPairs };
}

export function addPartialSignature(
  psbt: Psbt,
  inputIndex: number,
  pubKeyHex: string,
  signatureHex: string
): Psbt {
  const input = psbt.inputs[inputIndex];
  if (!input) throw new Error('PSBT: input index out of range');
  const normalized = pubKeyHex.toLowerCase();
  const script = inputScriptPubKey(input);
  const redeemScript = input.redeemScriptHex ? hexToBytes(input.redeemScriptHex) : undefined;
  if (!script) throw new Error('PSBT: input has no UTXO data');
  if (!pubkeyMatchesInputScript(script, redeemScript, normalized)) {
    throw new Error('PSBT: signature pubkey does not match the input script');
  }
  const partialSigs = input.partialSigs
    .filter(sig => sig.pubKeyHex.toLowerCase() !== normalized)
    .concat({ pubKeyHex: normalized, signatureHex: signatureHex.toLowerCase() });
  return {
    ...psbt,
    inputs: psbt.inputs.map((current, index) =>
      index === inputIndex ? { ...current, partialSigs } : current
    )
  };
}

function mergeUnknownPairs(a: PsbtKeyValue[], b: PsbtKeyValue[], label: string): PsbtKeyValue[] {
  const merged = [...a];
  for (const pair of b) {
    const existing = merged.find(candidate => equalBytes(candidate.key, pair.key));
    if (existing) {
      if (!equalBytes(existing.value, pair.value)) {
        throw new Error(`combinePsbts: conflicting ${label} pair`);
      }
      continue;
    }
    merged.push(pair);
  }
  return merged;
}

function utxoFingerprint(
  utxo: { sats: number; scriptPubKeyHex: string } | { prevTxHex: string } | undefined,
  outpoint: { txid: string; vout: number }
): string | undefined {
  if (!utxo) return undefined;
  if ('scriptPubKeyHex' in utxo) return `${utxo.sats}:${utxo.scriptPubKeyHex.toLowerCase()}`;
  try {
    const resolved = resolveUtxo(hexToBytes(utxo.prevTxHex), outpoint);
    return `${resolved.sats}:${resolved.scriptPubKeyHex.toLowerCase()}`;
  } catch {
    return `raw:${utxo.prevTxHex}`;
  }
}

export function combinePsbts(a: Psbt, b: Psbt): Psbt {
  if (!equalBytes(serializeUnsignedTx(a.unsignedTx), serializeUnsignedTx(b.unsignedTx))) {
    throw new Error('combinePsbts: unsigned transactions differ');
  }
  if (a.inputs.length !== b.inputs.length || a.outputs.length !== b.outputs.length) {
    throw new Error('combinePsbts: input or output count differs');
  }
  const inputs = a.inputs.map((inputA, index) => {
    const inputB = b.inputs[index]!;
    const outpoint = {
      txid: a.unsignedTx.inputs[index]!.txid,
      vout: a.unsignedTx.inputs[index]!.vout
    };
    const partialSigs = [...inputA.partialSigs];
    for (const sig of inputB.partialSigs) {
      const existing = partialSigs.find(
        candidate => candidate.pubKeyHex.toLowerCase() === sig.pubKeyHex.toLowerCase()
      );
      if (existing) {
        if (existing.signatureHex !== sig.signatureHex.toLowerCase()) {
          throw new Error('combinePsbts: conflicting partial signature');
        }
        continue;
      }
      partialSigs.push(sig);
    }
    const leftFingerprint = utxoFingerprint(inputA.utxo, outpoint);
    const rightFingerprint = utxoFingerprint(inputB.utxo, outpoint);
    if (
      leftFingerprint !== undefined &&
      rightFingerprint !== undefined &&
      leftFingerprint !== rightFingerprint
    ) {
      throw new Error('combinePsbts: conflicting PSBT_IN_UTXO');
    }
    if (
      inputA.redeemScriptHex !== undefined &&
      inputB.redeemScriptHex !== undefined &&
      inputA.redeemScriptHex !== inputB.redeemScriptHex
    ) {
      throw new Error('combinePsbts: conflicting redeem script');
    }
    return {
      utxo: inputA.utxo ?? inputB.utxo,
      utxoRaw: inputA.utxoRaw ?? inputB.utxoRaw,
      redeemScriptHex: inputA.redeemScriptHex ?? inputB.redeemScriptHex,
      partialSigs,
      unknownPairs: mergeUnknownPairs(inputA.unknownPairs, inputB.unknownPairs, 'input')
    };
  });
  const outputs = a.outputs.map((outputA, index) => ({
    unknownPairs: mergeUnknownPairs(outputA.unknownPairs, b.outputs[index]!.unknownPairs, 'output')
  }));
  return {
    unsignedTx: a.unsignedTx,
    inputs,
    outputs,
    globalUnknownPairs: mergeUnknownPairs(a.globalUnknownPairs, b.globalUnknownPairs, 'global')
  };
}

export function isFullySigned(psbt: Psbt): boolean {
  return psbt.inputs.every(input => {
    const script = inputScriptPubKey(input);
    if (!script) return false;
    const redeemScript = input.redeemScriptHex ? hexToBytes(input.redeemScriptHex) : undefined;
    const matching = input.partialSigs.filter(sig =>
      pubkeyMatchesInputScript(script, redeemScript, sig.pubKeyHex)
    );
    if (redeemScript) {
      try {
        const { m, publicKeysHex } = parseMultisigRedeemScript(redeemScript);
        const signed = publicKeysHex.filter(pubKeyHex =>
          matching.some(sig => sig.pubKeyHex.toLowerCase() === pubKeyHex)
        );
        return signed.length >= m;
      } catch {
        return false;
      }
    }
    return matching.length >= 1;
  });
}

export function finalizePsbt(psbt: Psbt): { raw: string; txid: string } {
  if (!isFullySigned(psbt)) throw new Error('finalizePsbt: missing signatures');
  const signatures = psbt.inputs.map(input => {
    const map: Record<string, string> = {};
    for (const sig of input.partialSigs) {
      map[sig.pubKeyHex.toLowerCase()] = sig.signatureHex;
    }
    return map;
  });
  const raw = assembleTxHex(psbt.unsignedTx, signatures);
  return { raw, txid: txidFromRaw(raw) };
}
