import type { Context, Next } from 'hono';
import { BitcoreLib as Bitcore } from '@bcpros/crypto-wallet-core';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { copayers } from '../db/schema';

const PUBLIC_PATHS = [
  '/health',
  '/v1/wallets/',
  '/v2/wallets/',
  '/v1/feelevels/',
  '/v2/feelevels/',
  '/v3/fiatrates/'
];

function isPublicPath(method: string, path: string): boolean {
  if (path === '/health') return true;
  if (method === 'POST' && (path === '/v1/wallets/' || path === '/v2/wallets/')) return true;
  if (method === 'POST' && path.match(/^\/v[12]\/wallets\/[^/]+\/copayers\/?$/)) return true;
  if (method === 'GET' && path.startsWith('/v3/fiatrates/')) return true;
  if (method === 'GET' && path.match(/^\/v1\/wallets\/[^/]+\/info\/?$/)) return true;
  if (method === 'GET' && path.match(/^\/v1\/wallets\/[^/]+\/join-info\/?$/)) return true;
  return false;
}

function hashMessage(message: string): Buffer {
  const msg = Buffer.from(message);
  const buf = Buffer.concat([Buffer.from('\x18Bitcoin Signed Message:\n'), Buffer.from([msg.length]), msg]);
  return Bitcore.crypto.Hash.sha256sha256(buf);
}

function verifyMessage(message: string, signature: string, pubKey: string): boolean {
  try {
    const hash = hashMessage(message);
    const sig = Bitcore.crypto.Signature.fromString(signature);
    const pub = new Bitcore.PublicKey(pubKey);
    return Bitcore.crypto.ECDSA.verify(hash, sig, pub, { endian: 'little' });
  } catch {
    return false;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/bws\/api/, '') + url.search || '/';
  const method = c.req.method;

  if (isPublicPath(method, path)) {
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

  let body: unknown = {};
  if (method === 'POST' || method === 'PUT') {
    try {
      const cloned = c.req.raw.clone();
      body = await cloned.json();
    } catch {
      body = {};
    }
  } else if (method === 'GET' && url.search) {
    body = Object.fromEntries(url.searchParams.entries());
  }

  const message = `${method.toLowerCase()}|${path}|${JSON.stringify(body)}`;
  if (!verifyMessage(message, signature, copayer.requestPubKey)) {
    return c.json({ code: 'NOT_AUTHORIZED', message: 'Invalid signature' }, 401);
  }

  c.set('copayerId', identity);
  c.set('walletId', copayer.walletId);
  return next();
}
