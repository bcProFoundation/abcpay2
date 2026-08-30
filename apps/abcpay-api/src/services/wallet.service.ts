import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { CreateWalletRequest, JoinWalletRequest, SupportedCoin } from '@bcpros/abcpay-models';
import { isSupportedCoin } from '@bcpros/abcpay-models';
import { chainFromCoin, getBalanceForAddress, getUtxosForAddress, getTxHistoryForAddress } from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { addresses, copayerLookup, copayers, wallets } from '../db/schema';
import { config } from '../config';
import { formatWalletId, xPubToCopayerId } from '../lib/bws-utils';

function generateWalletId(): string {
  const hex = randomBytes(16).toString('hex');
  return formatWalletId(hex);
}

export class WalletService {
  async createWallet(req: CreateWalletRequest) {
    if (!isSupportedCoin(req.coin)) {
      throw new Error('Unsupported coin');
    }

    if (req.n > 1 && req.m > req.n) {
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
        addressType: req.addressType,
        status: req.n === 1 ? 'complete' : 'pending',
        pubKey: req.pubKey,
        publicKeyRing: [],
        singleAddress: req.singleAddress ?? false,
        nativeCashAddr: req.nativeCashAddr ?? true,
        usePurpose48: req.usePurpose48 ?? req.n > 1
      })
      .returning();

    // BWC expects { walletId } from POST /v2/wallets/
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

    // BWC expects { wallet: {...} }
    return { wallet: this.toWalletResponse(updated, updatedCopayers) };
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

  async registerAddress(
    walletId: string,
    address: string,
    path: string,
    publicKeys: string[],
    isChange: boolean
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
        type: wallet.addressType,
        isChange
      })
      .returning();

    return addr;
  }

  async getWalletAddresses(walletId: string) {
    return db.select().from(addresses).where(eq(addresses.walletId, walletId));
  }

  async getBalance(walletId: string) {
    const walletAddresses = await this.getWalletAddresses(walletId);
    const chain = chainFromCoin(walletAddresses[0]?.coin as SupportedCoin ?? 'xec');

    let total = 0;
    const byAddress: Record<string, number> = {};

    for (const addr of walletAddresses) {
      const balance = await getBalanceForAddress(chain, addr.address, {
        xecUrls: config.chronik.xecUrls,
        dogeUrls: config.chronik.dogeUrls
      });
      byAddress[addr.address] = balance;
      total += balance;
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
      const utxos = await getUtxosForAddress(chain, addr.address, {
        xecUrls: config.chronik.xecUrls,
        dogeUrls: config.chronik.dogeUrls
      });

      for (const utxo of utxos) {
        allUtxos.push({
          ...utxo,
          vout: utxo.vout,
          amount: utxo.satoshis,
          path: addr.path,
          locked: false
        });
      }
    }

    return allUtxos;
  }

  async getTxHistory(walletId: string) {
    const walletAddresses = await this.getWalletAddresses(walletId);
    if (walletAddresses.length === 0) return [];

    const chain = chainFromCoin(walletAddresses[0].coin as SupportedCoin);
    const allTxs = [];

    for (const addr of walletAddresses) {
      const history = await getTxHistoryForAddress(chain, addr.address, {
        xecUrls: config.chronik.xecUrls,
        dogeUrls: config.chronik.dogeUrls
      });

      for (const tx of history) {
        allTxs.push({
          txid: tx.txid,
          action: 'moved',
          amount: tx.amount,
          fees: tx.fees,
          time: tx.time,
          confirmations: tx.confirmations,
          blockheight: tx.blockheight,
          address: addr.address,
          createdOn: tx.time
        });
      }
    }

    return allTxs.sort((a, b) => b.time - a.time);
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
