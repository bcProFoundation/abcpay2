import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { decodeCashAddress, encodeCashAddress, isValidCashAddress } from 'ecashaddrjs';
import type { AddressType, Network, SupportedCoin } from '@bcpros/abcpay-models';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { bytesToHex, hexToBytes } from './bytes';
import { hash160 } from './hash';
import { compactPublicKey, derivePublicKey } from './keys';
import {
  multisigRedeemScript,
  p2pkhScript,
  p2shScript,
  publicKeysToBytes,
  redeemScriptHash,
  sortPublicKeys
} from './script';

const b58 = base58check(sha256);

const DOGE_VERSIONS = {
  livenet: { p2pkh: 0x1e, p2sh: 0x16 },
  testnet: { p2pkh: 0x71, p2sh: 0xc4 }
} as const;

export interface DecodedAddress {
  coin: SupportedCoin;
  type: 'p2pkh' | 'p2sh';
  hash: Uint8Array;
  hashHex: string;
  prefix?: string;
}

export function encodeP2pkhAddress(coin: SupportedCoin, publicKeyHex: string, network: Network = 'livenet'): string {
  const hash = hash160(compactPublicKey(publicKeyHex));
  return encodeHashAddress(coin, 'p2pkh', hash, network);
}

export function encodeP2shAddress(coin: SupportedCoin, scriptHash: Uint8Array, network: Network = 'livenet'): string {
  return encodeHashAddress(coin, 'p2sh', scriptHash, network);
}

export function encodeHashAddress(
  coin: SupportedCoin,
  type: 'p2pkh' | 'p2sh',
  hash: Uint8Array,
  network: Network = 'livenet'
): string {
  if (coin === 'xec') {
    const prefix = COIN_CONFIGS.xec.protocolPrefix[network];
    return encodeCashAddress(prefix, type, bytesToHex(hash));
  }

  const version = DOGE_VERSIONS[network][type];
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(hash, 1);
  return b58.encode(payload);
}

export function decodeAddress(coin: SupportedCoin, address: string): DecodedAddress {
  if (coin === 'xec') {
    const normalized = normalizeXecAddress(address);
    const decoded = decodeCashAddress(normalized);
    const type = decoded.type.toLowerCase() as 'p2pkh' | 'p2sh';
    const hash = typeof decoded.hash === 'string' ? hexToBytes(decoded.hash) : new Uint8Array(decoded.hash);
    return {
      coin,
      type,
      hash,
      hashHex: bytesToHex(hash),
      prefix: decoded.prefix
    };
  }

  const payload = b58.decode(address);
  const version = payload[0];
  const hash = payload.slice(1);
  const versions = Object.values(DOGE_VERSIONS).flatMap(v => [
    { type: 'p2pkh' as const, version: v.p2pkh },
    { type: 'p2sh' as const, version: v.p2sh }
  ]);
  const match = versions.find(v => v.version === version);
  if (!match) throw new Error('Unsupported Dogecoin address version');
  return { coin, type: match.type, hash, hashHex: bytesToHex(hash) };
}

export function normalizeXecAddress(address: string): string {
  if (address.includes(':')) return address;
  return `ecash:${address}`;
}

export function validateAddress(coin: SupportedCoin, address: string): boolean {
  try {
    if (coin === 'xec') {
      return isValidCashAddress(normalizeXecAddress(address));
    }
    decodeAddress(coin, address);
    return true;
  } catch {
    return false;
  }
}

export function scriptPubKeyFromAddress(coin: SupportedCoin, address: string): Uint8Array {
  const decoded = decodeAddress(coin, address);
  return decoded.type === 'p2pkh' ? p2pkhScript(decoded.hash) : p2shScript(decoded.hash);
}

export function scriptPubKeyHexFromAddress(coin: SupportedCoin, address: string): string {
  return bytesToHex(scriptPubKeyFromAddress(coin, address));
}

export interface DerivedAddress {
  address: string;
  path: string;
  publicKeys: string[];
  type: AddressType;
  redeemScript?: string;
  scriptPubKey: string;
}

export function deriveWalletAddress(opts: {
  coin: SupportedCoin;
  network?: Network;
  xPubKeys: string[];
  m: number;
  n: number;
  path: string;
}): DerivedAddress {
  const publicKeys = sortPublicKeys(opts.xPubKeys.map(xpub => derivePublicKey(xpub, opts.path)));
  const network = opts.network ?? 'livenet';

  if (opts.n === 1) {
    const address = encodeP2pkhAddress(opts.coin, publicKeys[0], network);
    return {
      address,
      path: opts.path,
      publicKeys,
      type: 'P2PKH',
      scriptPubKey: scriptPubKeyHexFromAddress(opts.coin, address)
    };
  }

  const redeem = multisigRedeemScript(opts.m, publicKeysToBytes(publicKeys));
  const address = encodeP2shAddress(opts.coin, redeemScriptHash(redeem), network);
  return {
    address,
    path: opts.path,
    publicKeys,
    type: 'P2SH',
    redeemScript: bytesToHex(redeem),
    scriptPubKey: scriptPubKeyHexFromAddress(opts.coin, address)
  };
}

export { isValidCashAddress };
