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

export function requestMessageV5(
  method: string,
  path: string,
  ts: number | string,
  nonce: string,
  body = ''
): string {
  return `v5|${method.toLowerCase()}|${path}|${ts}|${nonce}|${body}`;
}

export function signRequestV5(
  requestPrivKeyHex: string,
  method: string,
  path: string,
  ts: number,
  nonce: string,
  body = ''
): string {
  return signMessage(requestMessageV5(method, path, ts, nonce, body), requestPrivKeyHex);
}

export function verifyRequestV5(
  requestPubKeyHex: string,
  signatureHex: string,
  method: string,
  path: string,
  ts: number,
  nonce: string,
  body = ''
): boolean {
  return verifyMessage(requestMessageV5(method, path, ts, nonce, body), signatureHex, requestPubKeyHex);
}

export const V5_MAX_SKEW_MS = 300_000;

export function isTimestampFresh(ts: number, nowMs: number): boolean {
  return Number.isFinite(ts) && Math.abs(nowMs - ts) <= V5_MAX_SKEW_MS;
}

/** Canonical message proving possession of an envelope identity private key. */
export function identityRegistrationMessage(
  identityKey: string,
  requestPubKey: string,
  encryptionPubKey: string
): string {
  return `abcpay-v5-identity|${identityKey}|${requestPubKey}|${encryptionPubKey}`;
}

export function signIdentityRegistration(
  identityPrivKeyHex: string,
  identityKey: string,
  requestPubKey: string,
  encryptionPubKey: string
): string {
  return signMessage(
    identityRegistrationMessage(identityKey, requestPubKey, encryptionPubKey),
    identityPrivKeyHex
  );
}

export function verifyIdentityRegistration(
  proofSignatureHex: string,
  identityKey: string,
  requestPubKey: string,
  encryptionPubKey: string
): boolean {
  return verifyMessage(
    identityRegistrationMessage(identityKey, requestPubKey, encryptionPubKey),
    proofSignatureHex,
    identityKey
  );
}
