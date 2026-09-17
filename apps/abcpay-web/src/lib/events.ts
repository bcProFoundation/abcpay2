import type { NotificationEvent } from '@bcpros/abcpay-models';
import { NOTIFICATION_PATH } from '@bcpros/abcpay-models';
import { signRequest } from '@bcpros/abcpay-wallet-core';
import { API_URL, type AuthContext } from './api';

export type NotificationConnectionState = 'connecting' | 'connected' | 'offline';

interface SubscriptionHandlers {
  onEvent: (event: NotificationEvent) => void;
  onState?: (state: NotificationConnectionState) => void;
}

const MAX_BACKOFF_MS = 15000;
const STALE_STREAM_MS = 45000;

export function subscribeToWalletNotifications(auth: AuthContext, handlers: SubscriptionHandlers): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retryTimer: number | undefined;
  let watchdogTimer: number | undefined;
  let attempt = 0;

  const clearTimers = () => {
    window.clearTimeout(retryTimer);
    window.clearTimeout(watchdogTimer);
  };

  async function connect() {
    if (stopped) return;
    controller = new AbortController();

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'x-wallet-id': auth.walletId,
      'x-identity': auth.copayerId,
      'x-copayer-id': auth.copayerId,
      'x-signature': signRequest(auth.requestPrivKey, 'GET', NOTIFICATION_PATH, '{}')
    };

    try {
      handlers.onState?.('connecting');
      const res = await fetch(`${API_URL}${NOTIFICATION_PATH}`, { headers, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`notifications status ${res.status}`);

      handlers.onState?.('connected');
      attempt = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const bumpWatchdog = () => {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = window.setTimeout(() => controller?.abort(), STALE_STREAM_MS);
      };
      bumpWatchdog();

      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        bumpWatchdog();
        buffer += decoder.decode(value, { stream: true });

        let separator: number;
        while ((separator = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);

          let eventName = 'message';
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
          if (eventName === 'ready' || dataLines.length === 0) continue;

          try {
            const payload = JSON.parse(dataLines.join('\n')) as NotificationEvent;
            handlers.onEvent({ ...payload, type: eventName as NotificationEvent['type'] });
          } catch {
            // ignore malformed frames
          }
        }
      }
    } catch {
      // network error, abort, or a closed stream
    }

    clearTimers();
    if (stopped) return;

    handlers.onState?.('offline');
    attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 4));
    retryTimer = window.setTimeout(() => void connect(), delay);
  }

  void connect();

  return () => {
    stopped = true;
    clearTimers();
    controller?.abort();
  };
}
