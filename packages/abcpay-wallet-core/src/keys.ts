import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { SupportedCoin } from '@bcpros/abcpay-models';
import { defaultWalletCoinType } from '@bcpros/abcpay-models';
import { bytesToHex, hexToBytes, utf8ToBytes } from './bytes';
import { sha256Hex } from './hash';
import { getRootPath } from './derivation';

export interface WalletCredentials {
  mnemonic: string;
  xPrivKey: string;
  xPubKey: string;
  requestPrivKey: string;
  requestPubKey: string;
  walletPrivKey: string;
  walletPubKey: string;
  copayerId: string;
  accountPath: string;
  coin: SupportedCoin;
}

export function generateWalletMnemonic(): string {
  return generateMnemonic(wordlist);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim(), wordlist);
}

export function copayerIdFromXpub(coin: SupportedCoin, xPubKey: string): string {
  return sha256Hex(utf8ToBytes(`${coin}${xPubKey}`));
}

export function createCredentials(opts: {
  coin: SupportedCoin;
  mnemonic?: string;
  account?: number;
  isMultisig?: boolean;
  usePurpose48?: boolean;
  coinType?: number;
}): WalletCredentials {
  const mnemonic = (opts.mnemonic ?? generateWalletMnemonic()).trim();
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const isMultisig = (opts.isMultisig ?? false) || (opts.usePurpose48 ?? false);
  const accountPath = getRootPath({
    coin: opts.coin,
    account: opts.account ?? 0,
    usePurpose48: opts.usePurpose48,
    isMultisig: opts.isMultisig,
    coinType: opts.coinType ?? defaultWalletCoinType(opts.coin, isMultisig)
  });

  const account = master.derive(accountPath);
  if (!account.privateExtendedKey || !account.publicExtendedKey) {
    throw new Error('Failed to derive account keys');
  }

  const request = master.derive("m/1'/0");
  const walletKey = master.derive("m/2'/0");
  if (!request.privateKey || !request.publicKey || !walletKey.privateKey || !walletKey.publicKey) {
    throw new Error('Failed to derive request keys');
  }

  const xPubKey = account.publicExtendedKey;
  return {
    mnemonic,
    xPrivKey: account.privateExtendedKey,
    xPubKey,
    requestPrivKey: bytesToHex(request.privateKey),
    requestPubKey: bytesToHex(request.publicKey),
    walletPrivKey: bytesToHex(walletKey.privateKey),
    walletPubKey: bytesToHex(walletKey.publicKey),
    copayerId: copayerIdFromXpub(opts.coin, xPubKey),
    accountPath,
    coin: opts.coin
  };
}

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };

function parseExtendedKey(xKey: string): HDKey {
  try {
    return HDKey.fromExtendedKey(xKey);
  } catch {
    return HDKey.fromExtendedKey(xKey, TESTNET_VERSIONS);
  }
}

export function deriveKeyAt(xKey: string, isChange: boolean, index: number): HDKey {
  const hd = parseExtendedKey(xKey);
  return hd.deriveChild(isChange ? 1 : 0).deriveChild(index);
}

export function parsePath(path: string): { isChange: boolean; index: number } {
  const parts = path.replace(/^m\//, '').split('/');
  if (parts.length < 2) throw new Error(`Invalid derivation path: ${path}`);
  const change = Number(parts[parts.length - 2].replace(/'/g, ''));
  const index = Number(parts[parts.length - 1].replace(/'/g, ''));
  return { isChange: change === 1, index };
}

export function derivePrivateKey(xPrivKey: string, path: string): Uint8Array {
  const { isChange, index } = parsePath(path);
  const key = deriveKeyAt(xPrivKey, isChange, index).privateKey;
  if (!key) throw new Error('Cannot derive private key from xpub');
  return key;
}

export function derivePublicKey(xPubKey: string, path: string): string {
  const { isChange, index } = parsePath(path);
  const key = deriveKeyAt(xPubKey, isChange, index).publicKey;
  if (!key) throw new Error('Failed to derive public key');
  return bytesToHex(key);
}

export function publicKeyFromPrivate(privateKey: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(privateKey, true));
}

export function relativePath(isChange: boolean, index: number): string {
  return `m/${isChange ? 1 : 0}/${index}`;
}

export function compactPublicKey(pubKeyHex: string): Uint8Array {
  const bytes = hexToBytes(pubKeyHex);
  if (bytes.length === 33) return bytes;
  if (bytes.length === 32) return secp256k1.getPublicKey(bytes, true);
  throw new Error('Unexpected public key length');
}
