import {
  COIN_CONFIGS,
  XEC_NATIVE_COIN_TYPE,
  XEC_RAIPAY_COIN_TYPE,
  XEC_TOKEN_AWARE_COIN_TYPE,
  type SupportedCoin
} from '@bcpros/abcpay-models';
import { createCredentials, type WalletCredentials } from './keys';

/**
 * Terminology: a seed (mnemonic) is a Wallet. Under a Wallet there are
 * Accounts — one per derivation variant. A v1 user could hold many
 * Accounts under one Wallet, and all of them must be recovered, not just
 * the product-default one:
 *
 *   XEC single-sig  m/44'/1899'  (token-aware), m/44'/899' (native), m/44'/145' (RaiPay)
 *   XEC multisig    m/48'/899', m/48'/1899', m/48'/145'
 *   DOGE single-sig m/44'/3'
 *   DOGE multisig   m/48'/3'
 *
 * The previous scan omitted RaiPay (145) multisig, so those Accounts were
 * invisible to mnemonic-only restore. The server wallet ID is internal
 * plumbing (API routing/auth); the user-facing Wallet identity is the
 * seed id (see seedIdForCredentials), and each Account is identified by
 * its derivation path + coin. Network does not split an Account.
 */
export const XEC_RESTORE_COIN_TYPES: readonly number[] = [
  XEC_TOKEN_AWARE_COIN_TYPE,
  XEC_NATIVE_COIN_TYPE,
  XEC_RAIPAY_COIN_TYPE
];

export interface AccountDescriptor {
  coin: SupportedCoin;
  coinType: number;
  isMultisig: boolean;
  /** Account root path, e.g. m/48'/899'/0' */
  accountPath: string;
}

/** @deprecated Use AccountDescriptor */
export type RestoreAccountDescriptor = AccountDescriptor;

/** Every Account (derivation variant) a single Wallet (seed) can hold. */
export function restoreAccountDescriptors(): AccountDescriptor[] {
  const out: AccountDescriptor[] = [];
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
 * Derive one candidate credential set per Account under a Wallet (seed).
 * Deduped by copayerId — request keys are seed-level, so the same seed
 * yields the same requestPubKey for every candidate (see seedIdForCredentials).
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
 * Wallet (seed) identity shared by every Account under one mnemonic.
 * The request key is derived at m/1'/0 from the master seed, independent of
 * coin / coinType / purpose / network, so it identifies the Wallet without
 * storing the phrase again. This is the user-facing "Wallet ID" now — it
 * points to the seed, not to any single server account record.
 */
export function seedIdForCredentials(creds: Pick<WalletCredentials, 'requestPubKey'>): string {
  return creds.requestPubKey;
}

/** @deprecated Use seedIdForCredentials */
export const accountIdForCredentials = seedIdForCredentials;

/** Short display form of a Wallet (seed) id, e.g. "Wallet · 0267d4ea…" */
export function walletDisplayId(seedId: string): string {
  return `Wallet · ${seedId.slice(0, 8)}…`;
}

/** Derivation root path of an Account, e.g. m/48'/899'/0'. */
export function accountPathFor(opts: {
  coin: SupportedCoin;
  coinType?: number;
  m?: number;
  n?: number;
  isMultisig?: boolean;
  account?: number;
}): string {
  const coinType =
    opts.coinType ??
    (opts.coin === 'xec' ? XEC_TOKEN_AWARE_COIN_TYPE : COIN_CONFIGS.doge.bip44CoinType);
  const multisig = opts.isMultisig ?? ((opts.n ?? 1) > 1);
  return `m/${multisig ? 48 : 44}'/${coinType}'/${opts.account ?? 0}'`;
}

/** Human label for one Account: path + coin, e.g. "XEC · m/48'/899'/0' · 2-of-3". */
export function accountLabel(opts: {
  coin: SupportedCoin;
  coinType?: number;
  m: number;
  n: number;
  accountPath?: string;
  network?: string;
}): string {
  const coin = opts.coin.toUpperCase();
  const path = opts.accountPath ?? accountPathFor(opts);
  const base = `${coin} · ${path}`;
  const withSig = opts.n > 1 ? `${base} · ${opts.m}-of-${opts.n}` : base;
  return opts.network && opts.network !== 'livenet' ? `${withSig} · ${opts.network}` : withSig;
}

/** Stable UI ordering: XEC first, single-sig before multisig, then coinType order above. */
export function compareAccounts(
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

export function sortAccounts<T extends { coin: SupportedCoin; coinType?: number; m: number; n: number }>(
  accounts: readonly T[]
): T[] {
  return [...accounts].sort(compareAccounts);
}

/** @deprecated Use sortAccounts */
export const sortAccountWallets = sortAccounts;
/** @deprecated Use compareAccounts */
export const compareAccountWallets = compareAccounts;

export interface WalletGroup<T> {
  /** Wallet (seed) id — requestPubKey shared by every Account in the group. */
  id: string;
  accounts: T[];
}

/**
 * Group Accounts by Wallet (seed): one seed = one Wallet. Accounts without
 * a known seed identity fall back to their own id so they are never merged
 * into another Wallet by accident. Network is not part of the grouping.
 */
export function groupAccountsByWallet<
  T extends {
    id: string;
    seedId?: string;
    coin: SupportedCoin;
    coinType?: number;
    m: number;
    n: number;
  }
>(accounts: readonly T[]): WalletGroup<T>[] {
  const byWallet = new Map<string, T[]>();
  for (const account of accounts) {
    const key = account.seedId ?? account.id;
    byWallet.set(key, [...(byWallet.get(key) ?? []), account]);
  }
  return [...byWallet.entries()].map(([id, group]) => ({
    id,
    accounts: sortAccounts(group)
  }));
}

/** @deprecated Use groupAccountsByWallet */
export function groupWalletsByAccount<
  T extends { id: string; accountId?: string; coin: SupportedCoin; coinType?: number; m: number; n: number }
>(wallets: readonly T[]): Array<{ id: string; wallets: T[] }> {
  return groupAccountsByWallet(
    wallets.map(w => ({ ...w, seedId: (w as { seedId?: string }).seedId ?? w.accountId }))
  ).map(g => ({ id: g.id, wallets: g.accounts }));
}

export type AccountGroup<T> = WalletGroup<T>;
