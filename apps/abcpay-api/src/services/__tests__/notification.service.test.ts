import { describe, expect, it, vi } from 'vitest';
import { NotificationService, notificationService } from '../notification.service';

function baseEvent(walletId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'proposal.created' as const,
    walletId,
    proposalId: 'p1',
    ...extra
  };
}

describe('NotificationService', () => {
  it('delivers events to subscribers of the matching wallet only', () => {
    const service = new NotificationService();
    const a = vi.fn();
    const b = vi.fn();

    service.subscribe('wallet-a', a);
    service.subscribe('wallet-b', b);
    service.publish(baseEvent('wallet-a'));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(a.mock.calls[0][0]).toMatchObject({ walletId: 'wallet-a', proposalId: 'p1' });
  });

  it('stamps the event with a timestamp', () => {
    const service = new NotificationService();
    const received: Array<{ at: number }> = [];
    service.subscribe('wallet-a', event => received.push(event));

    const before = Date.now();
    service.publish({ type: 'wallet.joined', walletId: 'wallet-a' });
    const after = Date.now();

    expect(received).toHaveLength(1);
    expect(received[0].at).toBeGreaterThanOrEqual(before);
    expect(received[0].at).toBeLessThanOrEqual(after);
  });

  it('stops delivering after unsubscribe', () => {
    const service = new NotificationService();
    const handler = vi.fn();
    const unsubscribe = service.subscribe('wallet-a', handler);

    service.publish(baseEvent('wallet-a'));
    unsubscribe();
    service.publish(baseEvent('wallet-a'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(service.subscriberCount('wallet-a')).toBe(0);
  });

  it('keeps delivering when one subscriber throws', () => {
    const service = new NotificationService();
    const healthy = vi.fn();
    service.subscribe('wallet-a', () => {
      throw new Error('boom');
    });
    service.subscribe('wallet-a', healthy);

    expect(() => service.publish(baseEvent('wallet-a'))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('tracks subscriber counts per wallet', () => {
    const service = new NotificationService();
    service.subscribe('wallet-a', () => {});
    service.subscribe('wallet-a', () => {});
    service.subscribe('wallet-b', () => {});

    expect(service.subscriberCount('wallet-a')).toBe(2);
    expect(service.subscriberCount('wallet-b')).toBe(1);

    service.clear();
    expect(service.subscriberCount('wallet-a')).toBe(0);
  });

  it('exposes a shared singleton', () => {
    expect(notificationService).toBeInstanceOf(NotificationService);
  });

  it('keeps singleton methods bound when passed as callbacks', () => {
    const received: Array<{ walletId: string }> = [];
    const unsubscribe = notificationService.subscribe('wallet-detached', event => received.push(event));

    const { publish } = notificationService;
    expect(() => publish({ type: 'wallet.activity', walletId: 'wallet-detached', txid: 'ab'.repeat(32) })).not.toThrow();
    expect(received).toHaveLength(1);

    unsubscribe();
  });
});
