import { describe, expect, it, vi } from 'vitest';
import { scriptPubKeyHexFromAddress, type ChainWsMessage, type ChronikWsHandle } from '@bcpros/abcpay-wallet-core';
import type { NotificationEvent } from '@bcpros/abcpay-models';
import { ChainWatcher } from '../chain-watcher.service';
import { notificationService } from '../notification.service';

const ADDRESS_A = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang';
const ADDRESS_B = 'ecash:qrtmy72hp7ks80xalvlt8jxczd6l3wr5zga5vct0s4';
const SCRIPT_A = scriptPubKeyHexFromAddress('xec', ADDRESS_A).toLowerCase();
const SCRIPT_B = scriptPubKeyHexFromAddress('xec', ADDRESS_B).toLowerCase();

class FakeWs implements ChronikWsHandle {
  subscribed = new Set<string>();
  opened = false;
  closed = false;

  constructor(private failOpen = false) {}

  async waitForOpen() {
    if (this.failOpen) throw new Error('connect failed');
    this.opened = true;
  }

  subscribeToAddress(address: string) {
    if (!this.opened) throw new Error('ws not open');
    this.subscribed.add(address);
  }

  unsubscribeFromAddress(address: string) {
    if (!this.subscribed.delete(address)) throw new Error(`No existing sub at ${address}`);
  }

  close() {
    this.closed = true;
    this.opened = false;
  }
}

function txMessage(txid: string, msgType = 'TX_ADDED_TO_MEMPOOL'): ChainWsMessage {
  return { type: 'Tx', msgType, txid };
}

function setup(options: { failOpen?: boolean; defaultPublish?: boolean } = {}) {
  const ws = new FakeWs(options.failOpen);
  const published: NotificationEvent[] = [];
  const targets: Record<string, { chain: 'XEC' | 'DOGE'; addresses: string[] } | null> = {
    'wallet-a': { chain: 'XEC', addresses: [ADDRESS_A] },
    'wallet-b': { chain: 'XEC', addresses: [ADDRESS_B] }
  };
  const scriptsByTx = new Map<string, { inputs: string[]; outputs: string[] }>();

  let onMessage: ((msg: ChainWsMessage) => void) | undefined;
  const watcher = new ChainWatcher({
    resolveWalletTarget: async walletId => targets[walletId] ?? null,
    createWs: (_chain, handler) => {
      onMessage = handler;
      return ws;
    },
    getTxScripts: async (_chain, txid) => scriptsByTx.get(txid) ?? { inputs: [], outputs: [] },
    ...(options.defaultPublish
      ? {}
      : { publish: (event: Omit<NotificationEvent, 'at'> & { at?: number }) => published.push({ ...event, at: event.at ?? Date.now() }) }),
    log: () => {}
  });

  return {
    watcher,
    ws,
    published,
    scriptsByTx,
    targets,
    emit: (msg: ChainWsMessage) => onMessage?.(msg)
  };
}

describe('ChainWatcher', () => {
  it('subscribes every wallet address once the ws is open', async () => {
    const { watcher, ws } = setup();

    const result = await watcher.watchWallet('wallet-a');

    expect(result).toEqual({ watched: 1, chain: 'XEC' });
    expect([...ws.subscribed]).toEqual([ADDRESS_A]);
  });

  it('ref-counts connections per wallet and closes the ws when idle', async () => {
    const { watcher, ws } = setup();

    await watcher.watchWallet('wallet-a');
    await watcher.watchWallet('wallet-a');
    expect(ws.subscribed.size).toBe(1);

    await watcher.unwatchWallet('wallet-a');
    expect(ws.subscribed.size).toBe(1);
    expect(ws.closed).toBe(false);

    await watcher.unwatchWallet('wallet-a');
    expect(ws.subscribed.size).toBe(0);
    expect(ws.closed).toBe(true);
    expect(watcher.watchedWalletCount()).toBe(0);
  });

  it('resolves incoming and outgoing activity per wallet from tx scripts', async () => {
    const { watcher, emit, published, scriptsByTx } = setup();
    await watcher.watchWallet('wallet-a');
    await watcher.watchWallet('wallet-b');

    scriptsByTx.set('tx-received', { inputs: ['ff'.repeat(10)], outputs: [SCRIPT_A] });
    emit(txMessage('tx-received'));
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      type: 'wallet.activity',
      walletId: 'wallet-a',
      txid: 'tx-received',
      direction: 'received',
      msgType: 'TX_ADDED_TO_MEMPOOL'
    });

    scriptsByTx.set('tx-self-spend', { inputs: [SCRIPT_A], outputs: [SCRIPT_B] });
    emit(txMessage('tx-self-spend', 'TX_CONFIRMED'));
    await vi.waitFor(() => expect(published).toHaveLength(3));
    expect(published[1]).toMatchObject({ walletId: 'wallet-a', direction: 'sent', msgType: 'TX_CONFIRMED' });
    expect(published[2]).toMatchObject({ walletId: 'wallet-b', direction: 'received' });
  });

  it('ignores txs that touch no watched script', async () => {
    const { watcher, emit, published, scriptsByTx } = setup();
    await watcher.watchWallet('wallet-a');

    scriptsByTx.set('tx-unrelated', { inputs: ['ab'.repeat(10)], outputs: ['cd'.repeat(10)] });
    emit(txMessage('tx-unrelated'));

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(published).toHaveLength(0);
  });

  it('watches newly derived addresses only while the wallet is watched', async () => {
    const { watcher, ws } = setup();

    expect(await watcher.addAddress('wallet-a', ADDRESS_B)).toBe(false);

    await watcher.watchWallet('wallet-a');
    expect(await watcher.addAddress('wallet-a', ADDRESS_B)).toBe(true);
    expect(await watcher.addAddress('wallet-a', ADDRESS_B)).toBe(false);
    expect(ws.subscribed.has(ADDRESS_B)).toBe(true);
  });

  it('degrades gracefully when the ws cannot open', async () => {
    const { watcher } = setup({ failOpen: true });

    const result = await watcher.watchWallet('wallet-a');

    expect(result.watched).toBe(0);
    expect(watcher.watchedWalletCount()).toBe(0);
  });

  it('publishes through the shared notification service by default', async () => {
    const { watcher, emit, scriptsByTx } = setup({ defaultPublish: true });
    const received: NotificationEvent[] = [];
    const unsubscribe = notificationService.subscribe('wallet-a', event => received.push(event));

    await watcher.watchWallet('wallet-a');
    scriptsByTx.set('tx-default-publish', { inputs: ['ff'.repeat(10)], outputs: [SCRIPT_A] });
    emit(txMessage('tx-default-publish'));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ type: 'wallet.activity', walletId: 'wallet-a', direction: 'received' });

    unsubscribe();
  });

  it('returns zero for unknown wallets', async () => {
    const { watcher } = setup();
    expect(await watcher.watchWallet('missing')).toEqual({ watched: 0, chain: undefined });
  });
});
