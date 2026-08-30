import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SupportedCoin } from '@bcpros/abcpay-models';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { getCredentials } from '../lib/credentials-store';
import { getWalletBalance as getBalanceFromStored } from '../lib/bwc';
import { api } from '../lib/api';

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
  secret?: string;
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
}

const WalletContext = createContext<WalletContextValue | null>(null);

const STORAGE_KEY = 'abcpay_v2_wallets';

function loadWallets(): LocalWallet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWallets(wallets: LocalWallet[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<LocalWallet[]>(loadWallets);
  const [showBalance, setShowBalance] = useState(true);
  const [totalFiatBalance, setTotalFiatBalance] = useState('$0.00');

  useEffect(() => {
    saveWallets(wallets);
  }, [wallets]);

  const addWallet = useCallback((wallet: LocalWallet) => {
    setWallets(prev => {
      if (prev.some(w => w.id === wallet.id)) return prev;
      return [...prev, wallet];
    });
  }, []);

  const removeWallet = useCallback((id: string) => {
    setWallets(prev => prev.filter(w => w.id !== id));
  }, []);

  const getWalletCredentials = useCallback((walletId: string) => {
    return getCredentials(walletId);
  }, []);

  const refreshBalances = useCallback(async () => {
    let totalFiat = 0;

    const updated = await Promise.all(
      wallets.map(async wallet => {
        try {
          const creds = getCredentials(wallet.id);
          let balance = 0;

          if (creds) {
            try {
              balance = await getBalanceFromStored(creds);
            } catch {
              balance = wallet.balance;
            }
          }

          const fiat = await api.getFiatRate(wallet.coin);
          const config = COIN_CONFIGS[wallet.coin];
          const amount = balance / config.unitToSatoshi;
          const fiatAmount = amount * fiat.rate;
          totalFiat += fiatAmount;

          return {
            ...wallet,
            balance,
            fiatBalance: `$${fiatAmount.toFixed(2)}`
          };
        } catch {
          return wallet;
        }
      })
    );

    setWallets(updated);
    setTotalFiatBalance(`$${totalFiat.toFixed(2)}`);
  }, [wallets]);

  useEffect(() => {
    if (wallets.length > 0) {
      refreshBalances();
    }
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
        getWalletCredentials
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
    fiatBalance: '$0.00',
    status,
    secret
  };
}
