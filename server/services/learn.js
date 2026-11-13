// AI-motor service: records pre-match snapshots (raw model probabilities +
// market no-vig probabilities + factor values), labels them when results are
// final, trains the calibrators / factor learner, generates Hungarian insights
// and exposes an adjuster used by the analysis.
//
// Data sources are kept strictly apart: parameters learned on simulated (MINTA)
// matches are only ever applied to simulated matches, never to real ones.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, store } from '../store.js';
import { createLogger } from '../logger.js';
import { settleSelection } from '../engine/settle.js';
import { trainCalibrator, trainFactors, adjustMarket, interpret, MIN_ROWS } from '../engine/ai.js';

const log = createLogger('ai');
const FILE = path.join(config.dataDir, 'ai.json');
const FAMILIES = ['result', 'totals', 'spread', 'btts', 'teamtotals', 'cards', 'player'];
const SPORT_HU = { nba: 'NBA', nhl: 'NHL', tennis: 'Tenisz', football: 'Labdarúgás', handball: 'Kézilabda' };
const FAMILY_HU = { result: 'győztes / végeredmény', totals: 'gólszám / összpontszám', spread: 'hendikep', btts: 'mindkét csapat gól', teamtotals: 'csapat gól-/pontszáma', cards: 'sárga lapok', player: 'játékos pontjai / góljai' };
const MAX_RECORDS = 8000;

let ai = { models: {}, factors: {}, insights: [], trainedAt: null, history: [], labels: {}, newSinceTrain: 0 };
try { if (fs.existsSync(FILE)) ai = { ...ai, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (err) { log.warn('ai.json unreadable, starting fresh', { err }); }
const persist = () => { try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(ai)); fs.renameSync(FILE + '.tmp', FILE); } catch (err) { log.warn('ai.json write failed', { err }); } };

const records = () => (db().learn ||= {});
export const srcOf = (match) => (match.provider === 'mock' ? 'mock' : 'live');

// ---------------------------------------------------------------------------
// Snapshots & labels
// ---------------------------------------------------------------------------
/** Store/refresh the pre-match snapshot of a match (raw probabilities, before AI). */
export function recordSnapshot(match, analysis, { save = true } = {}) {
  if (!analysis || match.status !== 'pre') return;
  const mk = [];
  for (const m of analysis.markets) {
    if (!FAMILIES.includes(m.family) || m.key === 'dc') continue;
    mk.push({ k: m.key, f: m.family, line: m.line ?? null, s: m.selections.map((s) => [s.key, s.pRaw ?? s.p, s.novig ?? null]) });
  }
  const x = {};
  for (const f of analysis.factors || []) { if (f.available) x[f.key] = f.diff; ai.labels[f.key] = f.label; }
  records()[match.id] = { id: match.id, sport: match.sport, league: match.league, src: srcOf(match), t: Date.parse(match.startTime), x, mk, y: null };
  if (save) store.save();
}

/** Attach outcomes of a finished match. Returns true if labelled. */
export function labelRecord(match) {
  const r = records()[match.id];
  if (!r || r.y || match.status !== 'post') return false;
  if (match.void) { delete records()[match.id]; return false; }
  const y = {};
  for (const m of r.mk) {
    y[m.k] = {};
    for (const [key] of m.s) {
      const res = settleSelection(match, m.k, key, m.line);
      if (res === 'won') y[m.k][key] = 1; else if (res === 'lost') y[m.k][key] = 0;
    }
  }
  r.y = y; ai.newSinceTrain = (ai.newSinceTrain || 0) + 1;
  return true;
}

export function labelFinished(matches) {
  let n = 0;
  for (const m of matches) if (m.status === 'post' && labelRecord(m)) n++;
  // Drop stale unlabeled records (match disappeared) and cap the size.
  const R = records(); const now = Date.now();
  for (const [id, r] of Object.entries(R)) if (!r.y && now - r.t > 4 * 864e5) delete R[id];
  const ids = Object.keys(R);
  if (ids.length > MAX_RECORDS) ids.sort((a, b) => R[a].t - R[b].t).slice(0, ids.length - MAX_RECORDS).forEach((id) => delete R[id]);
  if (n) store.save();
  return n;
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------
function rowsFor(src, sport, family) {
  const rows = [];
  for (const r of Object.values(records())) {
    if (!r.y || r.src !== src || r.sport !== sport) continue;
    for (const m of r.mk) {
      if (m.f !== family || !r.y[m.k]) continue;
      const sels = m.s.length === 2 ? m.s.slice(0, 1) : m.s; // two-way: one row (the other is its mirror)
      for (const [key, pm, pk] of sels) { const y = r.y[m.k][key]; if (y === 0 || y === 1) rows.push({ t: r.t, pm, pk, y }); }
    }
  }
  return rows;
}

function factorRows(src, sport) {
  const rows = [];
  for (const r of Object.values(records())) {
    if (!r.y || r.src !== src || r.sport !== sport) continue;
    const main = r.mk.find((m) => m.f === 'result');
    const y = main && r.y[main.k]?.home;
    if (y === 0 || y === 1) rows.push({ x: r.x, y });
  }
  return rows;
}

export function train({ reason = 'schedule' } = {}) {
  const t0 = Date.now();
  const models = {}; const factors = {};
  const srcs = [...new Set(Object.values(records()).filter((r) => r.y).map((r) => r.src))];
  for (const src of srcs) {
    models[src] = {}; factors[src] = {};
    for (const sport of Object.keys(SPORT_HU)) {
      models[src][sport] = {};
      for (const fam of FAMILIES) {
        const rows = rowsFor(src, sport, fam);
        if (!rows.length) continue;
        const res = trainCalibrator(rows);
        models[src][sport][fam] = { ...res, interp: interpret(res.beta) };
      }
      const fr = factorRows(src, sport);
      const keys = [...new Set(fr.flatMap((r) => Object.keys(r.x)))];
      const f = trainFactors(fr, keys);
      if (f) factors[src][sport] = { ...f, importance: f.importance.map((x) => ({ ...x, label: ai.labels[x.key] || x.key })) };
    }
  }
  ai.models = models; ai.factors = factors; ai.trainedAt = Date.now(); ai.newSinceTrain = 0;
  ai.insights = buildInsights(models, factors);
  const active = Object.values(models).flatMap((s) => Object.values(s).flatMap((f) => Object.values(f))).filter((m) => m.active).length;
  ai.history = [{ t: ai.trainedAt, reason, active, labelled: Object.values(records()).filter((r) => r.y).length }, ...(ai.history || [])].slice(0, 30);
  persist();
  log.info('ai trained', { reason, active, ms: Date.now() - t0 });
  return status();
}

/** Retrain when enough new results arrived (or never trained yet). */
export function maybeTrain() {
  const labelled = Object.values(records()).filter((r) => r.y).length;
  if (!labelled) return null;
  if (!ai.trainedAt || (ai.newSinceTrain || 0) >= 10 || Date.now() - ai.trainedAt > 12 * 3600e3) return train({ reason: ai.trainedAt ? 'new-results' : 'first' });
  return null;
}

// ---------------------------------------------------------------------------
// Adjuster used by the analysis
// ---------------------------------------------------------------------------
export function adjusterFor(match) {
  const fams = ai.models?.[srcOf(match)]?.[match.sport];
  if (!fams) return null;
  return (family, sels) => {
    const m = fams[family];
    if (!m?.active) return null;
    return adjustMarket(m.beta, sels);
  };
}

// ---------------------------------------------------------------------------
// Insights (Hungarian)
// ---------------------------------------------------------------------------
const pc = (x, d = 0) => `${(x * 100).toFixed(d).replace('.', ',')}%`;
const f3 = (x) => x.toFixed(3).replace('.', ',');

function buildInsights(models, factors) {
  const out = [];
  for (const [src, sports] of Object.entries(models)) {
    for (const [sport, fams] of Object.entries(sports)) {
      const S = SPORT_HU[sport];
      for (const [fam, m] of Object.entries(fams)) {
        const M = m.metrics; if (!M || M.n < 40) continue;
        const F = sport === 'tennis' && fam === 'btts' ? 'mindkét játékos nyer szettet' : sport === 'tennis' && fam === 'totals' ? 'összes játék' : FAMILY_HU[fam];
        // 1) calibration problems
        const bad = (M.calAll || []).filter((b) => b.n >= 15 && Math.abs(b.actual - b.predicted) >= 0.08)
          .sort((a, b) => Math.abs(b.actual - b.predicted) * Math.sqrt(b.n) - Math.abs(a.actual - a.predicted) * Math.sqrt(a.n))[0];
        if (bad) {
          const over = bad.actual < bad.predicted;
          out.push({ src, sport, family: fam, kind: 'calibration', weight: Math.abs(bad.actual - bad.predicted) * Math.sqrt(bad.n),
            text: `${S} – ${F}: a ${pc(bad.lo)}–${pc(bad.hi)} közé becsült kimenetelek ${pc(bad.actual)}-ban jöttek be (${bad.n} eset, várt ${pc(bad.predicted)}). A modell itt ${over ? 'túl magabiztos' : 'túl óvatos'}.` });
        }
        // 2) model vs market
        if (M.llMarket != null && M.llModelOnMarketRows != null) {
          const better = M.llMarket < M.llModelOnMarketRows ? 'market' : 'model';
          out.push({ src, sport, family: fam, kind: 'market', weight: Math.abs(M.llMarket - M.llModelOnMarketRows) * 40,
            text: better === 'market'
              ? `${S} – ${F}: a piaci szorzók pontosabban jeleztek előre, mint a modell (log loss ${f3(M.llMarket)} vs. ${f3(M.llModelOnMarketRows)}). Az AI ezért nagyobb súlyt ad a piacnak.`
              : `${S} – ${F}: a modell pontosabb volt a piacnál (log loss ${f3(M.llModelOnMarketRows)} vs. ${f3(M.llMarket)}). Ez kis mintán véletlen is lehet.` });
        }
        // 3) activation result
        if (m.active) out.push({ src, sport, family: fam, kind: 'active', weight: M.gain * 200,
          text: `${S} – ${F}: az AI-korrekció bekapcsolt. A legújabb ${M.test} eseten a log loss ${f3(M.llRaw)}-ról ${f3(M.llAi)}-ra javult (modell ${pc(m.interp.modelShare)}, piac ${pc(m.interp.marketShare)} súllyal).` });
        else if (m.reason === 'no-gain') out.push({ src, sport, family: fam, kind: 'inactive', weight: 0.3,
          text: `${S} – ${F}: a tanult korrekció nem javított a félretett meccseken, ezért kikapcsolva maradt (${M.n} minta).` });
      }
    }
    for (const [sport, f] of Object.entries(factors[src] || {})) {
      const top = f.importance.filter((x) => x.importance > 0)[0];
      const wrong = f.importance.find((x) => x.importance < -0.15);
      if (top) out.push({ src, sport, kind: 'factor', weight: 1 + top.importance,
        text: `${SPORT_HU[sport]}: a lezárt meccsek alapján a(z) „${top.label}” jelezte előre legerősebben a hazai győzelmet (${f.n} meccs).` });
      if (wrong) out.push({ src, sport, kind: 'factor', weight: 0.8,
        text: `${SPORT_HU[sport]}: a(z) „${wrong.label}” tényező a vártnál ellentétesen hatott. Kis mintán ez lehet véletlen, a modell súlyait ezért nem írja át automatikusan.` });
    }
  }
  // Home-advantage bias (result market, home rows) from raw records.
  for (const src of Object.keys(models)) {
    for (const sport of Object.keys(SPORT_HU)) {
      let n = 0, sumP = 0, sumY = 0;
      for (const r of Object.values(records())) {
        if (!r.y || r.src !== src || r.sport !== sport) continue;
        const m = r.mk.find((x) => x.f === 'result'); const home = m?.s.find((s) => s[0] === 'home'); const y = m && r.y[m.k]?.home;
        if (home && (y === 0 || y === 1)) { n++; sumP += home[1]; sumY += y; }
      }
      if (n >= 60 && Math.abs(sumP / n - sumY / n) >= 0.04) out.push({ src, sport, kind: 'bias', weight: Math.abs(sumP / n - sumY / n) * Math.sqrt(n),
        text: `${SPORT_HU[sport]}: a modell átlagosan ${pc(Math.abs(sumP / n - sumY / n), 1)}-kal ${sumP > sumY ? 'túl' : 'alul'}becsüli a hazai győzelmet (${n} meccs: várt ${pc(sumP / n)}, tényleges ${pc(sumY / n)}).` });
    }
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 40);
}

// ---------------------------------------------------------------------------
export function status() {
  const R = Object.values(records());
  const count = (src) => ({ snapshots: R.filter((r) => r.src === src).length, labelled: R.filter((r) => r.src === src && r.y).length });
  return {
    trainedAt: ai.trainedAt, minRows: MIN_ROWS, newSinceTrain: ai.newSinceTrain || 0,
    sources: { live: count('live'), mock: count('mock') },
    models: ai.models, factors: ai.factors, insights: ai.insights, history: ai.history,
  };
}
