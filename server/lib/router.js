// Tiny Express-style router on top of node:http (no dependencies).
// Supports app.get/post/put/delete with :params, JSON bodies and static files.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('http-server');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, rx, keys, handler });
  };

  const app = { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), staticDir: null };

  app.static = (dir) => { app.staticDir = path.resolve(dir); };

  app.handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.json = (obj, status = 200) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      res.end(body);
    };
    req.query = Object.fromEntries(url.searchParams);
    req.path = url.pathname;

    const started = Date.now();
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.rx.exec(url.pathname);
        if (!m) continue;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') req.body = await readJson(req);
        await r.handler(req, res);
        if (!url.pathname.startsWith('/api/stream')) log.debug('request', { method: req.method, path: url.pathname, ms: Date.now() - started });
        return;
      }
      if (url.pathname.startsWith('/api/')) return res.json({ error: 'Nem található végpont.' }, 404);
      if (req.method === 'GET' && app.staticDir) return serveStatic(app.staticDir, url.pathname, res);
      res.writeHead(404); res.end();
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error('handler error', { path: url.pathname, err, stack: err.stack });
      if (!res.headersSent) res.json({ error: err.publicMessage || 'Belső hiba történt. Részletek a szervernaplóban.' }, status);
      else res.end();
    }
  };
  return app;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { const e = new Error('too large'); e.status = 413; e.publicMessage = 'Túl nagy kérés.'; reject(e); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { const e = new Error('bad json'); e.status = 400; e.publicMessage = 'Hibás JSON a kérésben.'; reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(root, pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'content-type': MIME['.txt'] }); return res.end('Nem található.'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

export function httpError(status, publicMessage) {
  const e = new Error(publicMessage); e.status = status; e.publicMessage = publicMessage; return e;
}
