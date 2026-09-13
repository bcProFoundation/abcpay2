import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, utf8ToBytes } from './bytes';
import { hash256 } from './hash';

export function requestMessage(method: string, path: string, body = '{}'): string {
  return `${method.toLowerCase()}|${path}|${body}`;
}

export function signMessage(message: string, privKeyHex: string): string {
  const sig = secp256k1.sign(hash256(utf8ToBytes(message)), hexToBytes(privKeyHex));
  return bytesToHex(sig.toDERRawBytes());
}

export function verifyMessage(message: string, signatureHex: string, pubKeyHex: string): boolean {
  try {
    return secp256k1.verify(
      hexToBytes(signatureHex),
      hash256(utf8ToBytes(message)),
      hexToBytes(pubKeyHex)
    );
  } catch {
    return false;
  }
}

export function signRequest(
  requestPrivKeyHex: string,
  method: string,
  path: string,
  body = '{}'
): string {
  return signMessage(requestMessage(method, path, body), requestPrivKeyHex);
}

export function verifyRequest(
  requestPubKeyHex: string,
  signatureHex: string,
  method: string,
  path: string,
  body = '{}'
): boolean {
  return verifyMessage(requestMessage(method, path, body), signatureHex, requestPubKeyHex);
}
