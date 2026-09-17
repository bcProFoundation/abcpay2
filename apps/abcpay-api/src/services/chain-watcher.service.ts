import type { NotificationEvent, SupportedChain } from '@bcpros/abcpay-models';
import {
  coinFromChain,
  openChronikWs,
  scriptPubKeyHexFromAddress,
  getTxScripts,
  type ChainWsMessage,
  type ChronikWsHandle
} from '@bcpros/abcpay-wallet-core';
import { config } from '../config';
import { notificationService } from './notification.service';
import { walletService } from './wallet.service';

export interface WatcherTarget {
  chain: SupportedChain;
  addresses: string[];
}

export interface ChainWatcherDeps {
  resolveWalletTarget: (walletId: string) => Promise<WatcherTarget | null>;
  createWs: (chain: SupportedChain, onMessage: (msg: ChainWsMessage) => void) => ChronikWsHandle;
  getTxScripts: (chain: SupportedChain, txid: string) => Promise<{ inputs: string[]; outputs: string[] }>;
  publish?: (event: Omit<NotificationEvent, 'at'> & { at?: number }) => void;
  log?: (message: string) => void;
}

interface ChainState {
  ws: ChronikWsHandle;
  ready?: Promise<void>;
  addresses: Map<string, Set<string>>;
  scriptIndex: Map<string, Set<string>>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const RETRY_MS = 15000;

const WATCHED_TX_MSG_TYPES = new Set([
  'TX_ADDED_TO_MEMPOOL',
  'TX_REMOVED_FROM_MEMPOOL',
  'TX_CONFIRMED',
  'TX_FINALIZED',
  'TX_INVALIDATED'
]);

export class ChainWatcher {
  private chains = new Map<SupportedChain, ChainState>();
  private wallets = new Map<string, { chain: SupportedChain; addresses: Set<string> }>();
  private refs = new Map<string, number>();

  constructor(private deps: ChainWatcherDeps) {}

  private publish(event: Omit<NotificationEvent, 'at'> & { at?: number }) {
    (this.deps.publish ?? notificationService.publish)(event);
  }

  private log(message: string) {
    this.deps.log?.(message);
  }

  private createChainState(chain: SupportedChain): ChainState {
    const state: ChainState = {
      ws: this.deps.createWs(chain, msg => void this.handleMessage(chain, msg)),
      addresses: new Map(),
      scriptIndex: new Map()
    };
    this.chains.set(chain, state);
    return state;
  }

  private async ensureOpen(chain: SupportedChain, state: ChainState): Promise<void> {
    if (!state.ready) {
      state.ready = state.ws.waitForOpen().catch(err => {
        state.ready = undefined;
        this.log(`chronik ws (${chain}) unavailable: ${(err as Error).message}`);
        this.scheduleRetry(chain, state);
        throw err;
      });
    }
    return state.ready;
  }

  private scheduleRetry(chain: SupportedChain, state: ChainState) {
    if (state.retryTimer) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      if (state.addresses.size === 0) return;
      void this.resubscribe(chain, state);
    }, RETRY_MS);
    state.retryTimer.unref?.();
  }

  private async resubscribe(chain: SupportedChain, state: ChainState) {
    try {
      await this.ensureOpen(chain, state);
      for (const address of state.addresses.keys()) {
        try {
          state.ws.subscribeToAddress(address);
        } catch (err) {
          this.log(`chronik resubscribe failed for ${address}: ${(err as Error).message}`);
        }
      }
    } catch {
      // ensureOpen scheduled the next retry
    }
  }

  private indexAddress(chain: SupportedChain, state: ChainState, address: string, walletId: string) {
    const walletsAtAddress = state.addresses.get(address) ?? new Set<string>();
    walletsAtAddress.add(walletId);
    state.addresses.set(address, walletsAtAddress);

    const scriptHex = scriptPubKeyHexFromAddress(coinFromChain(chain), address).toLowerCase();
    const walletsAtScript = state.scriptIndex.get(scriptHex) ?? new Set<string>();
    walletsAtScript.add(walletId);
    state.scriptIndex.set(scriptHex, walletsAtScript);
  }

  /** Ref-counted: the wallet is chain-watched while at least one SSE client is subscribed. */
  async watchWallet(walletId: string): Promise<{ watched: number; chain?: SupportedChain }> {
    const refs = (this.refs.get(walletId) ?? 0) + 1;
    this.refs.set(walletId, refs);

    const existing = this.wallets.get(walletId);
    if (refs > 1) {
      return { watched: existing?.addresses.size ?? 0, chain: existing?.chain };
    }

    let target: WatcherTarget | null;
    try {
      target = await this.deps.resolveWalletTarget(walletId);
    } catch (err) {
      this.log(`watch target lookup failed for ${walletId}: ${(err as Error).message}`);
      return { watched: 0 };
    }
    if (!target || target.addresses.length === 0) {
      return { watched: 0, chain: target?.chain };
    }

    const state = this.chains.get(target.chain) ?? this.createChainState(target.chain);
    try {
      await this.ensureOpen(target.chain, state);
    } catch {
      return { watched: 0, chain: target.chain };
    }

    const watched = new Set<string>();
    for (const address of target.addresses) {
      try {
        this.indexAddress(target.chain, state, address, walletId);
        state.ws.subscribeToAddress(address);
        watched.add(address);
      } catch (err) {
        this.log(`chronik subscribe failed for ${address}: ${(err as Error).message}`);
      }
    }

    this.wallets.set(walletId, { chain: target.chain, addresses: watched });
    return { watched: watched.size, chain: target.chain };
  }

  async unwatchWallet(walletId: string): Promise<void> {
    const refs = (this.refs.get(walletId) ?? 0) - 1;
    if (refs > 0) {
      this.refs.set(walletId, refs);
      return;
    }
    this.refs.delete(walletId);

    const entry = this.wallets.get(walletId);
    if (!entry) return;
    this.wallets.delete(walletId);

    const state = this.chains.get(entry.chain);
    if (!state) return;

    for (const address of entry.addresses) {
      const walletsAtAddress = state.addresses.get(address);
      walletsAtAddress?.delete(walletId);
      if (walletsAtAddress && walletsAtAddress.size === 0) {
        state.addresses.delete(address);
        try {
          state.ws.unsubscribeFromAddress(address);
        } catch (err) {
          this.log(`chronik unsubscribe failed for ${address}: ${(err as Error).message}`);
        }
      }

      const scriptHex = scriptPubKeyHexFromAddress(coinFromChain(entry.chain), address).toLowerCase();
      const walletsAtScript = state.scriptIndex.get(scriptHex);
      walletsAtScript?.delete(walletId);
      if (walletsAtScript && walletsAtScript.size === 0) state.scriptIndex.delete(scriptHex);
    }

    if (state.addresses.size === 0) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
      try {
        state.ws.close();
      } catch {
        // already closed
      }
      this.chains.delete(entry.chain);
    }
  }

  /** Newly derived addresses (receive/change) are watched right away while the wallet is watched. */
  async addAddress(walletId: string, address: string): Promise<boolean> {
    const entry = this.wallets.get(walletId);
    if (!entry) return false;
    if (entry.addresses.has(address)) return false;

    const state = this.chains.get(entry.chain);
    if (!state) return false;

    try {
      await this.ensureOpen(entry.chain, state);
      this.indexAddress(entry.chain, state, address, walletId);
      state.ws.subscribeToAddress(address);
      entry.addresses.add(address);
      return true;
    } catch (err) {
      this.log(`chronik subscribe failed for new address ${address}: ${(err as Error).message}`);
      return false;
    }
  }

  watchedWalletCount(): number {
    return this.wallets.size;
  }

  watchedAddressCount(chain?: SupportedChain): number {
    if (chain) return this.chains.get(chain)?.addresses.size ?? 0;
    let total = 0;
    for (const state of this.chains.values()) total += state.addresses.size;
    return total;
  }

  private async handleMessage(chain: SupportedChain, msg: ChainWsMessage) {
    if (msg.type !== 'Tx') {
      if (msg.type === 'Error') {
        this.log(`chronik ws error (${chain}): ${msg.error}`);
      }
      return;
    }

    if (!WATCHED_TX_MSG_TYPES.has(msg.msgType)) return;

    const state = this.chains.get(chain);
    if (!state || state.addresses.size === 0) return;

    let scripts: { inputs: string[]; outputs: string[] };
    try {
      scripts = await this.deps.getTxScripts(chain, msg.txid);
    } catch (err) {
      this.log(`tx lookup failed for ${msg.txid}: ${(err as Error).message}`);
      return;
    }

    const touched = new Map<string, 'sent' | 'received'>();
    for (const scriptHex of scripts.inputs) {
      for (const walletId of state.scriptIndex.get(scriptHex) ?? []) touched.set(walletId, 'sent');
    }
    for (const scriptHex of scripts.outputs) {
      for (const walletId of state.scriptIndex.get(scriptHex) ?? []) {
        if (!touched.has(walletId)) touched.set(walletId, 'received');
      }
    }

    for (const [walletId, direction] of touched) {
      this.publish({
        type: 'wallet.activity',
        walletId,
        txid: msg.txid,
        msgType: msg.msgType,
        direction
      });
    }
  }
}

export const chainWatcher = new ChainWatcher({
  resolveWalletTarget: walletId => walletService.getWatcherTarget(walletId),
  createWs: (chain, onMessage) =>
    openChronikWs(chain, config.chronik, {
      onMessage,
      onError: err => console.warn(`[cws] chronik ws error (${chain}):`, err)
    }),
  getTxScripts: (chain, txid) => getTxScripts(chain, txid, config.chronik),
  log: message => console.warn(`[cws] ${message}`)
});
