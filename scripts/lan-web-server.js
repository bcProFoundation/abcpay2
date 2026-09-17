const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const DIST = process.env.WEB_DIST || path.join(__dirname, '..', 'apps', 'abcpay-web', 'dist');
const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:3232';

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

function proxy(req, res) {
  const proxyReq = http.request(
    {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: apiUrl.host }
    },
    proxyRes => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('API unavailable');
  });
  req.pipe(proxyReq);
}

http
  .createServer((req, res) => {
    if (req.url.startsWith('/bws/')) return proxy(req, res);

    const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.join(DIST, requestPath);
    if (!filePath.startsWith(DIST)) {
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
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`abcpay lan web on :${PORT} dist=${DIST} api=${API_ORIGIN}`);
  });
