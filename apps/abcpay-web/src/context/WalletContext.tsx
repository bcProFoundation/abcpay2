import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SupportedCoin, TokenBalance, WalletResponse } from '@bcpros/abcpay-models';
import { COIN_CONFIGS, defaultWalletCoinType } from '@bcpros/abcpay-models';
import type { WalletCredentials } from '@bcpros/abcpay-wallet-core';
import {
  accountLabel,
  accountPathFor,
  createCredentials,
  DEFAULT_TOKEN_VISIBILITY,
  groupAccountsByWallet,
  seedIdForCredentials,
  sortAccounts,
  withTokenVisibility,
  type TokenVisibilitySettings
} from '@bcpros/abcpay-wallet-core';
import { getCredentials, saveCredentials } from '../lib/credentials-store';
import { getWalletBalance as getBalanceFromStored } from '../lib/bwc';
import { api, type AuthContext } from '../lib/api';

/**
 * One Account = one derivation (path + coin) under a Wallet (seed).
 * `id` is the internal server account id used for API routing/auth only —
 * it is never shown to the user. The user-facing identity is the Wallet
 * (seedId) and the Account path.
 */
export interface LocalAccount {
  id: string;
  name: string;
  coin: SupportedCoin;
  m: number;
  n: number;
  copayerId: string;
  copayerName: string;
  balance: number;
  tokenCount: number;
  fiatBalance: string;
  status: string;
  secret?: string;
  /** Derivation variant, e.g. 1899 / 899 / 145 (XEC) or 3 (DOGE). */
  coinType?: number;
  /** Wallet (seed) identity — requestPubKey at m/1'/0, shared by all Accounts of one seed. */
  seedId?: string;
  /** Account derivation root, e.g. m/48'/899'/0'. */
  accountPath?: string;
  network?: string;
  /** @deprecated Renamed to seedId (seed = Wallet). */
  accountId?: string;
}

/** @deprecated Use LocalAccount — a "wallet" in the UI is now the seed. */
export type LocalWallet = LocalAccount;

/** One Wallet (seed) and every Account recovered under it. */
export interface SeedWallet {
  /** Wallet (seed) id — points to the seed, not a server account record. */
  id: string;
  label: string;
  accounts: LocalAccount[];
  /** Accounts merged by path+coin (network does not split an Account). */
  groupedAccounts: GroupedAccount[];
}

/** @deprecated Use SeedWallet */
export type WalletAccount = SeedWallet;

/** Same Account on one or more networks (livenet/testnet stay one Account). */
export interface GroupedAccount {
  key: string;
  accountPath: string;
  coin: SupportedCoin;
  coinType?: number;
  m: number;
  n: number;
  networks: string[];
  entries: LocalAccount[];
}

export function labelForAccount(
  account: Pick<LocalAccount, 'coin' | 'coinType' | 'm' | 'n' | 'accountPath' | 'network'>
): string {
  return accountLabel(account);
}

/** @deprecated Use labelForAccount */
export const labelForWallet = labelForAccount;

/**
 * Title shown for an Account row: path (+ m-of-n). Never includes the server
 * wallet record id — Wallet ids belong only at the Wallet (seed) level.
 */
export function accountDisplayTitle(
  account: Pick<LocalAccount, 'coin' | 'coinType' | 'm' | 'n' | 'accountPath'>
): string {
  const path =
    account.accountPath ??
    accountPathFor({
      coin: account.coin,
      coinType: account.coinType,
      m: account.m,
      n: account.n
    });
  return account.n > 1 ? `${path} · ${account.m}-of-${account.n}` : path;
}

export function groupAccountsByPath(accounts: LocalAccount[]): GroupedAccount[] {
  const byKey = new Map<string, GroupedAccount>();
  for (const account of accounts) {
    const accountPath =
      account.accountPath ?? accountPathFor({ coin: account.coin, coinType: account.coinType, n: account.n });
    const key = `${accountPath}|${account.coin}|${account.m}|${account.n}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.entries.push(account);
      if (account.network && !existing.networks.includes(account.network)) {
        existing.networks.push(account.network);
      }
    } else {
      byKey.set(key, {
        key,
        accountPath,
        coin: account.coin,
        coinType: account.coinType,
        m: account.m,
        n: account.n,
        networks: account.network ? [account.network] : [],
        entries: [account]
      });
    }
  }
  return [...byKey.values()];
}

export function groupIntoSeedWallets(accounts: LocalAccount[]): SeedWallet[] {
  return groupAccountsByWallet(accounts).map(group => ({
    id: group.id,
    label: 'Wallet',
    accounts: group.accounts,
    groupedAccounts: groupAccountsByPath(group.accounts)
  }));
}

/** @deprecated Use groupIntoSeedWallets */
export function groupWalletsIntoAccounts(wallets: LocalAccount[]): SeedWallet[] {
  return groupIntoSeedWallets(wallets);
}

export interface StoredCredentials extends WalletCredentials {
  walletId: string;
  copayerName: string;
}

interface WalletContextValue {
  /** Flat Accounts (one per derivation/server record) across all Wallets. */
  accounts: LocalAccount[];
  /** @deprecated Use accounts — kept for pages not yet migrated. */
  wallets: LocalAccount[];
  /** Accounts grouped by Wallet (seed). One seed = one Wallet. */
  seedWallets: SeedWallet[];
  /** @deprecated Use seedWallets */
  walletGroups: SeedWallet[];
  activeAccount: LocalAccount | undefined;
  /** @deprecated Use activeAccount */
  activeWallet: LocalAccount | undefined;
  activeAccountId: string | null;
  /** @deprecated Use activeAccountId */
  activeWalletId: string | null;
  setActiveAccount: (id: string) => void;
  /** @deprecated Use setActiveAccount */
  setActiveWallet: (id: string) => void;
  addAccount: (account: LocalAccount) => void;
  /** @deprecated Use addAccount */
  addWallet: (account: LocalAccount) => void;
  addAccounts: (accounts: LocalAccount[]) => void;
  /** @deprecated Use addAccounts */
  addWallets: (accounts: LocalAccount[]) => void;
  removeAccount: (id: string) => void;
  /** @deprecated Use removeAccount */
  removeWallet: (id: string) => void;
  refreshBalances: () => Promise<void>;
  showBalance: boolean;
  setShowBalance: (show: boolean) => void;
  totalFiatBalance: string;
  getWalletCredentials: (accountId: string) => string | null;
  credentialsFor: (accountId: string) => StoredCredentials | undefined;
  authFor: (accountId: string) => AuthContext | undefined;
  pendingMnemonic: string | null;
  setPendingMnemonic: (mnemonic: string | null) => void;
  /** App-level token visibility (per app, not per account). Tokens hidden by default. */
  tokenVisibility: TokenVisibilitySettings;
  setTokenVisible: (tokenId: string, visible: boolean) => void;
  /** Every token held by any Account on this device, for the Settings picker. */
  knownTokens: TokenBalance[];
  tokensByAccount: Record<string, TokenBalance[]>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const WALLETS_KEY = 'abcpay_v2_wallets';
const ACTIVE_WALLET_KEY = 'abcpay_v2_active_wallet';
const TOKEN_VISIBILITY_KEY = 'abcpay_token_visibility_v1';
const KNOWN_TOKENS_KEY = 'abcpay_known_tokens_v1';

function loadWallets(): LocalAccount[] {
  try {
    const raw = localStorage.getItem(WALLETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LocalAccount[];
    // Migrate pre-rename records: accountId was the seed id.
    return parsed.map(w => ({
      ...w,
      seedId: w.seedId ?? w.accountId,
      accountPath:
        w.accountPath ??
        accountPathFor({ coin: w.coin, coinType: w.coinType, n: w.n }),
      network: w.network ?? 'livenet'
    }));
  } catch {
    return [];
  }
}

function loadTokenVisibility(): TokenVisibilitySettings {
  try {
    const raw = localStorage.getItem(TOKEN_VISIBILITY_KEY);
    if (!raw) return DEFAULT_TOKEN_VISIBILITY;
    const parsed = JSON.parse(raw) as TokenVisibilitySettings;
    return { visibleTokenIds: Array.isArray(parsed.visibleTokenIds) ? parsed.visibleTokenIds : [] };
  } catch {
    return DEFAULT_TOKEN_VISIBILITY;
  }
}

function loadKnownTokens(): TokenBalance[] {
  try {
    const raw = localStorage.getItem(KNOWN_TOKENS_KEY);
    return raw ? (JSON.parse(raw) as TokenBalance[]) : [];
  } catch {
    return [];
  }
}

function accountXPrivFor(stored: {
  coin: SupportedCoin;
  keys: WalletCredentials;
}, n: number): string | undefined {
  const variant = stored.keys as WalletCredentials & { coinType?: number };
  const candidates = Array.from(
    new Set(
      [
        variant.coinType,
        defaultWalletCoinType(stored.coin, n > 1),
        stored.coin === 'xec' ? 1899 : undefined,
        stored.coin === 'xec' ? 899 : undefined,
        stored.coin === 'xec' ? 145 : undefined
      ].filter((value): value is number => typeof value === 'number')
    )
  );
  for (const coinType of candidates) {
    try {
      const account = createCredentials({
        coin: stored.coin,
        mnemonic: stored.keys.mnemonic,
        isMultisig: n > 1,
        usePurpose48: n > 1,
        coinType
      });
      if (account.xPubKey === stored.keys.xPubKey) return account.xPrivKey;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function parseStoredCredentials(walletId: string, wallets: LocalWallet[]): StoredCredentials | undefined {
  const raw = getCredentials(walletId);
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as {
      walletId: string;
      copayerId: string;
      coin: SupportedCoin;
      m?: number;
      n?: number;
      keys: WalletCredentials;
    };
    const wallet = wallets.find(w => w.id === walletId);
    const coin = stored.coin ?? stored.keys.coin;
    const n = wallet?.n ?? stored.n ?? 1;

    // Older clients stored the root key as xPrivKey; signing must use the account key.
    const accountXPriv = accountXPrivFor({ coin, keys: stored.keys }, n);
    if (accountXPriv && accountXPriv !== stored.keys.xPrivKey) {
      stored.keys.xPrivKey = accountXPriv;
      saveCredentials(walletId, JSON.stringify({ ...stored, keys: { ...stored.keys } }));
    }

    return {
      ...stored.keys,
      walletId,
      copayerId: stored.copayerId,
      copayerName: wallet?.copayerName ?? '',
      coin
    };
  } catch {
    return undefined;
  }
}

function storedSeedId(walletId: string): string | undefined {
  const raw = getCredentials(walletId);
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as { keys?: { requestPubKey?: string; coinType?: number } };
    return stored.keys?.requestPubKey;
  } catch {
    return undefined;
  }
}

function storedCoinType(walletId: string): number | undefined {
  const raw = getCredentials(walletId);
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as { keys?: { coinType?: number } };
    return stored.keys?.coinType;
  } catch {
    return undefined;
  }
}

function storedAccountPath(walletId: string): string | undefined {
  const raw = getCredentials(walletId);
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as { keys?: { accountPath?: string } };
    return stored.keys?.accountPath;
  } catch {
    return undefined;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<LocalAccount[]>(loadWallets);
  const [activeWalletId, setActiveWalletId] = useState<string | null>(() => localStorage.getItem(ACTIVE_WALLET_KEY));
  const [showBalance, setShowBalance] = useState(true);
  const [totalFiatBalance, setTotalFiatBalance] = useState('$0.00');
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  const [tokenVisibility, setTokenVisibility] = useState<TokenVisibilitySettings>(loadTokenVisibility);
  const [knownTokens, setKnownTokens] = useState<TokenBalance[]>(loadKnownTokens);
  const [tokensByAccount, setTokensByAccount] = useState<Record<string, TokenBalance[]>>({});

  useEffect(() => {
    localStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
  }, [wallets]);

  useEffect(() => {
    if (activeWalletId) localStorage.setItem(ACTIVE_WALLET_KEY, activeWalletId);
    else localStorage.removeItem(ACTIVE_WALLET_KEY);
  }, [activeWalletId]);

  useEffect(() => {
    localStorage.setItem(TOKEN_VISIBILITY_KEY, JSON.stringify(tokenVisibility));
  }, [tokenVisibility]);

  useEffect(() => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(knownTokens));
  }, [knownTokens]);

  const setTokenVisible = useCallback((tokenId: string, visible: boolean) => {
    setTokenVisibility(prev => withTokenVisibility(prev, tokenId, visible));
  }, []);

  // Keep exactly one active Account (default: the newest).
  useEffect(() => {
    if (wallets.length === 0) {
      if (activeWalletId) setActiveWalletId(null);
      return;
    }
    if (!activeWalletId || !wallets.some(wallet => wallet.id === activeWalletId)) {
      setActiveWalletId(wallets[wallets.length - 1].id);
    }
  }, [wallets, activeWalletId]);

  const setActiveWallet = useCallback((id: string) => {
    setActiveWalletId(id);
  }, []);

  const activeWallet = wallets.find(wallet => wallet.id === activeWalletId) ?? wallets[wallets.length - 1];

  const addWallet = useCallback((wallet: LocalAccount) => {
    setWallets(prev =>
      prev.some(w => w.id === wallet.id)
        ? prev.map(w => (w.id === wallet.id ? { ...w, ...wallet } : w))
        : [...prev, wallet]
    );
    setActiveWalletId(wallet.id);
  }, []);

  const addWallets = useCallback((incoming: LocalAccount[]) => {
    if (incoming.length === 0) return;
    setWallets(prev => {
      const merged = [...prev];
      for (const wallet of incoming) {
        const idx = merged.findIndex(w => w.id === wallet.id);
        if (idx === -1) merged.push(wallet);
        else merged[idx] = { ...merged[idx], ...wallet };
      }
      return merged;
    });
    // Land on the first Account in stable order; Home shows the whole Wallet.
    setActiveWalletId(sortAccounts(incoming)[0].id);
  }, []);

  const enrichedAccounts = wallets.map(wallet => ({
    ...wallet,
    seedId: wallet.seedId ?? wallet.accountId ?? storedSeedId(wallet.id),
    coinType: wallet.coinType ?? storedCoinType(wallet.id),
    accountPath:
      wallet.accountPath ??
      storedAccountPath(wallet.id) ??
      accountPathFor({
        coin: wallet.coin,
        coinType: wallet.coinType ?? storedCoinType(wallet.id),
        n: wallet.n
      }),
    network: wallet.network ?? 'livenet'
  }));
  const seedWallets = groupIntoSeedWallets(enrichedAccounts);

  const removeWallet = useCallback((id: string) => {
    setWallets(prev => prev.filter(w => w.id !== id));
  }, []);

  const getWalletCredentials = useCallback((walletId: string) => getCredentials(walletId), []);

  const credentialsFor = useCallback(
    (walletId: string) => parseStoredCredentials(walletId, wallets),
    [wallets]
  );

  const authFor = useCallback(
    (walletId: string): AuthContext | undefined => {
      const creds = parseStoredCredentials(walletId, wallets);
      if (!creds) return undefined;
      return { walletId, copayerId: creds.copayerId, requestPrivKey: creds.requestPrivKey };
    },
    [wallets]
  );

  const refreshBalances = useCallback(async () => {
    let totalFiat = 0;
    const nextTokensByAccount: Record<string, TokenBalance[]> = {};
    const discovered = new Map<string, TokenBalance>();

    const updated = await Promise.all(
      wallets.map(async wallet => {
        try {
          const auth = authFor(wallet.id);
          let balance = 0;
          let tokenCount = wallet.tokenCount ?? 0;

          if (auth) {
            try {
              const remoteBalance = await api.getBalance(auth);
              balance = remoteBalance.totalAmount;
              tokenCount = remoteBalance.tokens?.length ?? 0;
              nextTokensByAccount[wallet.id] = remoteBalance.tokens ?? [];
              for (const token of remoteBalance.tokens ?? []) {
                if (!discovered.has(token.tokenId)) discovered.set(token.tokenId, token);
              }
            } catch {
              const creds = getCredentials(wallet.id);
              if (creds) {
                try {
                  balance = await getBalanceFromStored(creds);
                } catch {
                  balance = wallet.balance;
                }
              }
            }
          }

          const fiat = await api.getFiatRate(wallet.coin);
          const config = COIN_CONFIGS[wallet.coin];
          const amount = balance / config.unitToSatoshi;
          const fiatAmount = amount * fiat.rate;
          totalFiat += fiatAmount;

          let status = wallet.status;
          let m = wallet.m;
          let n = wallet.n;
          if (auth) {
            try {
              const remote = await api.getWallet(auth);
              status = remote.status;
              m = remote.m;
              n = remote.n;
            } catch {
              // keep local values
            }
          }

          return {
            ...wallet,
            balance,
            tokenCount,
            fiatBalance: `$${fiatAmount.toFixed(2)}`,
            status,
            m,
            n
          };
        } catch {
          return wallet;
        }
      })
    );

    setWallets(updated);
    setTotalFiatBalance(`$${totalFiat.toFixed(2)}`);
    if (Object.keys(nextTokensByAccount).length > 0) {
      setTokensByAccount(prev => ({ ...prev, ...nextTokensByAccount }));
      setKnownTokens(prev => {
        const merged = new Map(prev.map(t => [t.tokenId, t]));
        for (const token of discovered.values()) merged.set(token.tokenId, token);
        return [...merged.values()];
      });
    }
  }, [wallets, authFor]);

  const walletIds = wallets.map(wallet => wallet.id).join(',');
  useEffect(() => {
    if (wallets.length > 0) {
      void refreshBalances();
    }
    // Refresh when the wallet set changes (e.g. after mnemonic restore), not on every balance update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletIds]);

  return (
    <WalletContext.Provider
      value={{
        accounts: enrichedAccounts,
        wallets: enrichedAccounts,
        seedWallets,
        walletGroups: seedWallets,
        activeAccount: activeWallet,
        activeWallet,
        activeAccountId: activeWalletId,
        activeWalletId,
        setActiveAccount: setActiveWallet,
        setActiveWallet,
        addAccount: addWallet,
        addWallet,
        addAccounts: addWallets,
        addWallets,
        removeAccount: removeWallet,
        removeWallet,
        refreshBalances,
        showBalance,
        setShowBalance,
        totalFiatBalance,
        getWalletCredentials,
        credentialsFor,
        authFor,
        pendingMnemonic,
        setPendingMnemonic,
        tokenVisibility,
        setTokenVisible,
        knownTokens,
        tokensByAccount
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallets() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallets must be used within WalletProvider');
  return ctx;
}

export function walletFromBwc(
  walletId: string,
  name: string,
  coin: SupportedCoin,
  m: number,
  n: number,
  copayerId: string,
  copayerName: string,
  status: string,
  secret?: string,
  extras?: { coinType?: number; seedId?: string; accountId?: string; accountPath?: string; network?: string }
): LocalAccount {
  const coinType = extras?.coinType;
  return {
    id: walletId,
    name,
    coin,
    m,
    n,
    copayerId,
    copayerName,
    balance: 0,
    tokenCount: 0,
    fiatBalance: '$0.00',
    status,
    secret,
    coinType,
    seedId: extras?.seedId ?? extras?.accountId,
    accountPath: extras?.accountPath ?? accountPathFor({ coin, coinType, n }),
    network: extras?.network ?? 'livenet'
  };
}

export function walletFromResponse(
  response: WalletResponse,
  copayerId: string,
  copayerName: string,
  extras?: { coinType?: number; seedId?: string; accountId?: string; creds?: WalletCredentials }
): LocalAccount {
  const coinType = extras?.coinType ?? extras?.creds?.coinType ?? response.coinType;
  return {
    id: response.id,
    name: response.name,
    coin: response.coin,
    m: response.m,
    n: response.n,
    copayerId,
    copayerName,
    balance: 0,
    tokenCount: 0,
    fiatBalance: '$0.00',
    status: response.status,
    coinType,
    seedId:
      extras?.seedId ??
      extras?.accountId ??
      (extras?.creds ? seedIdForCredentials(extras.creds) : undefined),
    accountPath:
      extras?.creds?.accountPath ??
      accountPathFor({ coin: response.coin, coinType, n: response.n }),
    network: response.network
  };
}
