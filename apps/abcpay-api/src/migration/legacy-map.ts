import { copayerIdFromXpub, decodeAddress } from '@bcpros/abcpay-wallet-core';
import {
  XEC_NATIVE_COIN_TYPE,
  XEC_TOKEN_AWARE_COIN_TYPE,
  type SupportedCoin
} from '@bcpros/abcpay-models';

export const LEGACY_SUPPORTED_COINS = ['xec', 'doge'] as const;

export interface LegacyCopayer {
  id?: string;
  copayerId?: string;
  name?: string;
  xPubKey?: string;
  requestPubKey?: string;
  requestPubKeys?: Array<{ key?: string; requestPubKey?: string }>;
  signature?: string;
  customData?: unknown;
  createdOn?: number;
}

export interface LegacyWallet {
  id?: string;
  name?: string;
  m?: number;
  n?: number;
  coin?: string;
  chain?: string;
  network?: string;
  derivationStrategy?: string;
  addressType?: string;
  pubKey?: string;
  publicKeyRing?: Array<{ xPubKey?: string; requestPubKey?: string }>;
  copayers?: LegacyCopayer[];
  singleAddress?: boolean;
  status?: string;
  nativeCashAddr?: boolean | null;
  usePurpose48?: boolean;
  isSlpToken?: boolean;
  isFromRaipay?: boolean;
  isPath899?: boolean;
  createdOn?: number;
}

export interface LegacyAddress {
  walletId?: string;
  address?: string;
  path?: string;
  publicKeys?: string[];
  isChange?: boolean;
  type?: string;
  coin?: string;
  chain?: string;
  network?: string;
  createdOn?: number;
}

export interface MappedWallet {
  walletId: string;
  name: string;
  m: number;
  n: number;
  coin: SupportedCoin;
  chain: string;
  network: string;
  addressType: 'P2PKH' | 'P2SH';
  coinType: number;
  status: 'pending' | 'complete' | 'deleted';
  pubKey: string;
  singleAddress: boolean;
  nativeCashAddr: boolean;
  usePurpose48: boolean;
}

export interface MappedCopayer {
  copayerId: string;
  derivedCopayerId: string;
  walletId: string;
  name: string;
  xPubKey: string;
  requestPubKey: string;
  signature?: string;
  customData?: string;
}

export interface SkipResult {
  skip: true;
  reason: string;
}

export function legacyCoinTypeFor(wallet: LegacyWallet): number | null {
  const coin = (wallet.coin ?? '').toLowerCase();
  if (coin === 'doge') return 3;
  if (coin !== 'xec') return null;
  if (wallet.isFromRaipay) return null;
  if (!wallet.isSlpToken) return XEC_NATIVE_COIN_TYPE;
  return wallet.isPath899 ? XEC_NATIVE_COIN_TYPE : XEC_TOKEN_AWARE_COIN_TYPE;
}

export function mapLegacyWallet(wallet: LegacyWallet): MappedWallet | SkipResult {
  const coin = (wallet.coin ?? '').toLowerCase();
  if (!(LEGACY_SUPPORTED_COINS as readonly string[]).includes(coin)) {
    return { skip: true, reason: `unsupported coin: ${coin || 'unknown'}` };
  }
  if (!wallet.id) return { skip: true, reason: 'missing wallet id' };
  if ((wallet.network ?? 'livenet') !== 'livenet') {
    return { skip: true, reason: 'non-livenet wallets are not enabled in v2 (no testnet Chronik endpoints)' };
  }
  if (!wallet.m || !wallet.n || wallet.m < 1 || wallet.m > wallet.n) {
    return { skip: true, reason: 'invalid m-of-n configuration' };
  }
  const coinType = legacyCoinTypeFor(wallet);
  if (coinType === null) {
    return { skip: true, reason: 'raipay XEC path (145) is out of v2 scope' };
  }
  const status =
    wallet.status === 'complete' || wallet.status === 'deleted' ? wallet.status : 'pending';
  const addressType =
    wallet.addressType === 'P2SH' || wallet.addressType === 'P2PKH'
      ? wallet.addressType
      : wallet.n === 1
        ? 'P2PKH'
        : 'P2SH';

  return {
    walletId: wallet.id,
    name: wallet.name ?? 'Imported wallet',
    m: wallet.m,
    n: wallet.n,
    coin: coin as SupportedCoin,
    chain: (wallet.chain ?? coin).toLowerCase(),
    network: wallet.network ?? 'livenet',
    addressType,
    coinType,
    status,
    pubKey: wallet.pubKey ?? '',
    singleAddress: Boolean(wallet.singleAddress),
    nativeCashAddr: wallet.nativeCashAddr !== false,
    usePurpose48: Boolean(wallet.usePurpose48)
  };
}

export function mapLegacyCopayer(
  walletId: string,
  coin: SupportedCoin,
  copayer: LegacyCopayer
): MappedCopayer | SkipResult {
  const xPubKey = copayer.xPubKey;
  const requestPubKey =
    copayer.requestPubKey ?? copayer.requestPubKeys?.[0]?.requestPubKey ?? copayer.requestPubKeys?.[0]?.key;
  if (!xPubKey) return { skip: true, reason: 'missing copayer xPubKey' };
  if (!requestPubKey) return { skip: true, reason: 'missing copayer requestPubKey' };

  const derivedCopayerId = copayerIdFromXpub(coin, xPubKey);
  const customData = copayer.customData
    ? typeof copayer.customData === 'string'
      ? copayer.customData
      : JSON.stringify(copayer.customData)
    : undefined;

  return {
    copayerId: copayer.id ?? copayer.copayerId ?? derivedCopayerId,
    derivedCopayerId,
    walletId,
    name: copayer.name ?? 'Copayer',
    xPubKey,
    requestPubKey,
    signature: copayer.signature,
    customData
  };
}

export function nextAddressIndex(addresses: LegacyAddress[], isChange: boolean): number {
  let max = -1;
  for (const addr of addresses) {
    if (Boolean(addr.isChange) !== isChange) continue;
    const index = Number(addr.path?.split('/').pop());
    if (Number.isInteger(index) && index > max) max = index;
  }
  return max + 1;
}

export function addressScriptKey(coin: SupportedCoin, address: string): string {
  try {
    const decoded = decodeAddress(coin, address);
    return `${decoded.type}:${decoded.hashHex}`;
  } catch {
    return `raw:${address}`;
  }
}

export function publicKeyRingFromCopayers(copayers: MappedCopayer[]) {
  return copayers.map(c => ({ xPubKey: c.xPubKey, requestPubKey: c.requestPubKey }));
}
