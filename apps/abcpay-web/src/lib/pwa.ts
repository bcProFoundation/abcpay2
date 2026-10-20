import type { NotificationEvent, SupportedCoin } from '@bcpros/abcpay-models';
import { formatAmount } from '@bcpros/abcpay-wallet-core';

export type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const NOTIFICATIONS_OPT_OUT_KEY = 'abcpay_notifications_disabled_v1';

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(err => {
        console.warn('[pwa] service worker registration failed:', err);
        return null;
      });
  }
  return swRegistrationPromise;
}

export function getNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export function isNotificationsOptedOut(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(NOTIFICATIONS_OPT_OUT_KEY) === '1';
}

export function setNotificationsOptedOut(disabled: boolean): void {
  if (typeof window === 'undefined') return;
  if (disabled) {
    window.localStorage.setItem(NOTIFICATIONS_OPT_OUT_KEY, '1');
  } else {
    window.localStorage.removeItem(NOTIFICATIONS_OPT_OUT_KEY);
  }
}

export async function requestNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      setNotificationsOptedOut(false);
    }
    return result;
  } catch {
    return Notification.permission;
  }
}

export async function showSystemNotification(payload: {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}): Promise<void> {
  if (isNotificationsOptedOut()) return;
  if (getNotificationPermission() !== 'granted') return;

  const reg = await registerServiceWorker();
  if (reg && 'showNotification' in reg) {
    try {
      await reg.showNotification(payload.title, {
        body: payload.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: payload.tag,
        data: { url: payload.url ?? '/' }
      });
      return;
    } catch {
      // Fall back to the Window Notification API below
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      const n = new Notification(payload.title, {
        body: payload.body,
        icon: '/icons/icon-192.png',
        tag: payload.tag
      });
      if (payload.url) {
        n.onclick = () => {
          window.focus();
          window.location.assign(payload.url!);
        };
      }
    } catch {
      // Ignore Notification constructor errors on mobile browsers that require SW
    }
  }
}

export function formatNotificationEvent(
  event: NotificationEvent,
  account?: { id: string; coin: SupportedCoin; label: string }
): { title: string; body: string; url: string; tag: string } | null {
  const label = account?.label ?? 'Account';
  const coin = account?.coin ?? 'xec';
  const url = `/wallet/${event.walletId}`;

  switch (event.type) {
    case 'wallet.activity': {
      // Avoid spamming duplicate notifications for confirmed after mempool; notify on mempool or confirmed if no msgType
      if (event.msgType && event.msgType !== 'TX_ADDED_TO_MEMPOOL') {
        return null;
      }
      const amountText =
        typeof event.amount === 'number' && event.amount > 0
          ? `${formatAmount(coin, event.amount)} ${coin.toUpperCase()}`
          : coin.toUpperCase();
      if (event.direction === 'received') {
        return {
          title: `Received ${amountText}`,
          body: `Incoming payment on ${label}`,
          url,
          tag: `tx-${event.txid ?? event.at}`
        };
      }
      if (event.direction === 'sent') {
        return {
          title: `Sent ${amountText}`,
          body: `Outgoing transaction on ${label}`,
          url,
          tag: `tx-${event.txid ?? event.at}`
        };
      }
      return {
        title: `New transaction on ${label}`,
        body: event.txid ? `TX ${event.txid.slice(0, 12)}…` : 'Wallet activity detected',
        url,
        tag: `tx-${event.txid ?? event.at}`
      };
    }
    case 'proposal.created':
      return {
        title: 'New payment proposal',
        body: `${event.copayerName ?? 'A copayer'} created a proposal on ${label}`,
        url: `/wallet/${event.walletId}/proposals`,
        tag: `proposal-created-${event.proposalId ?? event.at}`
      };
    case 'proposal.signed':
      return {
        title: 'Proposal signed',
        body: `A copayer signed a proposal on ${label}`,
        url: `/wallet/${event.walletId}/proposals`,
        tag: `proposal-signed-${event.proposalId ?? event.at}`
      };
    case 'proposal.rejected':
      return {
        title: 'Proposal rejected',
        body: `A proposal was rejected on ${label}`,
        url: `/wallet/${event.walletId}/proposals`,
        tag: `proposal-rejected-${event.proposalId ?? event.at}`
      };
    case 'proposal.broadcast':
      return {
        title: 'Transaction broadcast',
        body: `Proposal broadcast on ${label}`,
        url,
        tag: `proposal-broadcast-${event.proposalId ?? event.txid ?? event.at}`
      };
    case 'wallet.complete':
      return {
        title: 'Multisig Account ready',
        body: `All copayers have joined ${label}`,
        url,
        tag: `wallet-complete-${event.walletId}`
      };
    case 'wallet.joined':
      return {
        title: 'Copayer joined',
        body: `${event.copayerName ?? 'A copayer'} joined ${label}`,
        url,
        tag: `wallet-joined-${event.walletId}-${event.copayerId ?? event.at}`
      };
    default:
      return null;
  }
}
