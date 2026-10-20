/* AbcPay Wallet Service Worker — PWA installability + Push & System Notifications */
const CACHE_NAME = 'abcpay-shell-v2';
const TOKEN_ICONS_CACHE = 'abcpay-token-icons-v1';
const TOKEN_ICONS_ORIGIN = 'https://icons.etokens.cash';
const PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/abcpay-logo.svg',
  '/abcpay-text.svg',
  '/logo-round.svg',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/currencies/xec.svg',
  '/currencies/doge.svg',
  '/currencies/eToken.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME && key !== TOKEN_ICONS_CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cashtab/eTokens icons — cache-first so token images survive reloads offline.
  if (url.origin === TOKEN_ICONS_ORIGIN && /\.png$/i.test(url.pathname)) {
    event.respondWith(
      caches.open(TOKEN_ICONS_CACHE).then(async cache => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) {
          try {
            await cache.put(req, res.clone());
          } catch {
            // ignore quota failures
          }
        }
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/cws/api') || url.pathname.startsWith('/bws/api')) return;

  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req))
    );
    return;
  }

  // Network-first for navigation & app bundles so updates take effect immediately.
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

function showWalletNotification(payload) {
  const title = payload && payload.title ? String(payload.title) : 'AbcPay Wallet';
  const body = payload && payload.body ? String(payload.body) : 'New wallet activity';
  const targetUrl = payload && payload.url ? String(payload.url) : '/';
  const tag = payload && payload.tag ? String(payload.tag) : undefined;

  return self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag,
    data: { url: targetUrl }
  });
}

self.addEventListener('push', event => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }
  event.waitUntil(showWalletNotification(payload));
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'ABCPAY_SHOW_NOTIFICATION') {
    event.waitUntil(showWalletNotification(data.payload || {}));
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        for (const client of windowClients) {
          if ('focus' in client) {
            client.postMessage({ type: 'ABCPAY_NAVIGATE', url: targetUrl });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});
