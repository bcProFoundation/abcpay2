export interface AppConfig {
  port: number;
  basePath: string;
  databaseUrl: string;
  requireAuth: boolean;
  chronik: {
    xecUrls: string[];
    dogeUrls: string[];
  };
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 3232),
  basePath: '/bws/api',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://abcpay:abcpay@localhost:5432/abcpay',
  requireAuth: process.env.REQUIRE_AUTH !== '0',
  chronik: {
    xecUrls: (process.env.CHRONIK_XEC_URLS ?? 'https://chronik.e.cash,https://chronik.pay2stay.com/xec').split(','),
    dogeUrls: (
      process.env.CHRONIK_DOGE_URLS ?? 'https://chronik.pay2stay.com/doge,https://chronik.everdoge.me/doge'
    ).split(',')
  }
};
