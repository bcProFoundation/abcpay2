import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SupportedCoin, WalletResponse } from '@bcpros/abcpay-models';
import { COIN_CONFIGS, defaultWalletCoinType } from '@bcpros/abcpay-models';
import type { WalletCredentials } from '@bcpros/abcpay-wallet-core';
import { createCredentials } from '@bcpros/abcpay-wallet-core';
import { getCredentials, saveCredentials } from '../lib/credentials-store';
import { getWalletBalance as getBalanceFromStored } from '../lib/bwc';
import { api, type AuthContext } from '../lib/api';

export interface LocalWallet {
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
}

export interface StoredCredentials extends WalletCredentials {
  walletId: string;
  copayerName: string;
}

interface WalletContextValue {
  wallets: LocalWallet[];
  addWallet: (wallet: LocalWallet) => void;
  removeWallet: (id: string) => void;
  refreshBalances: () => Promise<void>;
  showBalance: boolean;
  setShowBalance: (show: boolean) => void;
  totalFiatBalance: string;
  getWalletCredentials: (walletId: string) => string | null;
  credentialsFor: (walletId: string) => StoredCredentials | undefined;
  authFor: (walletId: string) => AuthContext | undefined;
  pendingMnemonic: string | null;
  setPendingMnemonic: (mnemonic: string | null) => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const WALLETS_KEY = 'abcpay_v2_wallets';

function loadWallets(): LocalWallet[] {
  try {
    const raw = localStorage.getItem(WALLETS_KEY);
    return raw ? (JSON.parse(raw) as LocalWallet[]) : [];
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
        stored.coin === 'xec' ? 899 : undefined
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

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<LocalWallet[]>(loadWallets);
  const [showBalance, setShowBalance] = useState(true);
  const [totalFiatBalance, setTotalFiatBalance] = useState('$0.00');
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
  }, [wallets]);

  const addWallet = useCallback((wallet: LocalWallet) => {
    setWallets(prev => (prev.some(w => w.id === wallet.id) ? prev : [...prev, wallet]));
  }, []);

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
  }, [wallets, authFor]);

  useEffect(() => {
    if (wallets.length > 0) {
      void refreshBalances();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <WalletContext.Provider
      value={{
        wallets,
        addWallet,
        removeWallet,
        refreshBalances,
        showBalance,
        setShowBalance,
        totalFiatBalance,
        getWalletCredentials,
        credentialsFor,
        authFor,
        pendingMnemonic,
        setPendingMnemonic
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
  secret?: string
): LocalWallet {
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
    secret
  };
}

export function walletFromResponse(
  response: WalletResponse,
  copayerId: string,
  copayerName: string
): LocalWallet {
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
    status: response.status
  };
}
