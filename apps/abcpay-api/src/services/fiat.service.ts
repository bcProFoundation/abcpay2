import type { SupportedCoin } from '@bcpros/abcpay-models';

const COINGECKO_IDS: Record<SupportedCoin, string> = {
  xec: 'ecash',
  doge: 'dogecoin'
};

const FALLBACK: Record<SupportedCoin, number> = {
  xec: 0.00002,
  doge: 0.15
};

let cache: { at: number; rates: Record<string, number> } | null = null;

export async function getFiatRate(code: string): Promise<{ rate: number; fetchedOn: number }> {
  const coin = code.toLowerCase() as SupportedCoin;
  const now = Date.now();
  if (cache && now - cache.at < 60_000) {
    return { rate: cache.rates[coin] ?? 0, fetchedOn: cache.at };
  }

  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { headers: { accept: 'application/json' } }
    );
    if (!res.ok) throw new Error('rate provider error');
    const json = (await res.json()) as Record<string, { usd: number }>;
    cache = {
      at: now,
      rates: {
        xec: json.ecash?.usd ?? FALLBACK.xec,
        doge: json.dogecoin?.usd ?? FALLBACK.doge
      }
    };
  } catch {
    cache = { at: now, rates: FALLBACK };
  }

  return { rate: cache.rates[coin] ?? 0, fetchedOn: cache.at };
}
