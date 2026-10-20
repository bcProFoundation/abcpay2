import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationEvent } from '@bcpros/abcpay-models';
import { useWallets, labelForAccount } from './WalletContext';
import { subscribeToWalletNotifications, type NotificationConnectionState } from '../lib/events';
import { api } from '../lib/api';
import {
  formatNotificationEvent,
  getNotificationPermission,
  isNotificationsOptedOut,
  registerServiceWorker,
  requestNotificationPermission,
  setNotificationsOptedOut,
  showSystemNotification,
  type BeforeInstallPromptEvent,
  type BrowserNotificationPermission
} from '../lib/pwa';

interface NotificationContextValue {
  stateFor: (walletId: string) => NotificationConnectionState;
  subscribe: (walletId: string, handler: (event: NotificationEvent) => void) => () => void;
  permission: BrowserNotificationPermission;
  notificationsEnabled: boolean;
  serviceWorkerReady: boolean;
  pushRegisteredCount: number;
  enableNotifications: () => Promise<BrowserNotificationPermission>;
  disableNotifications: () => Promise<void>;
  canInstallPwa: boolean;
  isStandalone: boolean;
  promptInstallPwa: () => Promise<boolean>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const BALANCE_REFRESH_DEBOUNCE_MS = 1500;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { wallets, authFor, refreshBalances } = useWallets();
  const navigate = useNavigate();
  const [states, setStates] = useState<Record<string, NotificationConnectionState>>({});
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() =>
    getNotificationPermission()
  );
  const [optedOut, setOptedOut] = useState<boolean>(() => isNotificationsOptedOut());
  const [serviceWorkerReady, setServiceWorkerReady] = useState(false);
  const [pushRegisteredIds, setPushRegisteredIds] = useState<Set<string>>(() => new Set());
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(
    null
  );
  const [isStandalone, setIsStandalone] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      Boolean((window.navigator as { standalone?: boolean }).standalone)
    );
  });

  const handlersRef = useRef(new Map<string, Set<(event: NotificationEvent) => void>>());
  const closersRef = useRef(new Map<string, () => void>());
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const refreshBalancesRef = useRef(refreshBalances);
  refreshBalancesRef.current = refreshBalances;
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      // Read through the ref: connections outlive wallet-list changes.
      void refreshBalancesRef.current();
    }, BALANCE_REFRESH_DEBOUNCE_MS);
  }, []);

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

  // Register Service Worker & listen for notification click navigation + PWA install events
  useEffect(() => {
    let mounted = true;
    void registerServiceWorker().then(reg => {
      if (mounted && reg) setServiceWorkerReady(true);
    });

    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | undefined;
      if (data?.type === 'ABCPAY_NAVIGATE' && data.url) {
        navigate(data.url);
      }
    };
    navigator.serviceWorker?.addEventListener?.('message', onSwMessage);

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstallPromptEvent(null);
      setIsStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      mounted = false;
      navigator.serviceWorker?.removeEventListener?.('message', onSwMessage);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [navigate]);

  const registerBackendPushForWallets = useCallback(async () => {
    const reg = await registerServiceWorker();
    let pushSubJson: PushSubscriptionJSON | undefined;
    if (reg?.pushManager?.getSubscription) {
      try {
        const sub = await reg.pushManager.getSubscription();
        pushSubJson = sub?.toJSON();
      } catch {
        // Ignore if pushManager is unavailable
      }
    }

    const registered = new Set<string>();
    await Promise.all(
      walletsRef.current.map(async wallet => {
        const auth = authFor(wallet.id);
        if (!auth) return;
        const token = pushSubJson?.endpoint ?? `web:${auth.copayerId}`;
        try {
          await api.pushNotificationsSubscribe(auth, {
            token,
            platform: 'web',
            packageName: 'cash.abcpay.v2',
            subscription: pushSubJson
          });
          registered.add(wallet.id);
        } catch {
          // Non-fatal if offline or server unreachable
        }
      })
    );
    setPushRegisteredIds(registered);
  }, [authFor]);

  const walletKey = wallets.map(wallet => wallet.id).join(',');

  // Auto-prompt notification permission once the user has at least one Account (if still 'default' and not opted out)
  useEffect(() => {
    if (wallets.length === 0 || optedOut) return;
    const currentPerm = getNotificationPermission();
    setPermission(currentPerm);
    if (currentPerm === 'granted') {
      void registerBackendPushForWallets();
    } else if (currentPerm === 'default') {
      // Request permission when accounts are loaded (or on first user interaction if blocked without gesture)
      void requestNotificationPermission().then(res => {
        setPermission(res);
        if (res === 'granted') {
          void registerBackendPushForWallets();
        }
      });
    }
  }, [walletKey, wallets.length, optedOut, registerBackendPushForWallets]);

  const enableNotifications = useCallback(async () => {
    setNotificationsOptedOut(false);
    setOptedOut(false);
    const res = await requestNotificationPermission();
    setPermission(res);
    if (res === 'granted') {
      await registerBackendPushForWallets();
    }
    return res;
  }, [registerBackendPushForWallets]);

  const disableNotifications = useCallback(async () => {
    setNotificationsOptedOut(true);
    setOptedOut(true);
    await Promise.all(
      walletsRef.current.map(async wallet => {
        const auth = authFor(wallet.id);
        if (!auth) return;
        try {
          await api.pushNotificationsUnsubscribe(auth, `web:${auth.copayerId}`);
        } catch {
          // Ignore errors
        }
      })
    );
    setPushRegisteredIds(new Set());
  }, [authFor]);

  const promptInstallPwa = useCallback(async () => {
    if (!installPromptEvent) return false;
    try {
      await installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPromptEvent(null);
        return true;
      }
    } catch {
      // Ignore prompt errors
    }
    return false;
  }, [installPromptEvent]);

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

          const currentAccount = walletsRef.current.find(w => w.id === wallet.id);
          const formatted = formatNotificationEvent(
            event,
            currentAccount
              ? {
                  id: currentAccount.id,
                  coin: currentAccount.coin,
                  label: labelForAccount(currentAccount)
                }
              : undefined
          );
          if (formatted) {
            void showSystemNotification(formatted);
          }
        },
        onState: state => {
          setStates(previous => {
            const prior = previous[wallet.id];
            // Catch anything missed while the stream was down — no interval polling.
            if (state === 'connected' && prior && prior !== 'connected') {
              scheduleRefresh();
            }
            return prior === state ? previous : { ...previous, [wallet.id]: state };
          });
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

  const notificationsEnabled = permission === 'granted' && !optedOut;

  const value = useMemo(
    () => ({
      stateFor,
      subscribe,
      permission,
      notificationsEnabled,
      serviceWorkerReady,
      pushRegisteredCount: pushRegisteredIds.size,
      enableNotifications,
      disableNotifications,
      canInstallPwa: Boolean(installPromptEvent) && !isStandalone,
      isStandalone,
      promptInstallPwa
    }),
    [
      stateFor,
      subscribe,
      permission,
      notificationsEnabled,
      serviceWorkerReady,
      pushRegisteredIds.size,
      enableNotifications,
      disableNotifications,
      installPromptEvent,
      isStandalone,
      promptInstallPwa
    ]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
