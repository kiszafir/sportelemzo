// Tip log: every match gets one logged tip (the first recommendation made before
// or during the match). Tips are settled automatically when the match is final.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, store } from '../store.js';
import { createLogger } from '../logger.js';
import { analyzeMatch } from '../engine/analyze.js';
import { settleSelection } from '../engine/settle.js';
import { mockHistory, mockOdds } from '../providers/mock.js';
import { localDay } from '../lib/time.js';
import { recordSnapshot, labelRecord } from './learn.js';

const log = createLogger('tips');

function tipRecord(m, a, createdAt = Date.now()) {
  const t = a.tip; if (!t) return null;
  const mk = a.markets.find((x) => x.key === t.market);
  return {
    id: `tip-${m.id}`, matchId: m.id, sport: m.sport, league: m.league, leagueName: m.leagueName,
    matchName: `${m.home.name} – ${m.away.name}`, startTime: m.startTime,
    market: t.market, marketLabel: t.marketLabel, betType: t.betType, selection: t.selection, line: mk?.line ?? null, name: t.name,
    kind: t.kind, p: t.p, odds: t.odds, oddsSource: t.oddsSource, ev: t.ev, confidence: t.confidence,
    live: m.status === 'live', source: m.provider === 'mock' ? 'mock' : 'live',
    createdAt, status: 'pending', settledAt: null, result: null,
  };
}

export function logTips(matches, analyses) {
  const tips = db().tips; const have = new Set(tips.map((t) => t.matchId));
  let added = 0;
  for (const m of matches) {
    if (have.has(m.id) || m.status === 'post') continue;
    const a = analyses.get(m.id); if (!a?.tip) continue;
    // Only log once the tip is "actionable": priced, and within 36 h of the start.
    if (Date.parse(m.startTime) - Date.now() > 36 * 3600e3) continue;
    const rec = tipRecord(m, a); if (rec) { tips.push(rec); added++; }
  }
  if (added) { store.save(); log.debug('tips logged', { added }); }
}

export function settleTips(matchMap) {
  let changed = 0;
  for (const t of db().tips) {
    if (t.status !== 'pending') continue;
    const m = matchMap.get(t.matchId);
    if (m?.status === 'post') {
      const r = settleSelection(m, t.market, t.selection, t.line);
      if (r) { t.status = r; t.settledAt = Date.now(); t.result = `${m.home.score}–${m.away.score}`; changed++; }
    } else if (!m && Date.now() - Date.parse(t.startTime) > 3 * 24 * 3600e3) {
      t.status = 'void'; t.settledAt = Date.now(); t.result = 'eredmény nem elérhető'; changed++;
    }
  }
  // Bankroll bets linked to a tip settle with it.
  for (const b of db().bets) {
    if (b.status !== 'pending' || !b.tipId) continue;
    const t = db().tips.find((x) => x.id === b.tipId);
    if (t && t.status !== 'pending') { b.status = t.status; b.settledAt = t.settledAt; changed++; }
  }
  if (changed) store.save();
}

/** Seed ~45 days of simulated tips so the statistics page has content in mock mode. */
export function seedMockHistory() {
  const t0 = Date.now();
  const hist = mockHistory({ days: 45 });
  const tips = db().tips; const have = new Set(tips.map((t) => t.matchId));
  for (const fin of hist) {
    if (have.has(fin.id)) continue;
    // Re-create the pre-match view of the same match.
    const pre = { ...fin, status: 'pre', live: null, home: { ...fin.home, score: null, sets: undefined }, away: { ...fin.away, score: null, sets: undefined } };
    let a = analyzeMatch(pre);
    const o = mockOdds(pre, a, Date.parse(fin.startTime) - 2 * 3600e3);
    pre.odds = o.odds; pre.movement = o.movement;
    a = analyzeMatch(pre);
    // AI-motor training data: the same pre-match view + the final result (MINTA source).
    recordSnapshot(pre, a, { save: false }); labelRecord(fin);
    const rec = tipRecord(pre, a, Date.parse(fin.startTime) - 2 * 3600e3);
    if (!rec) continue;
    const r = settleSelection(fin, rec.market, rec.selection, rec.line);
    Object.assign(rec, { status: r || 'void', settledAt: Date.parse(fin.startTime) + 3 * 3600e3, result: `${fin.home.score}–${fin.away.score}` });
    tips.push(rec);
  }
  tips.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  db().seededHistory = true; db().seededLearn = true; store.save();
  log.info('seeded mock tip history', { tips: tips.length, ms: Date.now() - t0 });
}

const HIST_FILE = path.join(config.dataDir, 'history.json');
let archived = null;

/** Per-team yellow-card history from archived real matches: key "league|team" → { n, sum }. */
export function cardHistory() {
  if (!archived) { try { archived = fs.existsSync(HIST_FILE) ? JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')) : []; } catch { archived = []; } }
  const out = {};
  for (const m of archived) {
    if (!m.cards) continue;
    for (const side of ['home', 'away']) {
      const k = `${m.league}|${m[side].name}`; const v = Number(m.cards[side]);
      if (!Number.isFinite(v)) continue;
      (out[k] ||= { n: 0, sum: 0 }); out[k].n++; out[k].sum += v;
    }
  }
  return out;
}

// Finished real matches are archived for backtesting (data/history.json).
export function archiveFinished(matches) {
  const fin = matches.filter((m) => m.status === 'post' && m.provider !== 'mock');
  if (!fin.length) return;
  if (!archived) { try { archived = fs.existsSync(HIST_FILE) ? JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')) : []; } catch { archived = []; } }
  const ids = new Set(archived.map((m) => m.id)); let n = 0;
  for (const m of fin) {
    if (ids.has(m.id)) continue;
    const { odds: _o, ...rest } = m; void _o;
    // player profiles are rebuilt from box scores; keep the archive small
    if (rest.stats) rest.stats = Object.fromEntries(Object.entries(rest.stats).map(([k, v]) => { if (!v || typeof v !== 'object') return [k, v]; const { roster: _r, teamAvg: _t, ...st } = v; void _r; void _t; return [k, st]; }));
    archived.push(rest); n++;
  }
  if (n) {
    if (archived.length > 5000) archived = archived.slice(-5000);
    try { fs.writeFileSync(HIST_FILE, JSON.stringify(archived)); } catch (err) { log.warn('archive write failed', { err }); }
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
const CONF_BANDS = [[1, 40, '1–40'], [41, 55, '41–55'], [56, 70, '56–70'], [71, 85, '71–85'], [86, 100, '86–100']];

export function filterTips({ from, to, sport, market, source } = {}) {
  return db().tips.filter((t) => {
    const d = localDay(Date.parse(t.startTime));
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (sport && sport !== 'all' && t.sport !== sport) return false;
    if (market && market !== 'all' && t.betType !== market) return false;
    if (source && source !== 'all' && t.source !== source) return false;
    return true;
  });
}

function agg(list) {
  const settled = list.filter((t) => t.status === 'won' || t.status === 'lost');
  const won = settled.filter((t) => t.status === 'won').length;
  // ROI at flat 1-unit stakes: Σ(profit) / Σ(stake)
  const profit = settled.reduce((s, t) => s + (t.status === 'won' ? t.odds - 1 : -1), 0);
  const brier = settled.length ? settled.reduce((s, t) => s + (t.p - (t.status === 'won' ? 1 : 0)) ** 2, 0) / settled.length : null;
  const expected = settled.reduce((s, t) => s + t.p, 0);
  return { n: list.length, settled: settled.length, won, lost: settled.length - won, void: list.filter((t) => t.status === 'void').length,
    pending: list.filter((t) => t.status === 'pending').length,
    hitRate: settled.length ? won / settled.length : null, expectedHitRate: settled.length ? expected / settled.length : null,
    roi: settled.length ? profit / settled.length : null, profit, brier };
}

const groupBy = (list, fn) => list.reduce((m, t) => { const k = fn(t); (m[k] ||= []).push(t); return m; }, {});

export function tipStats(filters) {
  const list = filterTips(filters);
  const SPORT_HU = { nba: 'NBA', nhl: 'NHL', tennis: 'Tenisz', football: 'Labdarúgás', handball: 'Kézilabda' };
  // Weekly time series (accuracy + cumulative ROI)
  const byWeek = groupBy(list.filter((t) => t.status === 'won' || t.status === 'lost').sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)), (t) => weekKey(Date.parse(t.startTime)));
  let cumProfit = 0, cumN = 0;
  const series = Object.entries(byWeek).sort(([a], [b]) => a.localeCompare(b)).map(([wk, ts]) => {
    const g = agg(ts); cumProfit += g.profit; cumN += g.settled;
    return { week: wk, n: g.settled, hitRate: g.hitRate, expected: g.expectedHitRate, cumRoi: cumN ? cumProfit / cumN : 0, cumProfit };
  });
  const by = (fn, labeler = (k) => k) => Object.entries(groupBy(list, fn)).map(([k, ts]) => ({ key: k, label: labeler(k), ...agg(ts) })).sort((a, b) => b.n - a.n);
  const bands = CONF_BANDS.map(([lo, hi, label]) => ({ key: label, label, ...agg(list.filter((t) => t.confidence >= lo && t.confidence <= hi)) }));
  return {
    total: agg(list), series,
    bySport: by((t) => t.sport, (k) => SPORT_HU[k] || k),
    byMarket: by((t) => t.betType),
    byKind: by((t) => t.kind, (k) => (k === 'value' ? 'Értéktipp' : 'Esélyes kimenetel')),
    byConfidence: bands,
    markets: [...new Set(db().tips.map((t) => t.betType))].sort(),
    sources: [...new Set(db().tips.map((t) => t.source))],
  };
}

function weekKey(t) {
  const d = new Date(localDay(t) + 'T00:00:00Z');
  const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd);
  return d.toISOString().slice(0, 10);
}
