import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { verifyRequest } from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { copayers } from '../db/schema';
import { config } from '../config';

function isPublicPath(method: string, path: string): boolean {
  if (path === '/health') return true;
  if (method === 'POST' && (path === '/v1/wallets/' || path === '/v2/wallets/')) return true;
  if (method === 'POST' && path.match(/^\/v[12]\/wallets\/[^/]+\/copayers\/?$/)) return true;
  if (method === 'GET' && path.startsWith('/v3/fiatrates/')) return true;
  if (method === 'GET' && (path.startsWith('/v1/feelevels/') || path.startsWith('/v2/feelevels/'))) {
    return true;
  }
  if (method === 'GET' && path.match(/^\/v1\/wallets\/[^/]+\/info\/?$/)) return true;
  if (method === 'GET' && path.match(/^\/v1\/wallets\/[^/]+\/join-info\/?$/)) return true;
  return false;
}

export async function authMiddleware(c: Context, next: Next) {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/(?:cws|bws)\/api/, '') + url.search || '/';
  const method = c.req.method;

  if (method === 'OPTIONS' || isPublicPath(method, path) || !config.requireAuth) {
    return next();
  }

  const identity = c.req.header('x-identity');
  const signature = c.req.header('x-signature');

  if (!identity || !signature) {
    return c.json({ code: 'NOT_AUTHORIZED', message: 'Missing authentication headers' }, 401);
  }

  const [copayer] = await db.select().from(copayers).where(eq(copayers.copayerId, identity)).limit(1);
  if (!copayer) {
    return c.json({ code: 'NOT_AUTHORIZED', message: 'Unknown copayer' }, 401);
  }

  const claimedCopayerId = c.req.header('x-copayer-id');
  if (claimedCopayerId && claimedCopayerId !== identity) {
    return c.json({ code: 'FORBIDDEN', message: 'Copayer id does not match request identity' }, 403);
  }

  let body = '{}';
  if (method === 'POST' || method === 'PUT') {
    try {
      const cloned = c.req.raw.clone();
      body = JSON.stringify(await cloned.json());
    } catch {
      body = '{}';
    }
  }

  if (!verifyRequest(copayer.requestPubKey, signature, method, path, body)) {
    return c.json({ code: 'NOT_AUTHORIZED', message: 'Invalid signature' }, 401);
  }

  const claimedWalletId = c.req.header('x-wallet-id');
  if (claimedWalletId && claimedWalletId !== copayer.walletId) {
    return c.json({ code: 'FORBIDDEN', message: 'Wallet id does not match request identity' }, 403);
  }

  c.set('copayerId', identity);
  c.set('walletId', copayer.walletId);
  return next();
}
