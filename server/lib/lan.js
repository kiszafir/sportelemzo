// Phone access over the local Wi-Fi ("npm run telefon").
// The server then listens on all interfaces; requests that do not come from this
// computer must enter a 6-digit PIN once (printed in the terminal), after which an
// HttpOnly cookie keeps the phone logged in for 30 days.
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('lan');
const COOKIE = 'sp_auth';
const attempts = new Map(); // ip -> { n, until }

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

/**
 * PIN and signing secret, created once and kept in data/local-secrets.json —
 * a separate file that is git-ignored (db.json may be pushed to GitHub).
 * ACCESS_PIN in .env overrides the PIN.
 */
const SECRETS = path.join(config.dataDir, 'local-secrets.json');
let cached = null;
export function lanSecrets() {
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { cached = {}; }
    if (!cached.secret || !cached.pin) {
      cached = { secret: crypto.randomBytes(24).toString('hex'), pin: String(crypto.randomInt(0, 1e6)).padStart(6, '0') };
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(SECRETS, JSON.stringify(cached), { mode: 0o600 });
    }
  }
  return { pin: process.env.ACCESS_PIN || cached.pin, secret: cached.secret };
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const token = (pin, secret) => crypto.createHmac('sha256', secret).update(pin).digest('hex');
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x.length === 2));

const page = (msg = '') => `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Belépés – Sportelemző</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#eef2f5;color:#13202b;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#0d141b;color:#e5ecf2}form{background:#151f29!important;border-color:#26333f!important}input{background:#1a2632;color:#e5ecf2;border-color:#364553!important}}
form{background:#fff;border:1px solid #d5dde4;border-radius:16px;padding:24px;width:100%;max-width:340px;box-sizing:border-box}
h1{font-size:1.4rem;margin:0 0 6px}p{margin:0 0 14px;color:#55636f}
input{width:100%;box-sizing:border-box;font-size:1.6rem;letter-spacing:.3em;text-align:center;padding:10px;border:1px solid #b9c5cf;border-radius:10px}
button{margin-top:12px;width:100%;min-height:48px;font-size:1rem;border:0;border-radius:10px;background:#13202b;color:#fff}
.err{color:#b42318;font-weight:600}</style></head><body>
<form method="post" action="/belepes"><h1>Sportelemző</h1><p>Írd be a gépen futó program termináljában látható 6 jegyű PIN-kódot.</p>
${msg ? `<p class="err" role="alert">${msg}</p>` : ''}<label for="pin" style="position:absolute;left:-9999px">PIN-kód</label>
<input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" autofocus required>
<button type="submit">Belépés</button><p style="margin-top:14px;font-size:.8rem">18+ · Csak tájékoztató és elemző célra.</p></form></body></html>`;

/**
 * Returns true when the request may continue; otherwise it has been answered
 * (PIN page, 401 or redirect).
 */
export function lanGuard(req, res) {
  if (isLocal(req)) return true;
  const { pin, secret } = lanSecrets();
  const want = token(pin, secret);
  if (cookies(req)[COOKIE] === want) return true;
  const ip = req.socket.remoteAddress;
  if (req.method === 'POST' && req.url.startsWith('/belepes')) {
    const a = attempts.get(ip) || { n: 0, until: 0 };
    if (Date.now() < a.until) { res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' }); res.end(page('Túl sok hibás próbálkozás. Próbáld újra 5 perc múlva.')); return false; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      const got = new URLSearchParams(body).get('pin') || '';
      const ok = got.length === pin.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(pin));
      if (ok) {
        attempts.delete(ip);
        log.info('phone logged in', { ip });
        res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}=${want}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}` });
        res.end();
      } else {
        a.n += 1; if (a.n >= 5) { a.until = Date.now() + 5 * 60e3; a.n = 0; }
        attempts.set(ip, a);
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(page('Hibás PIN-kód.'));
      }
    });
    return false;
  }
  if (req.url.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Belépés szükséges (PIN-kód).' })); return false; }
  // allow the icons/manifest so "add to home screen" works before login
  if (/^\/(icons\/|manifest\.webmanifest|favicon\.svg)/.test(req.url)) return true;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page());
  return false;
}
