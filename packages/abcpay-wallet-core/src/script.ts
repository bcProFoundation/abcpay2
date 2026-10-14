import { bytesToHex, concatBytes, compactSize, hexToBytes, u8 } from './bytes';
import { hash160 } from './hash';

export const OP = {
  0: 0x00,
  DUP: 0x76,
  HASH160: 0xa9,
  EQUAL: 0x87,
  EQUALVERIFY: 0x88,
  CHECKSIG: 0xac,
  CHECKMULTISIG: 0xae,
  PUSHDATA1: 0x4c,
  PUSHDATA2: 0x4d
} as const;

export function opN(n: number): number {
  if (n < 0 || n > 16) throw new Error(`Invalid opcode N: ${n}`);
  if (n === 0) return OP[0];
  return 0x50 + n;
}

export function pushData(data: Uint8Array): Uint8Array {
  if (data.length < OP.PUSHDATA1) {
    return concatBytes(u8(data.length), data);
  }
  if (data.length <= 0xff) {
    return concatBytes(u8(OP.PUSHDATA1), u8(data.length), data);
  }
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, data.length, true);
  return concatBytes(u8(OP.PUSHDATA2), len, data);
}

export function compileScript(chunks: Array<number | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === 'number') {
      parts.push(u8(chunk));
    } else {
      parts.push(pushData(chunk));
    }
  }
  return concatBytes(...parts);
}

export function p2pkhScript(pubKeyHash: Uint8Array): Uint8Array {
  return compileScript([OP.DUP, OP.HASH160, pubKeyHash, OP.EQUALVERIFY, OP.CHECKSIG]);
}

export function p2shScript(scriptHash: Uint8Array): Uint8Array {
  return compileScript([OP.HASH160, scriptHash, OP.EQUAL]);
}

export function multisigRedeemScript(m: number, publicKeys: Uint8Array[]): Uint8Array {
  if (m < 1 || m > publicKeys.length) {
    throw new Error('Invalid m-of-n redeem script');
  }
  return compileScript([opN(m), ...publicKeys, opN(publicKeys.length), OP.CHECKMULTISIG]);
}

export function p2pkhScriptSig(signature: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return compileScript([signature, publicKey]);
}

export function p2shMultisigScriptSig(signatures: Uint8Array[], redeemScript: Uint8Array): Uint8Array {
  return compileScript([OP[0], ...signatures, redeemScript]);
}

export function scriptCodeForSighash(opts: {
  scriptPubKey: Uint8Array;
  redeemScript?: Uint8Array;
}): Uint8Array {
  const script = opts.redeemScript ?? opts.scriptPubKey;
  return concatBytes(compactSize(script.length), script);
}

export function sortPublicKeys(publicKeysHex: string[]): string[] {
  return [...publicKeysHex].sort((a, b) => a.localeCompare(b));
}

export function publicKeysToBytes(publicKeysHex: string[]): Uint8Array[] {
  return publicKeysHex.map(hexToBytes);
}

export function redeemScriptHash(redeemScript: Uint8Array): Uint8Array {
  return hash160(redeemScript);
}

export function parseMultisigRedeemScript(redeemScript: Uint8Array): {
  m: number;
  n: number;
  publicKeysHex: string[];
} {
  const chunks: Array<{ op: number; data?: Uint8Array }> = [];
  let offset = 0;
  while (offset < redeemScript.length) {
    const op = redeemScript[offset++]!;
    if (op > 0 && op < OP.PUSHDATA1) {
      if (offset + op > redeemScript.length) throw new Error('Invalid redeem script push');
      chunks.push({ op, data: redeemScript.slice(offset, offset + op) });
      offset += op;
    } else if (op === OP.PUSHDATA1) {
      if (offset >= redeemScript.length) throw new Error('Invalid redeem script push');
      const len = redeemScript[offset++]!;
      if (offset + len > redeemScript.length) throw new Error('Invalid redeem script push');
      chunks.push({ op, data: redeemScript.slice(offset, offset + len) });
      offset += len;
    } else if (op === OP.PUSHDATA2) {
      if (offset + 2 > redeemScript.length) throw new Error('Invalid redeem script push');
      const len = redeemScript[offset]! | (redeemScript[offset + 1]! << 8);
      offset += 2;
      if (offset + len > redeemScript.length) throw new Error('Invalid redeem script push');
      chunks.push({ op, data: redeemScript.slice(offset, offset + len) });
      offset += len;
    } else {
      chunks.push({ op });
    }
  }
  if (chunks.length < 4) throw new Error('Invalid multisig redeem script');
  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  const secondLast = chunks[chunks.length - 2]!;
  if (first.data !== undefined || first.op < 0x51 || first.op > 0x60) {
    throw new Error('Invalid multisig redeem script m');
  }
  if (last.op !== OP.CHECKMULTISIG) throw new Error('Missing OP_CHECKMULTISIG');
  if (secondLast.data !== undefined || secondLast.op < 0x51 || secondLast.op > 0x60) {
    throw new Error('Invalid multisig redeem script n');
  }
  const m = first.op - 0x50;
  const n = secondLast.op - 0x50;
  const pubkeyChunks = chunks.slice(1, chunks.length - 2);
  if (pubkeyChunks.length !== n) throw new Error('Multisig redeem script n does not match pubkeys');
  const publicKeysHex = pubkeyChunks.map(chunk => {
    if (!chunk.data) throw new Error('Invalid multisig redeem script pubkey');
    return bytesToHex(chunk.data);
  });
  return { m, n, publicKeysHex };
}
