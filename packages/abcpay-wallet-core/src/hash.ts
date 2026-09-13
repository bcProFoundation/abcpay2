import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex } from './bytes';

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

export function hash256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

export function hash160Hex(data: Uint8Array): string {
  return bytesToHex(hash160(data));
}

export function hash256Hex(data: Uint8Array): string {
  return bytesToHex(hash256(data));
}

export function hexHash160(hex: string): string {
  return hash160Hex(hexToBytes(hex));
}
