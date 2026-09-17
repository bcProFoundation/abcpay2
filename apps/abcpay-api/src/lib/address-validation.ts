import type { SupportedCoin } from '@bcpros/abcpay-models';
import { decodeAddress, deriveWalletAddress } from '@bcpros/abcpay-wallet-core';

export function scriptKey(coin: SupportedCoin, address: string): string {
  try {
    const decoded = decodeAddress(coin, address);
    return `${decoded.type}:${decoded.hashHex}`;
  } catch {
    return `raw:${address}`;
  }
}

export function addressMatchesDerivation(opts: {
  coin: SupportedCoin;
  network: 'livenet' | 'testnet';
  xPubKeys: string[];
  m: number;
  n: number;
  path: string;
  address: string;
}): boolean {
  try {
    const derived = deriveWalletAddress({
      coin: opts.coin,
      network: opts.network,
      xPubKeys: opts.xPubKeys,
      m: opts.m,
      n: opts.n,
      path: opts.path
    });
    return scriptKey(opts.coin, derived.address) === scriptKey(opts.coin, opts.address);
  } catch {
    return false;
  }
}
