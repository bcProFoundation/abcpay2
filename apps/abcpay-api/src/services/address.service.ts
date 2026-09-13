import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { addresses } from '../db/schema';

export class AddressService {
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
