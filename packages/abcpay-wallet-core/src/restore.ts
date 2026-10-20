import {
  COIN_CONFIGS,
  XEC_NATIVE_COIN_TYPE,
  XEC_RAIPAY_COIN_TYPE,
  XEC_TOKEN_AWARE_COIN_TYPE,
  type SupportedCoin
} from '@bcpros/abcpay-models';
import { createCredentials, type WalletCredentials } from './keys';

/**
 * One seed (mnemonic) is one Account. Under it a v1 user could hold many
 * wallets — each derivation variant is an account-wallet that must be
 * recovered, not just the product-default one:
 *
 *   XEC single-sig  m/44'/1899'  (token-aware), m/44'/899' (native), m/44'/145' (RaiPay)
 *   XEC multisig    m/48'/899', m/48'/1899', m/48'/145'
 *   DOGE single-sig m/44'/3'
 *   DOGE multisig   m/48'/3'
 *
 * The previous scan omitted RaiPay (145) multisig, so those wallets were
 * invisible to mnemonic-only restore.
 */
export const XEC_RESTORE_COIN_TYPES: readonly number[] = [
  XEC_TOKEN_AWARE_COIN_TYPE,
  XEC_NATIVE_COIN_TYPE,
  XEC_RAIPAY_COIN_TYPE
];

export interface RestoreAccountDescriptor {
  coin: SupportedCoin;
  coinType: number;
  isMultisig: boolean;
  /** Account root path, e.g. m/48'/899'/0' */
  accountPath: string;
}

/** Every derivation variant a single seed can hold, in stable display order. */
export function restoreAccountDescriptors(): RestoreAccountDescriptor[] {
  const out: RestoreAccountDescriptor[] = [];
  for (const isMultisig of [false, true]) {
    for (const coinType of XEC_RESTORE_COIN_TYPES) {
      out.push({
        coin: 'xec',
        coinType,
        isMultisig,
        accountPath: `m/${isMultisig ? 48 : 44}'/${coinType}'/0'`
      });
    }
  }
  for (const isMultisig of [false, true]) {
    out.push({
      coin: 'doge',
      coinType: COIN_CONFIGS.doge.bip44CoinType,
      isMultisig,
      accountPath: `m/${isMultisig ? 48 : 44}'/${COIN_CONFIGS.doge.bip44CoinType}'/0'`
    });
  }
  return out;
}

/**
 * Derive one candidate credential set per account variant for a seed.
 * Deduped by copayerId — request keys are seed-level, so the same seed
 * yields the same requestPubKey for every candidate (see accountIdFor).
 */
export function restoreCandidatesForMnemonic(mnemonic: string): WalletCredentials[] {
  const seen = new Set<string>();
  const out: WalletCredentials[] = [];
  for (const descriptor of restoreAccountDescriptors()) {
    const creds = createCredentials({
      coin: descriptor.coin,
      mnemonic,
      isMultisig: descriptor.isMultisig,
      usePurpose48: descriptor.isMultisig,
      coinType: descriptor.coinType
    });
    if (seen.has(creds.copayerId)) continue;
    seen.add(creds.copayerId);
    out.push(creds);
  }
  return out;
}

/**
 * Seed-level identity shared by every account under one mnemonic.
 * The request key is derived at m/1'/0 from the master seed, independent of
 * coin / coinType / purpose, so it identifies the Account (seed) that a
 * wallet belongs to without storing the phrase again.
 */
export function accountIdForCredentials(creds: Pick<WalletCredentials, 'requestPubKey'>): string {
  return creds.requestPubKey;
}

/** Human label for one account-wallet, e.g. "XEC · 1899" or "XEC · 2-of-3 multisig · 899". */
export function accountLabel(opts: {
  coin: SupportedCoin;
  coinType?: number;
  m: number;
  n: number;
}): string {
  const coin = opts.coin.toUpperCase();
  const coinType =
    opts.coinType ?? (opts.coin === 'xec' ? XEC_TOKEN_AWARE_COIN_TYPE : COIN_CONFIGS.doge.bip44CoinType);
  return opts.n > 1
    ? `${coin} · ${opts.m}-of-${opts.n} multisig · ${coinType}`
    : `${coin} · ${coinType}`;
}

/** Stable UI ordering: XEC first, single-sig before multisig, then coinType order above. */
export function compareAccountWallets(
  a: { coin: SupportedCoin; coinType?: number; m: number; n: number },
  b: { coin: SupportedCoin; coinType?: number; m: number; n: number }
): number {
  const coinOrder = (coin: SupportedCoin) => (coin === 'xec' ? 0 : 1);
  const coinTypeOrder = (coin: SupportedCoin, coinType?: number) => {
    if (coin !== 'xec') return 0;
    const idx = XEC_RESTORE_COIN_TYPES.indexOf(coinType ?? XEC_TOKEN_AWARE_COIN_TYPE);
    return idx === -1 ? XEC_RESTORE_COIN_TYPES.length : idx;
  };
  return (
    coinOrder(a.coin) - coinOrder(b.coin) ||
    Number(a.n > 1) - Number(b.n > 1) ||
    coinTypeOrder(a.coin, a.coinType) - coinTypeOrder(b.coin, b.coinType) ||
    a.m - b.m ||
    a.n - b.n
  );
}

export function sortAccountWallets<T extends { coin: SupportedCoin; coinType?: number; m: number; n: number }>(
  wallets: readonly T[]
): T[] {
  return [...wallets].sort(compareAccountWallets);
}

export interface AccountGroup<T> {
  /** Seed-level Account id (requestPubKey) shared by every wallet in the group. */
  id: string;
  wallets: T[];
}

/**
 * Group account-wallets by seed: one seed = one Account. Wallets without a
 * known seed identity fall back to their own id so they are never merged
 * into another seed's Account by accident.
 */
export function groupWalletsByAccount<
  T extends { id: string; accountId?: string; coin: SupportedCoin; coinType?: number; m: number; n: number }
>(wallets: readonly T[]): AccountGroup<T>[] {
  const byAccount = new Map<string, T[]>();
  for (const wallet of wallets) {
    const key = wallet.accountId ?? wallet.id;
    byAccount.set(key, [...(byAccount.get(key) ?? []), wallet]);
  }
  return [...byAccount.entries()].map(([id, group]) => ({
    id,
    wallets: sortAccountWallets(group)
  }));
}
