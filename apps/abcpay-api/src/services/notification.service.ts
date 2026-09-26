import type { EnvelopeNotificationEvent, NotificationEvent } from '@bcpros/abcpay-models';

type Subscriber = (event: NotificationEvent) => void;
type EnvelopeSubscriber = (event: EnvelopeNotificationEvent) => void;

export class NotificationService {
  private subscribers = new Map<string, Set<Subscriber>>();
  private identitySubscribers = new Map<string, Set<EnvelopeSubscriber>>();

  constructor() {
    // Methods may be passed around as callbacks (e.g. the chain watcher's default publisher).
    this.subscribe = this.subscribe.bind(this);
    this.publish = this.publish.bind(this);
    this.subscribeIdentity = this.subscribeIdentity.bind(this);
    this.publishEnvelope = this.publishEnvelope.bind(this);
    this.identitySubscriberCount = this.identitySubscriberCount.bind(this);
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

  subscribeIdentity(identity: string, subscriber: EnvelopeSubscriber): () => void {
    const set = this.identitySubscribers.get(identity) ?? new Set<EnvelopeSubscriber>();
    set.add(subscriber);
    this.identitySubscribers.set(identity, set);

    return () => {
      const current = this.identitySubscribers.get(identity);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.identitySubscribers.delete(identity);
    };
  }

  publishEnvelope(
    event: Omit<EnvelopeNotificationEvent, 'at'> & { at?: number }
  ): void {
    const full: EnvelopeNotificationEvent = { ...event, at: event.at ?? Date.now() };
    const set = this.identitySubscribers.get(full.identity);
    if (!set) return;
    for (const subscriber of set) {
      try {
        subscriber(full);
      } catch {
        // A failing subscriber must not affect the others.
      }
    }
  }

  identitySubscriberCount(identity: string): number {
    return this.identitySubscribers.get(identity)?.size ?? 0;
  }

  clear() {
    this.subscribers.clear();
    this.identitySubscribers.clear();
  }
}

export const notificationService = new NotificationService();
