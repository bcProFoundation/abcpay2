import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SupportedCoin, WalletResponse } from '@bcpros/abcpay-models';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import type { WalletCredentials } from '@bcpros/abcpay-wallet-core';
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
  fiatBalance: string;
  status: string;
}

export interface StoredCredentials extends WalletCredentials {
  walletId: string;
  copayerName: string;
}

interface WalletContextValue {
  wallets: LocalWallet[];
  addWallet: (wallet: LocalWallet, credentials: StoredCredentials) => void;
  removeWallet: (id: string) => void;
  refreshBalances: () => Promise<void>;
  showBalance: boolean;
  setShowBalance: (show: boolean) => void;
  totalFiatBalance: string;
  credentialsFor: (walletId: string) => StoredCredentials | undefined;
  authFor: (walletId: string) => AuthContext | undefined;
  pendingMnemonic: string | null;
  setPendingMnemonic: (mnemonic: string | null) => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const WALLETS_KEY = 'abcpay_v2_wallets';
const CREDS_KEY = 'abcpay_v2_credentials';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<LocalWallet[]>(() => loadJson(WALLETS_KEY, []));
  const [credentials, setCredentials] = useState<StoredCredentials[]>(() => loadJson(CREDS_KEY, []));
  const [showBalance, setShowBalance] = useState(true);
  const [totalFiatBalance, setTotalFiatBalance] = useState('$0.00');
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
  }, [wallets]);

  useEffect(() => {
    localStorage.setItem(CREDS_KEY, JSON.stringify(credentials));
  }, [credentials]);

  const addWallet = useCallback((wallet: LocalWallet, creds: StoredCredentials) => {
    setWallets(prev => (prev.some(w => w.id === wallet.id) ? prev : [...prev, wallet]));
    setCredentials(prev => (prev.some(c => c.walletId === creds.walletId) ? prev : [...prev, creds]));
  }, []);

  const removeWallet = useCallback((id: string) => {
    setWallets(prev => prev.filter(w => w.id !== id));
    setCredentials(prev => prev.filter(c => c.walletId !== id));
  }, []);

  const credentialsFor = useCallback(
    (walletId: string) => credentials.find(c => c.walletId === walletId),
    [credentials]
  );

  const authFor = useCallback(
    (walletId: string): AuthContext | undefined => {
      const creds = credentials.find(c => c.walletId === walletId);
      if (!creds) return undefined;
      return { walletId, copayerId: creds.copayerId, requestPrivKey: creds.requestPrivKey };
    },
    [credentials]
  );

  const refreshBalances = useCallback(async () => {
    let totalFiat = 0;
    const updated = await Promise.all(
      wallets.map(async wallet => {
        const auth = authFor(wallet.id);
        if (!auth) return wallet;
        try {
          const balance = await api.getBalance(auth);
          const fiat = await api.getFiatRate(wallet.coin);
          const config = COIN_CONFIGS[wallet.coin];
          const amount = balance.totalAmount / config.unitToSatoshi;
          const fiatAmount = amount * fiat.rate;
          totalFiat += fiatAmount;
          const remote = await api.getWallet(auth);
          return {
            ...wallet,
            balance: balance.totalAmount,
            fiatBalance: `$${fiatAmount.toFixed(2)}`,
            status: remote.status,
            m: remote.m,
            n: remote.n
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

  const value = useMemo(
    () => ({
      wallets,
      addWallet,
      removeWallet,
      refreshBalances,
      showBalance,
      setShowBalance,
      totalFiatBalance,
      credentialsFor,
      authFor,
      pendingMnemonic,
      setPendingMnemonic
    }),
    [
      wallets,
      addWallet,
      removeWallet,
      refreshBalances,
      showBalance,
      totalFiatBalance,
      credentialsFor,
      authFor,
      pendingMnemonic
    ]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallets() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallets must be used within WalletProvider');
  return ctx;
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
    fiatBalance: '$0.00',
    status: response.status
  };
}
