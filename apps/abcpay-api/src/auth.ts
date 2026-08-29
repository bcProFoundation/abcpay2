import type { MiddlewareHandler } from 'hono';
import { verifyRequest } from '@bcpros/abcpay-wallet-core';
import { walletService } from './services/wallet.service';
import { config } from './config';

const OPEN_PATHS = [
  '/health',
  '/v1/wallets/',
  '/v2/wallets/',
  '/v1/feelevels/',
  '/v3/fiatrates/'
];

function isOpen(path: string, method: string): boolean {
  if (method === 'GET' && path.includes('/join-info')) return true;
  if (method === 'POST' && /\/v[12]\/wallets\/?$/.test(path)) return true;
  if (method === 'POST' && /\/wallets\/[^/]+\/copayers\/?$/.test(path)) return true;
  return OPEN_PATHS.some(p => path.endsWith(p) || path.includes(`/fiatrates/`));
}

export const copayerAuth: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const method = c.req.method;

  if (method === 'OPTIONS' || isOpen(path, method) || !config.requireAuth) {
    return next();
  }

  const walletId = c.req.header('x-wallet-id');
  const copayerId = c.req.header('x-identity') ?? c.req.header('x-copayer-id');
  const signature = c.req.header('x-signature');

  if (!walletId || !copayerId) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Missing x-wallet-id or x-identity' }, 401);
  }

  const copayer = await walletService.getCopayer(copayerId);
  if (!copayer || copayer.walletId !== walletId) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Unknown copayer' }, 401);
  }

  if (signature) {
    const body = method === 'GET' || method === 'HEAD' ? '' : await c.req.raw.clone().text();
    const ok = verifyRequest(copayer.requestPubKey, signature, method, path, body);
    if (!ok) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid request signature' }, 401);
    }
  } else if (config.requireAuth) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Missing x-signature' }, 401);
  }

  await next();
};
