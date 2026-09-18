import type { SupportedCoin } from '@bcpros/abcpay-models';
import { concatBytes, hexToBytes, reverseBytes } from './bytes';
import { dustThreshold, minRelayFeePerKb, defaultFeePerKb, type SelectableUtxo } from './coinselect';
import { estimateTxSize } from './tx';

/**
 * SLP (Type 1) and ALP token send scripts.
 *
 * Byte layouts ported from Bitcoin ABC's ecash-lib (MIT):
 * - SLP:  OP_RETURN <"SLP\0"> <tokenType> <"SEND"> <tokenId BE> <atoms u64 BE>...
 * - ALP:  OP_RETURN <"SLP2" tokenType "SEND" tokenId LE amounts(u48 LE)>...
 * Test vectors in __tests__/fixtures/token-encoders.json are generated with ecash-lib.
 */

export type TokenProtocol = 'SLP' | 'ALP';

export const SLP_FUNGIBLE = 1;
export const ALP_STANDARD = 0;

const OP_RETURN = 0x6a;
/** OP_RESERVED marks eMPP (multi-pushdata) OP_RETURNs; required for ALP sections. */
const OP_RESERVED = 0x50;
const SLP_LOKAD_ID = Uint8Array.of(0x53, 0x4c, 0x50, 0x00);
const ALP_LOKAD_ID = Uint8Array.of(0x53, 0x4c, 0x50, 0x32);
const SEND = Uint8Array.of(0x53, 0x45, 0x4e, 0x44);

export const SLP_MAX_SEND_OUTPUTS = 19;
export const ALP_MAX_U48 = (1n << 48n) - 1n;

/** Minimal push opcode(s) followed by the data (OP_PUSHDATA1 for empty data, like the SLP reference). */
function pushData(data: Uint8Array): Uint8Array {
  if (data.length === 0) return Uint8Array.of(0x4c, 0x00);
  if (data.length < 0x4c) return concatBytes(Uint8Array.of(data.length), data);
  if (data.length <= 0xff) return concatBytes(Uint8Array.of(0x4c, data.length), data);
  if (data.length <= 0xffff) {
    return concatBytes(Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8), data);
  }
  return concatBytes(
    Uint8Array.of(0x4e, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff, data.length >>> 24),
    data
  );
}

/** SLP amounts are 8-byte big-endian quantities. */
export function encodeSlpAtoms(atoms: bigint): Uint8Array {
  if (atoms < 0n || atoms > 0xffffffffffffffffn) throw new Error(`SLP atoms out of range: ${atoms}`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, atoms, false);
  return bytes;
}

/** ALP amounts are 48-bit: low 32 bits little-endian, then the high 16 bits little-endian. */
export function encodeAlpAtoms(atoms: bigint): Uint8Array {
  if (atoms < 0n || atoms > ALP_MAX_U48) throw new Error(`ALP atoms out of range: ${atoms}`);
  const values = Uint8Array.of(
    Number(atoms & 0xffn),
    Number((atoms >> 8n) & 0xffn),
    Number((atoms >> 16n) & 0xffn),
    Number((atoms >> 24n) & 0xffn),
    Number((atoms >> 32n) & 0xffn),
    Number((atoms >> 40n) & 0xffn)
  );
  return values;
}

function assertTokenId(tokenId: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(tokenId)) throw new Error('Token id must be 64 hex characters');
}

function assertAtoms(atoms: bigint[]) {
  if (atoms.length === 0) throw new Error('Token send requires at least one amount');
  if (atoms.length > SLP_MAX_SEND_OUTPUTS) throw new Error(`At most ${SLP_MAX_SEND_OUTPUTS} token amounts are supported`);
}

export function slpSendScript(tokenId: string, tokenType: number, atoms: bigint[]): Uint8Array {
  assertTokenId(tokenId);
  assertAtoms(atoms);
  return concatBytes(
    Uint8Array.of(OP_RETURN),
    pushData(SLP_LOKAD_ID),
    pushData(Uint8Array.of(tokenType)),
    pushData(SEND),
    pushData(hexToBytes(tokenId)),
    ...atoms.map(amount => pushData(encodeSlpAtoms(amount)))
  );
}

export function alpSendScript(tokenId: string, tokenType: number, atoms: bigint[]): Uint8Array {
  assertTokenId(tokenId);
  assertAtoms(atoms);
  const payload = concatBytes(
    ALP_LOKAD_ID,
    Uint8Array.of(tokenType),
    Uint8Array.of(SEND.length),
    SEND,
    reverseBytes(hexToBytes(tokenId)),
    Uint8Array.of(atoms.length),
    ...atoms.map(encodeAlpAtoms)
  );
  return concatBytes(Uint8Array.of(OP_RETURN, OP_RESERVED), pushData(payload));
}

export function tokenSendScript(
  protocol: TokenProtocol,
  tokenId: string,
  tokenType: number,
  atoms: bigint[]
): Uint8Array {
  return protocol === 'ALP' ? alpSendScript(tokenId, tokenType, atoms) : slpSendScript(tokenId, tokenType, atoms);
}

export interface TokenSendPlan {
  tokenInputs: SelectableUtxo[];
  xecInputs: SelectableUtxo[];
  inputs: SelectableUtxo[];
  changeAtoms: bigint;
  tokenOutputCount: number;
  fee: number;
  xecChange: number;
  dustSats: number;
  opReturnScript: Uint8Array;
}

/**
 * Plans a token send: picks token UTXOs covering the requested atoms, then just
 * enough XEC inputs to pay output dust and fees. Change atoms become a second
 * token output; leftover sats become an XEC change output (or are donated to the
 * fee when below dust).
 */
export function planTokenSend(opts: {
  coin: SupportedCoin;
  protocol: TokenProtocol;
  tokenId: string;
  tokenType: number;
  utxos: SelectableUtxo[];
  atoms: bigint;
  feePerKb?: number;
  m?: number;
  n?: number;
  dustSats?: number;
}): TokenSendPlan {
  if (opts.atoms <= 0n) throw new Error('Token amount must be greater than zero');
  const dust = opts.dustSats ?? dustThreshold(opts.coin);
  const feePerKb = Math.max(minRelayFeePerKb(opts.coin), opts.feePerKb ?? defaultFeePerKb(opts.coin));
  const m = opts.m ?? 1;
  const n = opts.n ?? 1;

  const tokenCandidates = opts.utxos
    .filter(utxo => utxo.token?.tokenId === opts.tokenId && !utxo.token.isMintBaton)
    .sort((a, b) => a.satoshis - b.satoshis);

  const tokenInputs: SelectableUtxo[] = [];
  let availableAtoms = 0n;
  for (const utxo of tokenCandidates) {
    tokenInputs.push(utxo);
    availableAtoms += BigInt(utxo.token!.atoms);
    if (availableAtoms >= opts.atoms) break;
  }
  if (availableAtoms < opts.atoms) {
    throw new Error(`Insufficient token balance: available ${availableAtoms}, need ${opts.atoms}`);
  }

  const changeAtoms = availableAtoms - opts.atoms;
  const tokenOutputCount = changeAtoms > 0n ? 2 : 1;
  const amounts = changeAtoms > 0n ? [opts.atoms, changeAtoms] : [opts.atoms];
  const opReturnScript = tokenSendScript(opts.protocol, opts.tokenId, opts.tokenType, amounts);

  const tokenSats = tokenInputs.reduce((sum, utxo) => sum + utxo.satoshis, 0);
  const xecCandidates = opts.utxos
    .filter(utxo => !utxo.token)
    .sort((a, b) => a.satoshis - b.satoshis);

  const xecInputs: SelectableUtxo[] = [];
  let available = tokenSats;

  for (;;) {
    const inputCount = tokenInputs.length + xecInputs.length;
    const outputCount = tokenOutputCount + 1 + 1; // token outputs + XEC change + OP_RETURN
    const size = estimateTxSize(inputCount, outputCount, n, m) + opReturnScript.length + 3;
    const fee = Math.max(1, Math.ceil((size * feePerKb) / 1000));
    const needed = dust * tokenOutputCount + fee;

    if (available >= needed + dust) {
      return {
        tokenInputs,
        xecInputs,
        inputs: [...tokenInputs, ...xecInputs],
        changeAtoms,
        tokenOutputCount,
        fee,
        xecChange: available - needed,
        dustSats: dust,
        opReturnScript
      };
    }

    if (available >= needed) {
      return {
        tokenInputs,
        xecInputs,
        inputs: [...tokenInputs, ...xecInputs],
        changeAtoms,
        tokenOutputCount,
        fee: available - dust * tokenOutputCount,
        xecChange: 0,
        dustSats: dust,
        opReturnScript
      };
    }

    const next = xecCandidates.shift();
    if (!next) {
      throw new Error(`Insufficient funds: available ${available} sats, need ${needed} sats for dust and fees`);
    }
    xecInputs.push(next);
    available += next.satoshis;
  }
}
