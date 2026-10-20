import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { CreateWalletRequest, JoinWalletRequest, SupportedCoin, TxHistoryItem } from '@bcpros/abcpay-models';
import { defaultWalletCoinType, isSupportedCoin } from '@bcpros/abcpay-models';
import {
  chainFromCoin,
  copayerIdFromXpub,
  deriveWalletAddress,
  getBalancesForAddress,
  getTokenMetadata,
  getTxHistoryForAddress,
  getUtxosForAddress,
  relativePath,
  type TokenBalance
} from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { addresses, copayerLookup, copayers, wallets } from '../db/schema';
import { config } from '../config';
import { formatWalletId } from '../lib/wallet-id';
import { addressMatchesDerivation } from '../lib/address-validation';
import { notificationService } from './notification.service';

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
    const coinType = req.coinType ?? defaultWalletCoinType(req.coin, req.n > 1);

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
        coinType,
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

    const copayerId = copayerIdFromXpub(wallet.coin as SupportedCoin, req.xPubKey);
    const [existing] = await db.select().from(copayers).where(eq(copayers.copayerId, copayerId)).limit(1);

    if (req.dryRun) {
      return {
        dryRun: true,
        copayerExists: existingCopayers.some(c => c.xPubKey === req.xPubKey) || Boolean(existing)
      };
    }

    if (existingCopayers.length >= wallet.n) {
      throw new Error('Wallet is full');
    }
    if (existingCopayers.some(c => c.xPubKey === req.xPubKey)) {
      throw new Error('Copayer already joined');
    }
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

    notificationService.publish({
      type: 'wallet.joined',
      walletId,
      copayerId,
      copayerName: req.name
    });
    if (status === 'complete') {
      notificationService.publish({
        type: 'wallet.complete',
        walletId,
        status: 'complete'
      });
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
      coinType: wallet.coinType ?? defaultWalletCoinType(wallet.coin as SupportedCoin, wallet.n > 1),
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

  /** Resolve wallet(s) for a copayer using the migrated v1/v2 lookup table. */
  async findWalletsByCopayerId(copayerId: string) {
    const lookups = await db
      .select()
      .from(copayerLookup)
      .where(eq(copayerLookup.copayerId, copayerId));

    const results = [];
    for (const lookup of lookups) {
      const info = await this.getJoinInfo(lookup.walletId);
      if (info) {
        results.push({ ...info, copayerId: lookup.copayerId });
      }
    }

    // Fallback: copayer row present but lookup row missing (partial migrations)
    if (results.length === 0) {
      const copayer = await this.getCopayer(copayerId);
      if (copayer) {
        const info = await this.getJoinInfo(copayer.walletId);
        if (info) results.push({ ...info, copayerId });
      }
    }

    return results;
  }

  async findWalletsByCopayerIds(copayerIds: string[]) {
    const unique = [...new Set(copayerIds.filter(Boolean))];
    const byWallet = new Map<string, Awaited<ReturnType<WalletService['findWalletsByCopayerId']>>[number]>();
    for (const id of unique) {
      for (const wallet of await this.findWalletsByCopayerId(id)) {
        byWallet.set(wallet.id, wallet);
      }
    }
    return [...byWallet.values()];
  }

  /** Prefer xpub match — works even if a client used an older copayerId hash. */
  async findWalletsByXPubKeys(xPubKeys: string[]) {
    const unique = [...new Set(xPubKeys.filter(Boolean))];
    if (unique.length === 0) return [];

    const rows = await db.select().from(copayers).where(inArray(copayers.xPubKey, unique));
    const byWallet = new Map<string, Awaited<ReturnType<WalletService['findWalletsByCopayerId']>>[number]>();
    for (const row of rows) {
      const info = await this.getJoinInfo(row.walletId);
      if (info) byWallet.set(info.id, { ...info, copayerId: row.copayerId });
    }
    return [...byWallet.values()];
  }

  /**
   * Resolve every Account under a Wallet (seed) by its seed id.
   * The seed id is the requestPubKey (m/1'/0), shared by all derivation
   * Accounts of one seed — so a Wallet ID now points to the seed and
   * recovers all of its Accounts, present and future variants alike.
   */
  async findWalletsByRequestPubKeys(requestPubKeys: string[]) {
    const unique = [...new Set(requestPubKeys.filter(Boolean))];
    if (unique.length === 0) return [];

    const rows = await db.select().from(copayers).where(inArray(copayers.requestPubKey, unique));
    const byWallet = new Map<string, Awaited<ReturnType<WalletService['findWalletsByCopayerId']>>[number]>();
    for (const row of rows) {
      const info = await this.getJoinInfo(row.walletId);
      if (info) byWallet.set(info.id, { ...info, copayerId: row.copayerId });
    }
    return [...byWallet.values()];
  }

  async recoverWallets(opts: { copayerIds?: string[]; xPubKeys?: string[]; requestPubKeys?: string[] }) {
    const byWallet = new Map<string, Awaited<ReturnType<WalletService['findWalletsByCopayerId']>>[number]>();
    for (const wallet of await this.findWalletsByCopayerIds(opts.copayerIds ?? [])) {
      byWallet.set(wallet.id, wallet);
    }
    for (const wallet of await this.findWalletsByXPubKeys(opts.xPubKeys ?? [])) {
      byWallet.set(wallet.id, wallet);
    }
    for (const wallet of await this.findWalletsByRequestPubKeys(opts.requestPubKeys ?? [])) {
      byWallet.set(wallet.id, wallet);
    }
    return [...byWallet.values()];
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

    const storedCounter = isChange ? (wallet.changeAddressIndex ?? 0) : (wallet.addressIndex ?? 0);
    const usedIndexes = new Set<number>();
    for (const row of existing) {
      const parsed = Number(row.path.split('/').pop());
      if (Number.isInteger(parsed) && parsed >= 0) usedIndexes.add(parsed);
    }

    let index = Math.max(storedCounter, existing.length);
    while (usedIndexes.has(index)) index++;

    const path = relativePath(isChange, index);
    const derived = deriveWalletAddress({
      coin: wallet.coin as SupportedCoin,
      network: wallet.network as 'livenet' | 'testnet',
      xPubKeys: walletCopayers.map(c => c.xPubKey),
      m: wallet.m,
      n: wallet.n,
      path
    });

    const addr = await this.registerAddress(
      walletId,
      derived.address,
      derived.path,
      derived.publicKeys,
      isChange,
      derived.redeemScript,
      derived.scriptPubKey,
      derived.type
    );

    const nextCounter = Math.max(index + 1, storedCounter);
    await db
      .update(wallets)
      .set({
        ...(isChange ? { changeAddressIndex: nextCounter } : { addressIndex: nextCounter }),
        updatedAt: new Date()
      })
      .where(eq(wallets.walletId, walletId));

    return addr;
  }

  async getMainAddress(walletId: string) {
    await this.ensureHistoricalAddresses(walletId);
    const existing = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.walletId, walletId), eq(addresses.isChange, false)));
    if (existing[0]) return existing[0];
    return this.createAddress(walletId, false);
  }

  /**
   * Migrated v1 wallets store `address_index` / `change_address_index` on `wallets`
   * without pre-populating `addresses`. Materialize `0 .. counter - 1` (and at least
   * `m/0/0`) so restored wallets see their historical v1 funds and do not skip `m/0/0`.
   */
  async ensureHistoricalAddresses(walletId: string) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet || wallet.status !== 'complete') return;

    const existing = await db.select().from(addresses).where(eq(addresses.walletId, walletId));
    const receiveCount = Math.max(1, wallet.addressIndex ?? 0);
    const changeCount = Math.max(0, wallet.changeAddressIndex ?? 0);

    const havePaths = new Set(existing.map(a => a.path));
    const missing: Array<{ isChange: boolean; index: number; path: string }> = [];
    for (let i = 0; i < receiveCount; i++) {
      const path = relativePath(false, i);
      if (!havePaths.has(path)) missing.push({ isChange: false, index: i, path });
    }
    for (let i = 0; i < changeCount; i++) {
      const path = relativePath(true, i);
      if (!havePaths.has(path)) missing.push({ isChange: true, index: i, path });
    }
    if (missing.length === 0) return;

    const ring = (wallet.publicKeyRing as Array<{ xPubKey: string }> | null) ?? [];
    const xPubKeys =
      ring.length >= wallet.n
        ? ring.map(r => r.xPubKey)
        : (await db.select().from(copayers).where(eq(copayers.walletId, walletId))).map(
            c => c.xPubKey
          );
    if (xPubKeys.length < wallet.n) return;

    const haveAddresses = new Set(existing.map(a => a.address));
    const toInsert = [];
    for (const item of missing) {
      const derived = deriveWalletAddress({
        coin: wallet.coin as SupportedCoin,
        network: wallet.network as 'livenet' | 'testnet',
        xPubKeys,
        m: wallet.m,
        n: wallet.n,
        path: item.path
      });
      if (haveAddresses.has(derived.address)) continue;
      haveAddresses.add(derived.address);
      toInsert.push({
        walletId,
        address: derived.address,
        path: derived.path,
        publicKeys: derived.publicKeys,
        coin: wallet.coin,
        network: wallet.network,
        type: derived.type ?? wallet.addressType,
        isChange: item.isChange
      });
    }

    if (toInsert.length > 0) {
      await db.insert(addresses).values(toInsert);
    }
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

    const walletCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));
    const ring = walletCopayers.map(c => c.xPubKey);
    if (ring.length > 0) {
      if (!path) throw new Error('Address path is required');
      const matches = addressMatchesDerivation({
        coin: wallet.coin as SupportedCoin,
        network: wallet.network as 'livenet' | 'testnet',
        xPubKeys: ring,
        m: wallet.m,
        n: wallet.n,
        path,
        address
      });
      if (!matches) throw new Error('Address does not match the wallet derivation');
    }

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
    await this.ensureHistoricalAddresses(walletId);
    return db.select().from(addresses).where(eq(addresses.walletId, walletId));
  }

  /** Chain watcher target: the chain plus every known address of the wallet. */
  async getWatcherTarget(walletId: string) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet) return null;
    await this.ensureHistoricalAddresses(walletId);
    const rows = await db.select().from(addresses).where(eq(addresses.walletId, walletId));
    return {
      chain: chainFromCoin(wallet.coin as SupportedCoin),
      addresses: rows.map(row => row.address)
    };
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
        tokens: [],
        tokenSatoshis: 0,
        byAddress: {}
      };
    }

    const chain = chainFromCoin(walletAddresses[0].coin as SupportedCoin);
    let total = 0;
    let tokenSatoshis = 0;
    const byAddress: Record<string, number> = {};
    const tokens = new Map<string, TokenBalance>();

    // Scan addresses concurrently (bounded) and retry each once: previously
    // a single transient indexer error silently zeroed that address — for a
    // one-address Account that meant a 0 balance and no tokens at all, and
    // sequential scanning of many-address Accounts blocked the whole refresh.
    const ADDRESS_CONCURRENCY = 4;
    for (let start = 0; start < walletAddresses.length; start += ADDRESS_CONCURRENCY) {
      const batch = walletAddresses.slice(start, start + ADDRESS_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async addr => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              return { addr, balances: await getBalancesForAddress(chain, addr.address, chronikCfg()) };
            } catch {
              if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
            }
          }
          return { addr, balances: null };
        })
      );
      for (const { addr, balances } of batchResults) {
        if (!balances) {
          byAddress[addr.address] = 0;
          continue;
        }
        byAddress[addr.address] = balances.spendableSatoshis;
        total += balances.spendableSatoshis;
        tokenSatoshis += balances.tokenSatoshis;
        for (const token of balances.tokens) {
          const existing = tokens.get(token.tokenId);
          if (existing) {
            existing.atoms = (BigInt(existing.atoms) + BigInt(token.atoms)).toString();
            existing.isMintBaton = existing.isMintBaton || token.isMintBaton;
          } else {
            tokens.set(token.tokenId, { ...token });
          }
        }
      }
    }

    const tokenList = await Promise.all(
      [...tokens.values()].map(async token => {
        if (chain !== 'XEC') return token;
        const metadata = await getTokenMetadata(chain, token.tokenId, chronikCfg());
        return {
          ...token,
          protocol: token.protocol ?? metadata.protocol,
          ticker: metadata.ticker,
          name: metadata.name,
          decimals: metadata.decimals
        };
      })
    );

    return {
      totalAmount: total,
      lockedAmount: 0,
      availableAmount: total,
      totalConfirmedAmount: total,
      lockedConfirmedAmount: 0,
      availableConfirmedAmount: total,
      tokens: tokenList,
      tokenSatoshis,
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
    const coin = wallet.coin as SupportedCoin;
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
      coinType: wallet.coinType ?? defaultWalletCoinType(coin, wallet.n > 1),
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
