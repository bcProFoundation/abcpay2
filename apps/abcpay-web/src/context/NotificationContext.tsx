import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NotificationEvent } from '@bcpros/abcpay-models';
import { useWallets } from './WalletContext';
import { subscribeToWalletNotifications, type NotificationConnectionState } from '../lib/events';

interface NotificationContextValue {
  stateFor: (walletId: string) => NotificationConnectionState;
  subscribe: (walletId: string, handler: (event: NotificationEvent) => void) => () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const BALANCE_REFRESH_DEBOUNCE_MS = 1500;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { wallets, authFor, refreshBalances } = useWallets();
  const [states, setStates] = useState<Record<string, NotificationConnectionState>>({});
  const handlersRef = useRef(new Map<string, Set<(event: NotificationEvent) => void>>());
  const closersRef = useRef(new Map<string, () => void>());
  const refreshTimerRef = useRef<number | undefined>(undefined);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      void refreshBalances();
    }, BALANCE_REFRESH_DEBOUNCE_MS);
  }, [refreshBalances]);

  const subscribe = useCallback((walletId: string, handler: (event: NotificationEvent) => void) => {
    const handlers = handlersRef.current.get(walletId) ?? new Set<(event: NotificationEvent) => void>();
    handlers.add(handler);
    handlersRef.current.set(walletId, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) handlersRef.current.delete(walletId);
    };
  }, []);

  const stateFor = useCallback(
    (walletId: string): NotificationConnectionState => states[walletId] ?? 'offline',
    [states]
  );

  const walletKey = wallets.map(wallet => wallet.id).join(',');

  useEffect(() => {
    const activeIds = new Set(wallets.map(wallet => wallet.id));

    for (const [walletId, close] of closersRef.current) {
      if (!activeIds.has(walletId)) {
        close();
        closersRef.current.delete(walletId);
      }
    }

    for (const wallet of wallets) {
      if (closersRef.current.has(wallet.id)) continue;
      const auth = authFor(wallet.id);
      if (!auth) continue;

      const close = subscribeToWalletNotifications(auth, {
        onEvent: event => {
          for (const handler of handlersRef.current.get(wallet.id) ?? []) {
            handler(event);
          }
          scheduleRefresh();
        },
        onState: state => {
          setStates(previous => (previous[wallet.id] === state ? previous : { ...previous, [wallet.id]: state }));
        }
      });
      closersRef.current.set(wallet.id, close);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletKey, scheduleRefresh]);

  useEffect(
    () => () => {
      window.clearTimeout(refreshTimerRef.current);
      for (const close of closersRef.current.values()) close();
      closersRef.current.clear();
    },
    []
  );

  const value = useMemo(() => ({ stateFor, subscribe }), [stateFor, subscribe]);

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
