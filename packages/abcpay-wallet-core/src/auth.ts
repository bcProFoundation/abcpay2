import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from './bytes';

export function requestMessage(method: string, path: string, body = ''): string {
  return `${method.toUpperCase()}|${path}|${body}`;
}

export function signRequest(requestPrivKeyHex: string, method: string, path: string, body = ''): string {
  const digest = sha256(utf8ToBytes(requestMessage(method, path, body)));
  const sig = secp256k1.sign(digest, hexToBytes(requestPrivKeyHex));
  return bytesToHex(sig.toCompactRawBytes());
}

export function verifyRequest(
  requestPubKeyHex: string,
  signatureHex: string,
  method: string,
  path: string,
  body = ''
): boolean {
  try {
    const digest = sha256(utf8ToBytes(requestMessage(method, path, body)));
    return secp256k1.verify(hexToBytes(signatureHex), digest, hexToBytes(requestPubKeyHex));
  } catch {
    return false;
  }
}
