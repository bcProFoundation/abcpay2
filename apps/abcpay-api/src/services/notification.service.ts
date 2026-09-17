import type { NotificationEvent } from '@bcpros/abcpay-models';

type Subscriber = (event: NotificationEvent) => void;

export class NotificationService {
  private subscribers = new Map<string, Set<Subscriber>>();

  constructor() {
    // Methods may be passed around as callbacks (e.g. the chain watcher's default publisher).
    this.subscribe = this.subscribe.bind(this);
    this.publish = this.publish.bind(this);
    this.subscriberCount = this.subscriberCount.bind(this);
    this.clear = this.clear.bind(this);
  }

  subscribe(walletId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(walletId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(walletId, set);

    return () => {
      const current = this.subscribers.get(walletId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(walletId);
    };
  }

  publish(event: Omit<NotificationEvent, 'at'> & { at?: number }) {
    const full: NotificationEvent = { ...event, at: event.at ?? Date.now() };
    const set = this.subscribers.get(full.walletId);
    if (!set) return;

    for (const subscriber of set) {
      try {
        subscriber(full);
      } catch {
        // A failing subscriber must not affect the others.
      }
    }
  }

  subscriberCount(walletId: string): number {
    return this.subscribers.get(walletId)?.size ?? 0;
  }

  clear() {
    this.subscribers.clear();
  }
}

export const notificationService = new NotificationService();
