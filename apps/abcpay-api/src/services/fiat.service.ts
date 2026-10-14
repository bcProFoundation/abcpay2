import { eq, and, gt } from 'drizzle-orm';
import type { SupportedCoin } from '@bcpros/abcpay-models';
import { db } from '../db';
import { fiatRates } from '../db/schema';

const COINGECKO_IDS: Record<SupportedCoin, string> = {
  xec: 'ecash',
  doge: 'dogecoin'
};

const CACHE_TTL_MS = 5 * 60 * 1000;

export class FiatService {
  async getRate(coin: SupportedCoin, code = 'usd'): Promise<{ rate: number; fetchedOn: number }> {
    const cached = await db
      .select()
      .from(fiatRates)
      .where(
        and(
          eq(fiatRates.coin, coin),
          eq(fiatRates.code, code),
          gt(fiatRates.fetchedAt, new Date(Date.now() - CACHE_TTL_MS))
        )
      )
      .limit(1);

    if (cached.length > 0) {
      return {
        rate: parseFloat(cached[0].rate),
        fetchedOn: cached[0].fetchedAt.getTime()
      };
    }

    const geckoId = COINGECKO_IDS[coin];
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=${code}`
    );

    if (!res.ok) {
      const fallback: Record<SupportedCoin, number> = { xec: 0.00004, doge: 0.35 };
      return { rate: fallback[coin], fetchedOn: Date.now() };
    }

    const data = (await res.json()) as Record<string, Record<string, number>>;
    const rate = data[geckoId]?.[code] ?? 0;

    await db.insert(fiatRates).values({
      coin,
      code,
      rate: rate.toString()
    });

    return { rate, fetchedOn: Date.now() };
  }
}

export const fiatService = new FiatService();
