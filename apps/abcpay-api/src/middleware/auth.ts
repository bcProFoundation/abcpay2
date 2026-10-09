import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import {
  isTimestampFresh,
  verifyRequest,
  verifyRequestV5
} from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { copayers, identities } from '../db/schema';
import { config } from '../config';

function isPublicPath(method: string, path: string): boolean {
  const route = path.split('?')[0] ?? path;
  if (path === '/health') return true;
  if (method === 'GET' && route === '/v5/node-info') return true;
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

const nonceTtlMs = 2 * 300_000;
const seenNonces = new Map<string, number>();

function nonceSeen(identity: string, nonce: string, nowMs: number): boolean {
  for (const [key, expiry] of seenNonces) {
    if (expiry <= nowMs) seenNonces.delete(key);
  }
  return seenNonces.has(`${identity}|${nonce}`);
}

function rememberNonce(identity: string, nonce: string, nowMs: number): void {
  seenNonces.set(`${identity}|${nonce}`, nowMs + nonceTtlMs);
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

  let bodyJson = '{}';
  let bodyRaw = '';
  if (method === 'POST' || method === 'PUT') {
    try {
      const cloned = c.req.raw.clone();
      bodyRaw = await cloned.text();
      bodyJson = JSON.stringify(JSON.parse(bodyRaw));
    } catch {
      bodyJson = '{}';
      bodyRaw = '';
    }
  }

  const claimedCopayerId = c.req.header('x-copayer-id');
  const claimedWalletId = c.req.header('x-wallet-id');

  if (path.startsWith('/v5/')) {
    const tsHeader = c.req.header('x-timestamp');
    const nonce = c.req.header('x-nonce');
    if (!tsHeader || !nonce) {
      return c.json(
        { code: 'NOT_AUTHORIZED', message: 'Missing x-timestamp or x-nonce header' },
        401
      );
    }
    const ts = Number(tsHeader);
    if (!isTimestampFresh(ts, Date.now())) {
      return c.json({ code: 'NOT_AUTHORIZED', message: 'Request timestamp out of window' }, 401);
    }

    const [identityRow] = await db
      .select()
      .from(identities)
      .where(eq(identities.identityKey, identity))
      .limit(1);
    let requestPubKey = identityRow?.requestPubKey;
    let copayerId: string | undefined;
    let walletId: string | undefined;
    if (!requestPubKey) {
      const [copayer] = await db
        .select()
        .from(copayers)
        .where(eq(copayers.copayerId, identity))
        .limit(1);
      if (!copayer) {
        return c.json({ code: 'NOT_AUTHORIZED', message: 'Unknown identity' }, 401);
      }
      requestPubKey = copayer.requestPubKey;
      copayerId = copayer.copayerId;
      walletId = copayer.walletId;
    }
    if (claimedCopayerId && copayerId && claimedCopayerId !== identity) {
      return c.json({ code: 'FORBIDDEN', message: 'Copayer id does not match request identity' }, 403);
    }
    if (claimedWalletId && walletId && claimedWalletId !== walletId) {
      return c.json({ code: 'FORBIDDEN', message: 'Wallet id does not match request identity' }, 403);
    }
    if (nonceSeen(identity, nonce, Date.now())) {
      return c.json({ code: 'NOT_AUTHORIZED', message: 'Replayed request nonce' }, 401);
    }
    if (!verifyRequestV5(requestPubKey, signature, method, path, ts, nonce, bodyRaw)) {
      return c.json({ code: 'NOT_AUTHORIZED', message: 'Invalid signature' }, 401);
    }
    rememberNonce(identity, nonce, Date.now());
    if (copayerId) {
      c.set('copayerId', copayerId);
      if (walletId) c.set('walletId', walletId);
    }
    return next();
  }

  const [copayer] = await db.select().from(copayers).where(eq(copayers.copayerId, identity)).limit(1);
  if (!copayer) {
    return c.json({ code: 'NOT_AUTHORIZED', message: 'Unknown copayer' }, 401);
  }

  if (claimedCopayerId && claimedCopayerId !== identity) {
    return c.json({ code: 'FORBIDDEN', message: 'Copayer id does not match request identity' }, 403);
  }

  if (!verifyRequest(copayer.requestPubKey, signature, method, path, bodyJson)) {
    return c.json({ code: 'NOT_AUTHORIZED', message: 'Invalid signature' }, 401);
  }

  if (claimedWalletId && claimedWalletId !== copayer.walletId) {
    return c.json({ code: 'FORBIDDEN', message: 'Wallet id does not match request identity' }, 403);
  }

  c.set('copayerId', identity);
  c.set('walletId', copayer.walletId);
  return next();
}
