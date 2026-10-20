const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const DIST = process.env.WEB_DIST || path.join(__dirname, '..', 'apps', 'abcpay-web', 'dist');
const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:3232';
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

const apiUrl = new URL(API_ORIGIN);
const TOKEN_ICONS_ORIGIN = 'https://icons.etokens.cash';
const TOKEN_ICON_PATH = /^\/token-icons\/(32|64|128|256|512)\/([a-f0-9]{64})\.png$/i;

function proxyTokenIcon(req, res, size, tokenId) {
  const upstream = new URL(`${TOKEN_ICONS_ORIGIN}/${size}/${tokenId.toLowerCase()}.png`);
  const lib = upstream.protocol === 'https:' ? https : http;
  const proxyReq = lib.request(
    {
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: upstream.pathname,
      method: 'GET',
      headers: {
        Accept: 'image/png,image/*;q=0.8,*/*;q=0.5',
        'User-Agent': 'AbcPay-TokenIconProxy/1.0'
      }
    },
    proxyRes => {
      const status = proxyRes.statusCode || 502;
      const headers = {
        'Content-Type': proxyRes.headers['content-type'] || 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      };
      if (proxyRes.headers['content-length']) {
        headers['Content-Length'] = proxyRes.headers['content-length'];
      }
      if (proxyRes.headers['etag']) headers['ETag'] = proxyRes.headers['etag'];
      res.writeHead(status, headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.setTimeout(15000);
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Token icon unavailable');
    } else {
      res.destroy();
    }
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
  });
  proxyReq.end();
}

function proxy(req, res) {
  const isSse = /\/(?:cws|bws)\/api\/v[15]\/notifications\/?/.test(req.url || '');
  const proxyReq = http.request(
    {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: apiUrl.host }
    },
    proxyRes => {
      const headers = { ...proxyRes.headers };
      if (isSse) {
        headers['cache-control'] = 'no-cache, no-transform';
        headers['x-accel-buffering'] = 'no';
        delete headers['content-length'];
      }
      res.writeHead(proxyRes.statusCode || 502, headers);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      proxyRes.pipe(res);
    }
  );
  proxyReq.setTimeout(isSse ? 0 : 120000);
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('API unavailable');
    } else {
      res.destroy();
    }
  });
  req.pipe(proxyReq);
}

function handleRequest(req, res) {
  if (req.url.startsWith('/cws/') || req.url.startsWith('/bws/')) return proxy(req, res);

  let requestPath;
  try {
    requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  // Same-origin Cashtab/eTokens icons — Brave Shields block third-party icon CDNs.
  const iconMatch = requestPath.match(TOKEN_ICON_PATH);
  if (iconMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }
    return proxyTokenIcon(req, res, iconMatch[1], iconMatch[2]);
  }

  let filePath = path.join(DIST, requestPath);
  const relative = path.relative(DIST, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || stat.isDirectory()) filePath = path.join(DIST, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
      });
      res.end(data);
    });
  });
}

if (TLS_CERT && TLS_KEY) {
  https
    .createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handleRequest)
    .listen(PORT, '0.0.0.0', () => {
      console.log(`abcpay lan web on https://0.0.0.0:${PORT} dist=${DIST} api=${API_ORIGIN}`);
    });
} else {
  console.warn(
    'abcpay lan web: serving over plain HTTP. Use TLS_CERT/TLS_KEY or terminate TLS in front of this server before exposing it outside a trusted LAN.'
  );
  http.createServer(handleRequest).listen(PORT, '0.0.0.0', () => {
    console.log(`abcpay lan web on http://0.0.0.0:${PORT} dist=${DIST} api=${API_ORIGIN}`);
  });
}
