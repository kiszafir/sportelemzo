// Turns raw match data into normalised, explainable factors.
// Every factor: { key, label, group, weight, diff, available, home, away, fmt, src }
//   diff > 0 favours the HOME side (player 1 in tennis), roughly scaled to [-1.5, 1.5].
// Missing data -> available:false (weight is then excluded from the model and
// lowers the confidence score).
import { clamp } from './mathutil.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sc = (x, s) => clamp(x / s, -1.5, 1.5);

/** Form score: weighted recent results (most recent counts most). W=1, D=0.5, L=0 */
export function formScore(results = []) {
  if (!results?.length) return null;
  const last = results.slice(-10);
  let num = 0, den = 0;
  last.forEach((r, i) => {
    const w = 1 + i / last.length; // linear recency weight
    num += w * (r === 'W' ? 1 : r === 'D' ? 0.5 : 0);
    den += w;
  });
  return num / den;
}

/** Momentum: last 3 vs previous results. */
export function momentum(results = []) {
  if (!results || results.length < 5) return null;
  const pts = (r) => (r === 'W' ? 1 : r === 'D' ? 0.5 : 0);
  const last3 = results.slice(-3).map(pts);
  const prev = results.slice(-8, -3).map(pts);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return avg(last3) - avg(prev);
}

const injuryLoad = (list) => (Array.isArray(list) ? list.reduce((s, i) => s + (i.impact ?? 0.3) * (i.status === 'kétséges' ? 0.5 : 1), 0) : null);

// --- factor definitions -----------------------------------------------------
// Each definition: [key, label, group, weight, fn(h, a, m) -> {diff, home, away} | null, fmt]
// Hungarian number formatting (decimal comma).
const hu = (s) => s.replace('.', ',');
const pct = (x) => (isNum(x) ? hu((x * 100).toFixed(1)) + '%' : '–');
const n1 = (x) => (isNum(x) ? hu(x.toFixed(1)) : '–');
const n2 = (x) => (isNum(x) ? hu(x.toFixed(2)) : '–');
const n3 = (x) => (isNum(x) ? hu(x.toFixed(3)) : '–');
const int = (x) => (isNum(x) ? String(Math.round(x)) : '–');

const both = (h, a, k) => isNum(h?.[k]) && isNum(a?.[k]);

const COMMON = {
  strength: ['strength', 'Erősség (győzelmi arány)', 'form', 1.0, (h, a) => both(h, a, 'winPct') && { diff: sc(h.winPct - a.winPct, 0.3), home: h.winPct, away: a.winPct }, pct],
  form: ['form', 'Forma (utolsó 5–10 meccs)', 'form', 1.0, (h, a) => {
    const fh = formScore(h?.form), fa = formScore(a?.form);
    return fh != null && fa != null && { diff: sc(fh - fa, 0.5), home: fh, away: fa, extra: { home: (h.form || []).slice(-5).join(''), away: (a.form || []).slice(-5).join('') } };
  }, pct],
  momentum: ['momentum', 'Lendület (utolsó 3 vs. korábbi)', 'form', 0.35, (h, a) => {
    const mh = momentum(h?.form), ma = momentum(a?.form);
    return mh != null && ma != null && { diff: sc(mh - ma, 0.8), home: mh, away: ma };
  }, n2],
  venue: ['venue', 'Hazai/idegenbeli mérleg', 'form', 0.6, (h, a) => isNum(h?.homeWinPct) && isNum(a?.awayWinPct) && { diff: sc(h.homeWinPct - a.awayWinPct, 0.35), home: h.homeWinPct, away: a.awayWinPct }, pct],
  h2h: ['h2h', 'Egymás elleni eredmények', 'h2h', 0.3, (h, a, m) => {
    const x = m.h2h; if (!x || !x.n) return null;
    const share = (x.homeWins + 0.5 * (x.draws || 0)) / x.n;
    return { diff: sc(share - 0.5, 0.35) * Math.min(1, x.n / 6), home: x.homeWins, away: x.awayWins, extra: { n: x.n, draws: x.draws || 0 } };
  }, int],
  rest: ['rest', 'Pihenőnapok', 'schedule', 0.5, (h, a) => both(h, a, 'restDays') && { diff: sc(Math.min(h.restDays, 4) - Math.min(a.restDays, 4), 3), home: h.restDays, away: a.restDays }, int],
  b2b: ['b2b', 'Back-to-back terhelés', 'schedule', 0.5, (h, a) => typeof h?.backToBack === 'boolean' && typeof a?.backToBack === 'boolean' && { diff: (a.backToBack ? 0.6 : 0) - (h.backToBack ? 0.6 : 0), home: h.backToBack ? 'igen' : 'nem', away: a.backToBack ? 'igen' : 'nem' }, String],
  congestion: ['congestion', 'Sűrű program / utazás', 'schedule', 0.3, (h, a) => both(h, a, 'gamesLast7') && { diff: sc((a.gamesLast7 - h.gamesLast7) + ((a.travelKm || 0) - (h.travelKm || 0)) / 2500, 3), home: h.gamesLast7, away: a.gamesLast7, extra: { travelHome: h.travelKm, travelAway: a.travelKm } }, int],
  injuries: ['injuries', 'Sérülések, eltiltások', 'injuries', 0.9, (h, a) => {
    const ih = injuryLoad(h?.injuries), ia = injuryLoad(a?.injuries);
    return ih != null && ia != null && { diff: sc(ia - ih, 1.2), home: ih, away: ia, extra: { home: h.injuries, away: a.injuries } };
  }, n2],
};

const SPORT_FACTORS = {
  nba: [
    COMMON.strength, COMMON.form, COMMON.momentum, COMMON.venue, COMMON.h2h, COMMON.rest, COMMON.b2b, COMMON.congestion, COMMON.injuries,
    ['netRtg', 'Nettó értékelés (Net Rating)', 'advanced', 1.6, (h, a) => both(h, a, 'netRtg') && { diff: sc(h.netRtg - a.netRtg, 10), home: h.netRtg, away: a.netRtg }, n1],
    ['ts', 'True Shooting %', 'advanced', 0.5, (h, a) => both(h, a, 'ts') && { diff: sc(h.ts - a.ts, 0.04), home: h.ts, away: a.ts }, pct],
    ['drtg', 'Védekezési értékelés (alacsonyabb a jobb)', 'advanced', 0.5, (h, a) => both(h, a, 'drtg') && { diff: sc(a.drtg - h.drtg, 6), home: h.drtg, away: a.drtg }, n1],
    ['pace', 'Tempó (birtoklás/48 perc)', 'advanced', 0.0, (h, a) => both(h, a, 'pace') && { diff: 0, home: h.pace, away: a.pace }, n1],
    ['usage', 'Sztárfüggőség (top játékos usage)', 'advanced', 0.2, (h, a) => both(h, a, 'usageTop') && { diff: sc(a.usageTop - h.usageTop, 0.1), home: h.usageTop, away: a.usageTop }, pct],
  ],
  nhl: [
    COMMON.strength, COMMON.form, COMMON.momentum, COMMON.venue, COMMON.h2h, COMMON.rest, COMMON.b2b, COMMON.congestion, COMMON.injuries,
    ['corsi', 'Corsi (CF%)', 'advanced', 0.8, (h, a) => both(h, a, 'cfPct') && { diff: sc(h.cfPct - a.cfPct, 0.06), home: h.cfPct, away: a.cfPct }, pct],
    ['fenwick', 'Fenwick (FF%)', 'advanced', 0.4, (h, a) => both(h, a, 'ffPct') && { diff: sc(h.ffPct - a.ffPct, 0.06), home: h.ffPct, away: a.ffPct }, pct],
    ['pdo', 'PDO (szerencse-index, regresszió 1.000 felé)', 'advanced', 0.3, (h, a) => both(h, a, 'pdo') && { diff: sc((a.pdo - 1) - (h.pdo - 1), 0.03), home: h.pdo, away: a.pdo }, n3],
    ['goalie', 'Kapus védési % (várható kezdő)', 'advanced', 1.0, (h, a) => both(h, a, 'goalieSv') && { diff: sc(h.goalieSv - a.goalieSv, 0.015) * ((h.starterConfirmed && a.starterConfirmed) ? 1 : 0.7), home: h.goalieSv, away: a.goalieSv, extra: { homeGoalie: h.goalieName, awayGoalie: a.goalieName, homeConfirmed: h.starterConfirmed, awayConfirmed: a.starterConfirmed } }, n3],
    ['goalDiff', 'Gólkülönbség / meccs', 'advanced', 0.9, (h, a) => both(h, a, 'gfPg') && both(h, a, 'gaPg') && { diff: sc((h.gfPg - h.gaPg) - (a.gfPg - a.gaPg), 1), home: h.gfPg - h.gaPg, away: a.gfPg - a.gaPg }, n2],
  ],
  tennis: [
    COMMON.form, COMMON.h2h,
    ['elo', 'Elo-pontszám (összesített)', 'advanced', 1.4, (h, a) => both(h, a, 'elo') && { diff: sc(h.elo - a.elo, 200), home: h.elo, away: a.elo }, int],
    ['eloSurface', 'Borításspecifikus Elo', 'advanced', 1.2, (h, a) => both(h, a, 'eloSurface') && { diff: sc(h.eloSurface - a.eloSurface, 200), home: h.eloSurface, away: a.eloSurface }, int],
    ['rank', 'Világranglista-helyezés', 'advanced', 0.6, (h, a) => both(h, a, 'rank') && { diff: sc(Math.log(a.rank) - Math.log(h.rank), 1.5), home: h.rank, away: a.rank }, int],
    ['surfaceWin', 'Győzelmi arány az adott borításon', 'advanced', 0.7, (h, a) => both(h, a, 'surfaceWinPct') && { diff: sc(h.surfaceWinPct - a.surfaceWinPct, 0.2), home: h.surfaceWinPct, away: a.surfaceWinPct }, pct],
    ['serve', 'Adogatójáték-nyerés %', 'advanced', 0.6, (h, a) => both(h, a, 'holdPct') && { diff: sc(h.holdPct - a.holdPct, 0.08), home: h.holdPct, away: a.holdPct }, pct],
    ['return', 'Fogadójáték-nyerés (brékarány) %', 'advanced', 0.6, (h, a) => both(h, a, 'breakPct') && { diff: sc(h.breakPct - a.breakPct, 0.08), home: h.breakPct, away: a.breakPct }, pct],
    ['load', 'Terhelés (meccsek az utolsó 14 napban)', 'schedule', 0.3, (h, a) => both(h, a, 'matchLoad14') && { diff: sc(a.matchLoad14 - h.matchLoad14, 5), home: h.matchLoad14, away: a.matchLoad14 }, int],
    ['retire', 'Feladott meccsek (12 hó)', 'injuries', 0.3, (h, a) => both(h, a, 'retirements12m') && { diff: sc(a.retirements12m - h.retirements12m, 2), home: h.retirements12m, away: a.retirements12m }, int],
    COMMON.injuries,
  ],
  football: [
    COMMON.strength, COMMON.form, COMMON.momentum, COMMON.venue, COMMON.h2h, COMMON.rest, COMMON.congestion, COMMON.injuries,
    ['xg', 'xG-különbség / meccs (xG − xGA)', 'advanced', 1.4, (h, a) => both(h, a, 'xgPg') && both(h, a, 'xgaPg') && { diff: sc((h.xgPg - h.xgaPg) - (a.xgPg - a.xgaPg), 1.2), home: h.xgPg - h.xgaPg, away: a.xgPg - a.xgaPg, extra: { hxg: h.xgPg, hxga: h.xgaPg, axg: a.xgPg, axga: a.xgaPg } }, n2],
    ['ppg', 'Pont / meccs', 'advanced', 1.0, (h, a) => both(h, a, 'ppg') && { diff: sc(h.ppg - a.ppg, 1), home: h.ppg, away: a.ppg }, n2],
    ['goals', 'Gólkülönbség / meccs', 'advanced', 0.8, (h, a) => both(h, a, 'gfPg') && both(h, a, 'gaPg') && { diff: sc((h.gfPg - h.gaPg) - (a.gfPg - a.gaPg), 1.2), home: h.gfPg - h.gaPg, away: a.gfPg - a.gaPg }, n2],
    ['possession', 'Labdabirtoklás %', 'advanced', 0.3, (h, a) => both(h, a, 'possession') && { diff: sc(h.possession - a.possession, 0.12), home: h.possession, away: a.possession }, pct],
    ['position', 'Tabellahely', 'advanced', 0.4, (h, a) => both(h, a, 'position') && { diff: sc(a.position - h.position, 10), home: h.position, away: a.position }, int],
    ['motivation', 'Motiváció (bajnoki cím, kiesés, tét nélküli meccs)', 'context', 0.4, (h, a) => both(h, a, 'motivation') && { diff: sc(h.motivation - a.motivation, 1), home: h.motivation, away: a.motivation, extra: { home: h.motivationLabel, away: a.motivationLabel } }, n2],
  ],
  handball: [
    COMMON.strength, COMMON.form, COMMON.momentum, COMMON.venue, COMMON.h2h, COMMON.rest, COMMON.congestion, COMMON.injuries,
    ['goals', 'Gólkülönbség / meccs', 'advanced', 1.4, (h, a) => both(h, a, 'gfPg') && both(h, a, 'gaPg') && { diff: sc((h.gfPg - h.gaPg) - (a.gfPg - a.gaPg), 6), home: h.gfPg - h.gaPg, away: a.gfPg - a.gaPg }, n1],
    ['ppg', 'Pont / meccs', 'advanced', 0.9, (h, a) => both(h, a, 'ppg') && { diff: sc(h.ppg - a.ppg, 0.9), home: h.ppg, away: a.ppg }, n2],
    ['position', 'Tabellahely', 'advanced', 0.4, (h, a) => both(h, a, 'position') && { diff: sc(a.position - h.position, 8), home: h.position, away: a.position }, int],
    ['motivation', 'Motiváció (bajnoki cím, kiesés, tét nélküli meccs)', 'context', 0.3, (h, a) => both(h, a, 'motivation') && { diff: sc(h.motivation - a.motivation, 1), home: h.motivation, away: a.motivation, extra: { home: h.motivationLabel, away: a.motivationLabel } }, n2],
  ],
};

/** Market movement factor: drift of the home price from open to now (shortening = market likes home). */
function marketFactor(match) {
  const mv = match.movement;
  if (!mv || !isNum(mv.homeOpen) || !isNum(mv.homeNow)) return null;
  const drift = (1 / mv.homeNow) - (1 / mv.homeOpen); // change of implied prob
  return { key: 'market', label: 'Piaci mozgás (nyitó → aktuális szorzó)', group: 'market', weight: 0.4, available: true,
    diff: sc(drift, 0.06), home: mv.homeOpen, away: mv.homeNow, fmt: n2,
    extra: { openedAt: mv.openedAt, updatedAt: mv.updatedAt } };
}

export function buildFactors(match) {
  const defs = SPORT_FACTORS[match.sport] || [];
  const h = match.stats?.home || {}; const a = match.stats?.away || {};
  const out = defs.map(([key, label, group, weight, fn, fmt]) => {
    let r = null;
    try { r = fn(h, a, match) || null; } catch { r = null; }
    const meta = match.meta?.[group] || match.meta?.stats || null;
    return r
      ? { key, label, group, weight, available: true, diff: r.diff, home: r.home, away: r.away, extra: r.extra, fmt, src: meta }
      : { key, label, group, weight, available: false, diff: 0, home: null, away: null, fmt, src: null };
  });
  const mf = marketFactor(match);
  out.push(mf ? { ...mf, src: match.meta?.odds || null } : { key: 'market', label: 'Piaci mozgás (nyitó → aktuális szorzó)', group: 'market', weight: 0.4, available: false, diff: 0, fmt: n2, src: null });
  return out;
}

/** Share of model weight that is backed by data (0..1). */
export function coverage(factors) {
  const tot = factors.reduce((s, f) => s + f.weight, 0);
  const av = factors.filter((f) => f.available).reduce((s, f) => s + f.weight, 0);
  return tot ? av / tot : 0;
}

/** Serialisable copy for the API (functions removed, values formatted). */
export function publicFactors(factors) {
  return factors.map((f) => ({
    key: f.key, label: f.label, group: f.group, weight: f.weight, available: f.available,
    diff: Math.round(f.diff * 1000) / 1000,
    home: f.available ? (f.fmt ? f.fmt(f.home) : f.home) : null,
    away: f.available ? (f.fmt ? f.fmt(f.away) : f.away) : null,
    extra: f.extra, src: f.src,
  }));
}
