// Minimal static file server for the Playwright suite.
// Node only, so the tests run the same on Linux, macOS and Windows.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const relative =
      decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const target = path.join(ROOT, relative);

    // Never serve outside the repo, whatever the request path claims.
    if (!target.startsWith(ROOT)) {
      response.writeHead(403).end();
      return;
    }

    fs.readFile(target, (error, data) => {
      if (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`static server on http://127.0.0.1:${PORT}`);
  });
