import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { addresses, wallets } from '../db/schema';
import { deriveAddressFromRing } from '../lib/bws-utils';

export class AddressService {
  async createAddress(walletId: string, isChange = false) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.status !== 'complete') throw new Error('Wallet is not complete');

    const publicKeyRing = wallet.publicKeyRing as Array<{ xPubKey: string; requestPubKey: string }>;
    if (publicKeyRing.length === 0) throw new Error('Wallet has no copayers');

    const field = isChange ? 'changeAddressIndex' : 'addressIndex';
    const currentIndex = isChange ? (wallet.changeAddressIndex ?? 0) : wallet.addressIndex;

    const purpose = wallet.usePurpose48 ? 48 : 44;
    const coinType = wallet.coin === 'xec' ? 1899 : 3;
    const path = `m/${purpose}'/${coinType}'/0'/${isChange ? 1 : 0}/${currentIndex}`;

    const derived = deriveAddressFromRing({
      scriptType: wallet.addressType,
      publicKeyRing,
      path,
      m: wallet.m,
      network: wallet.network,
      chain: wallet.coin
    });

    const [existing] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.walletId, walletId), eq(addresses.address, derived.address)))
      .limit(1);

    if (!existing) {
      await db.insert(addresses).values({
        walletId,
        address: derived.address,
        path,
        publicKeys: derived.publicKeys,
        coin: wallet.coin,
        network: wallet.network,
        type: wallet.addressType,
        isChange
      });
    }

    const updateField = isChange
      ? { changeAddressIndex: currentIndex + 1 }
      : { addressIndex: currentIndex + 1 };

    await db.update(wallets).set({ ...updateField, updatedAt: new Date() }).where(eq(wallets.walletId, walletId));

    return {
      version: '1.0.0',
      createdOn: Date.now(),
      address: derived.address,
      path,
      publicKeys: derived.publicKeys,
      coin: wallet.coin,
      network: wallet.network,
      type: wallet.addressType,
      isChange
    };
  }

  async getMainAddresses(walletId: string, limit?: number) {
    let query = db
      .select()
      .from(addresses)
      .where(and(eq(addresses.walletId, walletId), eq(addresses.isChange, false)))
      .orderBy(desc(addresses.createdAt));

    const rows = await query;
    const limited = limit ? rows.slice(0, limit) : rows;

    return limited.map(addr => ({
      version: '1.0.0',
      createdOn: addr.createdAt.getTime(),
      address: addr.address,
      path: addr.path,
      publicKeys: addr.publicKeys as string[],
      coin: addr.coin,
      network: addr.network,
      type: addr.type,
      isChange: addr.isChange
    }));
  }
}

export const addressService = new AddressService();
