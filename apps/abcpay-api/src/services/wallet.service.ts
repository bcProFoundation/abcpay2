import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { CreateWalletRequest, JoinWalletRequest, SupportedCoin, TxHistoryItem } from '@bcpros/abcpay-models';
import { isSupportedCoin } from '@bcpros/abcpay-models';
import {
  chainFromCoin,
  deriveWalletAddress,
  getBalanceForAddress,
  getTxHistoryForAddress,
  getUtxosForAddress,
  relativePath
} from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { addresses, copayerLookup, copayers, wallets } from '../db/schema';
import { config } from '../config';
import { formatWalletId, xPubToCopayerId } from '../lib/bws-utils';

function generateWalletId(): string {
  const hex = randomBytes(16).toString('hex');
  return formatWalletId(hex);
}

function chronikCfg() {
  return { xecUrls: config.chronik.xecUrls, dogeUrls: config.chronik.dogeUrls };
}

export class WalletService {
  async createWallet(req: CreateWalletRequest) {
    if (!isSupportedCoin(req.coin)) {
      throw new Error('Unsupported coin');
    }
    if (req.n < 1 || req.m < 1 || req.m > req.n) {
      throw new Error('Invalid m-of-n configuration');
    }

    const walletId = generateWalletId();
    const chain = req.chain ?? chainFromCoin(req.coin);

    const [wallet] = await db
      .insert(wallets)
      .values({
        walletId,
        name: req.name,
        m: req.m,
        n: req.n,
        coin: req.coin,
        chain,
        network: req.network,
        addressType: req.n > 1 ? 'P2SH' : 'P2PKH',
        status: 'pending',
        pubKey: req.pubKey,
        publicKeyRing: [],
        singleAddress: req.singleAddress ?? false,
        nativeCashAddr: req.nativeCashAddr ?? true,
        usePurpose48: req.usePurpose48 ?? req.n > 1
      })
      .returning();

    return { walletId: wallet.walletId, wallet: this.toWalletResponse(wallet, []) };
  }

  async joinWallet(walletId: string, req: JoinWalletRequest) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);

    if (!wallet) throw new Error('Wallet not found');
    if (wallet.coin !== req.coin) throw new Error('Coin mismatch');

    const existingCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));

    if (existingCopayers.length >= wallet.n) {
      throw new Error('Wallet is full');
    }
    if (existingCopayers.some(c => c.xPubKey === req.xPubKey)) {
      throw new Error('Copayer already joined');
    }

    const copayerId = xPubToCopayerId(wallet.coin, req.xPubKey);

    const [existing] = await db.select().from(copayers).where(eq(copayers.copayerId, copayerId)).limit(1);
    if (existing) throw new Error('Copayer already joined');

    await db.insert(copayers).values({
      copayerId,
      walletId,
      name: req.name,
      xPubKey: req.xPubKey,
      requestPubKey: req.requestPubKey,
      signature: req.copayerSignature,
      customData: req.customData
    });

    await db.insert(copayerLookup).values({ copayerId, walletId });

    const updatedCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));

    const publicKeyRing = updatedCopayers.map(c => ({
      xPubKey: c.xPubKey,
      requestPubKey: c.requestPubKey
    }));
    const status = updatedCopayers.length >= wallet.n ? 'complete' : 'pending';

    await db
      .update(wallets)
      .set({ publicKeyRing, status, updatedAt: new Date() })
      .where(eq(wallets.walletId, walletId));

    const [updated] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);

    if (status === 'complete') {
      await this.createAddress(walletId, false);
    }

    return { wallet: this.toWalletResponse(updated, updatedCopayers) };
  }

  async getJoinInfo(walletId: string) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet) return null;
    const walletCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));
    return {
      id: wallet.walletId,
      name: wallet.name,
      coin: wallet.coin,
      m: wallet.m,
      n: wallet.n,
      status: wallet.status,
      copayerCount: walletCopayers.length
    };
  }

  async getWallet(walletId: string) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet) return null;
    const walletCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));
    return this.toWalletResponse(wallet, walletCopayers);
  }

  async getWalletStatus(walletId: string) {
    const wallet = await this.getWallet(walletId);
    if (!wallet) return null;

    return {
      wallet,
      serverMessage: { title: '', body: '' },
      serverMessages: [],
      pendingTxps: [],
      preferences: {},
      walletId
    };
  }

  async getCopayer(copayerId: string) {
    const [row] = await db.select().from(copayers).where(eq(copayers.copayerId, copayerId)).limit(1);
    return row ?? null;
  }

  async createAddress(walletId: string, isChange: boolean) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.status !== 'complete') throw new Error('Wallet is not complete');

    const walletCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));
    const existing = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.walletId, walletId), eq(addresses.isChange, isChange)));

    const index = existing.length;
    const path = relativePath(isChange, index);
    const derived = deriveWalletAddress({
      coin: wallet.coin as SupportedCoin,
      network: wallet.network as 'livenet' | 'testnet',
      xPubKeys: walletCopayers.map(c => c.xPubKey),
      m: wallet.m,
      n: wallet.n,
      path
    });

    return this.registerAddress(
      walletId,
      derived.address,
      derived.path,
      derived.publicKeys,
      isChange,
      derived.redeemScript,
      derived.scriptPubKey,
      derived.type
    );
  }

  async getMainAddress(walletId: string) {
    const existing = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.walletId, walletId), eq(addresses.isChange, false)));
    if (existing[0]) return existing[0];
    return this.createAddress(walletId, false);
  }

  async registerAddress(
    walletId: string,
    address: string,
    path: string,
    publicKeys: string[],
    isChange: boolean,
    redeemScript?: string,
    scriptPubKey?: string,
    type?: string
  ) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet) throw new Error('Wallet not found');

    const [existing] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.walletId, walletId), eq(addresses.address, address)))
      .limit(1);
    if (existing) return existing;

    const [addr] = await db
      .insert(addresses)
      .values({
        walletId,
        address,
        path,
        publicKeys,
        coin: wallet.coin,
        network: wallet.network,
        type: type ?? wallet.addressType,
        isChange
      })
      .returning();

    return { ...addr, redeemScript, scriptPubKey };
  }

  async getWalletAddresses(walletId: string) {
    return db.select().from(addresses).where(eq(addresses.walletId, walletId));
  }

  async getBalance(walletId: string) {
    const walletAddresses = await this.getWalletAddresses(walletId);
    if (walletAddresses.length === 0) {
      return {
        totalAmount: 0,
        lockedAmount: 0,
        availableAmount: 0,
        totalConfirmedAmount: 0,
        lockedConfirmedAmount: 0,
        availableConfirmedAmount: 0,
        byAddress: {}
      };
    }

    const chain = chainFromCoin(walletAddresses[0].coin as SupportedCoin);
    let total = 0;
    const byAddress: Record<string, number> = {};

    for (const addr of walletAddresses) {
      try {
        const balance = await getBalanceForAddress(chain, addr.address, chronikCfg());
        byAddress[addr.address] = balance;
        total += balance;
      } catch {
        byAddress[addr.address] = 0;
      }
    }

    return {
      totalAmount: total,
      lockedAmount: 0,
      availableAmount: total,
      totalConfirmedAmount: total,
      lockedConfirmedAmount: 0,
      availableConfirmedAmount: total,
      byAddress
    };
  }

  async getUtxos(walletId: string) {
    const walletAddresses = await this.getWalletAddresses(walletId);
    if (walletAddresses.length === 0) return [];

    const chain = chainFromCoin(walletAddresses[0].coin as SupportedCoin);
    const allUtxos = [];

    for (const addr of walletAddresses) {
      try {
        const utxos = await getUtxosForAddress(chain, addr.address, chronikCfg());
        for (const utxo of utxos) {
          allUtxos.push({
            ...utxo,
            amount: utxo.satoshis,
            path: addr.path,
            publicKeys: addr.publicKeys as string[],
            locked: false
          });
        }
      } catch {
        // indexer unavailable for this address
      }
    }

    return allUtxos;
  }

  async getHistory(walletId: string): Promise<TxHistoryItem[]> {
    const walletAddresses = await this.getWalletAddresses(walletId);
    if (walletAddresses.length === 0) return [];
    const chain = chainFromCoin(walletAddresses[0].coin as SupportedCoin);
    const items: TxHistoryItem[] = [];
    const seen = new Set<string>();

    for (const addr of walletAddresses) {
      try {
        const history = await getTxHistoryForAddress(chain, addr.address, chronikCfg());
        for (const item of history) {
          if (seen.has(item.txid)) continue;
          seen.add(item.txid);
          items.push(item);
        }
      } catch {
        // ignore
      }
    }

    return items.sort((a, b) => b.time - a.time);
  }

  async getTxHistory(walletId: string) {
    return this.getHistory(walletId);
  }

  toAddressResponse(addr: typeof addresses.$inferSelect, extras?: { redeemScript?: string; scriptPubKey?: string }) {
    return {
      version: '1.0.0',
      createdOn: addr.createdAt.getTime(),
      address: addr.address,
      path: addr.path,
      publicKeys: addr.publicKeys as string[],
      coin: addr.coin,
      network: addr.network,
      type: addr.type,
      isChange: addr.isChange,
      redeemScript: extras?.redeemScript,
      scriptPubKey: extras?.scriptPubKey
    };
  }

  private toWalletResponse(wallet: typeof wallets.$inferSelect, walletCopayers: (typeof copayers.$inferSelect)[]) {
    return {
      id: wallet.walletId,
      name: wallet.name,
      m: wallet.m,
      n: wallet.n,
      version: '1.0.0',
      createdOn: wallet.createdAt.getTime(),
      coin: wallet.coin,
      chain: wallet.chain,
      network: wallet.network,
      addressType: wallet.addressType,
      status: wallet.status,
      publicKeyRing: wallet.publicKeyRing as Array<{ xPubKey: string; requestPubKey: string }>,
      copayers: walletCopayers.map(c => ({
        id: c.copayerId,
        name: c.name,
        xPubKey: c.xPubKey,
        requestPubKey: c.requestPubKey,
        signature: c.signature ?? undefined,
        customData: c.customData ?? undefined
      })),
      singleAddress: wallet.singleAddress ?? false,
      nativeCashAddr: wallet.nativeCashAddr ?? true,
      usePurpose48: wallet.usePurpose48 ?? false
    };
  }
}

export const walletService = new WalletService();
