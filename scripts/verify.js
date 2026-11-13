#!/usr/bin/env node
// End-to-end smoke test (no browser needed): starts the app in mock mode on a
// free port with a throw-away data folder, then checks the API and the UI shell.
//   npm run verify
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3900 + Math.floor(Math.random() * 90);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sportelemzo-verify-'));
const child = spawn(process.execPath, ['server/index.js', '--mock'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return p.startsWith('/api') ? r.json() : r.text(); };
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ' – ' + extra : ''}`); if (!ok) failed++; };

try {
  for (let i = 0; i < 60; i++) { try { const h = await get('/api/health'); if (h.lastUpdate) break; } catch { /* starting */ } await sleep(250); }
  const html = await get('/');
  check('Kezdőlap betölt (HTTP 200)', html.includes('<html lang="hu">'));
  check('Magyar felület és figyelmeztetés', html.includes('Csak tájékoztató és elemző célra') && html.includes('18+'));
  const meta = await get('/api/meta');
  check('Mintaadat-mód aktív', meta.dataMode === 'mock');
  const ms = await get('/api/matches?day=all');
  check('Meccsek betöltve', ms.matches.length > 50, `${ms.matches.length} meccs`);
  check('Minden sportág szerepel (kézilabdával)', ['nba', 'nhl', 'tennis', 'football', 'handball'].every((s) => ms.matches.some((m) => m.sport === s)));
  check('Új foci-bajnokságok (EL, KL, Eredivisie …)', ['uel', 'uecl', 'eredivisie', 'primeira', 'championship', 'superlig', 'belgium', 'scotland', 'mls'].every((l) => ms.matches.some((m) => m.league === l)));
  check('Ajánlások és bizalmi pontszámok', ms.matches.filter((m) => m.tip).length > 40);
  check('MINTA jelölés minden meccsen', ms.matches.every((m) => m.dataStatus === 'mock'));
  const det = await get('/api/matches/' + encodeURIComponent(ms.matches.find((m) => m.status === 'pre').id));
  check('Meccsadatlap: piacok, tényezők, indoklás', det.analysis.markets.length > 0 && det.analysis.factors.length > 5 && det.tip?.reasoning?.length > 20);
  const easy = await get('/api/combos/easy');
  check('Könnyű mix generálva', easy.tickets.length >= 1 && easy.tickets.every((t) => t.odds <= 10 && t.legs.length >= 2 && t.legs.length <= 6), easy.tickets.map((t) => t.odds).join(', '));
  const brutal = await get('/api/combos/brutal');
  check('Brutális mix generálva', brutal.tickets.length >= 1 && brutal.tickets.every((t) => t.odds >= 70), brutal.tickets.map((t) => t.odds).join(', '));
  const oneDay = (r) => r.tickets.every((t) => new Set(t.legs.map((l) => l.day)).size === 1 && t.legs[0].day === r.day);
  check('Szelvények egy napon belül (Könnyű és Brutális)', oneDay(easy) && oneDay(brutal), `nap: ${easy.day}`);
  const tomorrow = brutal.days.find((d) => d.day > brutal.day)?.day;
  if (tomorrow) { const b2 = await get('/api/combos/brutal?day=' + tomorrow); check('Napváltás a szelvényépítőben', b2.day === tomorrow && oneDay(b2) && b2.tickets.length >= 1, tomorrow); }
  const fam = new Set(det.analysis.markets.map((m) => m.family));
  const fb = await get('/api/matches/' + encodeURIComponent(ms.matches.find((m) => m.sport === 'football' && m.status === 'pre').id));
  const fbKeys = fb.analysis.markets.map((m) => m.key);
  check('Új piacok (gólszerző, ázsiai hendikep, csapatgólszám, sárga lap)', fbKeys.includes('scorer') && fbKeys.includes('ah') && fbKeys.some((k) => k.startsWith('tth')) && fbKeys.some((k) => k.startsWith('yc')), `${fb.analysis.markets.length} piac a focimeccsen`);
  void fam;
  const sc = await get('/api/combos/brutal?markets=scorer,cards');
  check('Mix a gólszerző + sárga lap piacokból', sc.tickets.length >= 1 && sc.tickets.every((t) => t.legs.every((l) => ['scorer', 'player', 'cards'].includes(l.family))), sc.tickets.map((t) => t.odds).join(', '));
  const ai = await get('/api/ai');
  const aiModels = Object.values(ai.models.mock || {}).flatMap((f) => Object.values(f));
  check('AI-motor tanult (mintaadaton)', ai.trainedAt && aiModels.some((m) => m.active) && ai.insights.length > 0, `${aiModels.filter((m) => m.active).length} aktív korrekció, ${ai.insights.length} megfigyelés`);
  const stats = await get('/api/stats');
  check('Statisztika (szimulált előzmény)', stats.total.settled > 100, `${stats.total.settled} elszámolt tipp`);
  const k = await get('/api/kelly?p=0.6&odds=2');
  check('Kelly-javaslat plafonnal', k.stake > 0 && k.share <= 0.05);
  const js = await get('/js/app.js');
  check('Frontend modulok kiszolgálva', js.includes('ageGate'));
} catch (e) {
  check('Futás', false, e.message); console.log(out);
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} ellenőrzés sikertelen.` : '\nMinden ellenőrzés sikeres.');
process.exit(failed ? 1 : 0);
