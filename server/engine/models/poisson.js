// Poisson goal model (football), with Dixon–Coles low-score correction.
//   λ_home = μ · att_home · def_away · H,   λ_away = μ · att_away · def_home / H
//   att = scored per game / μ,  def = conceded per game / μ  (xG blended 50/50 when available)
//   P(i,j) = Pois(i; λ_h) · Pois(j; λ_a) · τ(i,j)
// Also used for NHL totals (no τ correction).
import { poissonPmf, clamp } from '../mathutil.js';

const MU_FOOTBALL = 1.37; // average goals per team per match in top leagues
const HOME_MULT = 1.12;
const DC_RHO = -0.06;

function tau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

/** Score matrix P[i][j] for home i goals, away j goals (normalised). */
export function scoreMatrix(lh, la, { maxGoals = 10, rho = DC_RHO, offsetH = 0, offsetA = 0 } = {}) {
  const ph = poissonPmf(lh, maxGoals); const pa = poissonPmf(la, maxGoals);
  const M = []; let tot = 0;
  for (let i = 0; i <= maxGoals; i++) {
    M[i] = [];
    for (let j = 0; j <= maxGoals; j++) {
      const t = (offsetH === 0 && offsetA === 0) ? tau(i, j, lh, la, rho) : 1;
      M[i][j] = Math.max(0, ph[i] * pa[j] * t); tot += M[i][j];
    }
  }
  for (let i = 0; i <= maxGoals; i++) for (let j = 0; j <= maxGoals; j++) M[i][j] /= tot;
  return { M, offsetH, offsetA };
}

/** Aggregate a score matrix into common markets. Offsets = goals already scored (live). */
export function marketsFromMatrix({ M, offsetH = 0, offsetA = 0 }, totalsLines = [1.5, 2.5, 3.5]) {
  let home = 0, draw = 0, away = 0, btts = 0;
  const over = Object.fromEntries(totalsLines.map((l) => [l, 0]));
  const n = M.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = M[i][j]; const gh = i + offsetH; const ga = j + offsetA;
    if (gh > ga) home += p; else if (gh === ga) draw += p; else away += p;
    if (gh > 0 && ga > 0) btts += p;
    for (const l of totalsLines) if (gh + ga > l) over[l] += p;
  }
  return { home, draw, away, btts, over };
}

/** Expected goals for a football match from team stats and adjustment factors. */
export function footballLambdas(match, factors, weightedScore) {
  const h = match.stats?.home || {}; const a = match.stats?.away || {};
  const has = (t) => Number.isFinite(t.gfPg) && Number.isFinite(t.gaPg);
  let lh, la;
  const notes = [];
  if (has(h) && has(a)) {
    const blend = (g, xg) => (Number.isFinite(xg) ? 0.5 * g + 0.5 * xg : g);
    // Shrink ratings towards the league average for small samples: k = gp / (gp + 6)
    const shrink = (x, gp) => { const k = (gp || 10) / ((gp || 10) + 6); return 1 + k * (x - 1); };
    const attH = shrink(blend(h.gfPg, h.xgPg) / MU_FOOTBALL, h.gamesPlayed); const defH = shrink(blend(h.gaPg, h.xgaPg) / MU_FOOTBALL, h.gamesPlayed);
    const attA = shrink(blend(a.gfPg, a.xgPg) / MU_FOOTBALL, a.gamesPlayed); const defA = shrink(blend(a.gaPg, a.xgaPg) / MU_FOOTBALL, a.gamesPlayed);
    lh = MU_FOOTBALL * attH * defA * HOME_MULT;
    la = MU_FOOTBALL * attA * defH / HOME_MULT;
  } else {
    // Fallback when goal stats are missing: derive from the weighted strength score.
    lh = 1.45 * Math.exp(0.45 * weightedScore);
    la = 1.15 * Math.exp(-0.45 * weightedScore);
    notes.push('Gólstatisztika hiányában az erősségi pontszámból becsülve.');
  }
  // Context multipliers (form, injuries, motivation) — small, documented effects.
  const f = Object.fromEntries(factors.map((x) => [x.key, x.available ? x.diff : 0]));
  const m = Math.exp(0.08 * f.form + 0.1 * f.injuries + 0.06 * f.motivation + 0.04 * f.rest);
  lh *= m; la /= m;
  // Weather: strong wind or heavy rain lowers scoring a little; altitude helps the home side.
  const w = match.weather;
  if (w && !match.venue?.indoor) {
    if ((w.windKmh ?? 0) > 35 || (w.precipMm ?? 0) > 4) { lh *= 0.94; la *= 0.94; notes.push('Időjárás: erős szél/eső → kevesebb gól várható.'); }
  }
  if ((match.venue?.altitude ?? 0) > 1500) { lh *= 1.05; notes.push('Magaslati helyszín: enyhe hazai előny.'); }
  return { lh: clamp(lh, 0.2, 3.8), la: clamp(la, 0.2, 3.8), notes };
}

/** Live adjustment: remaining expected goals given minute and red cards. */
export function liveFootball(lh, la, live) {
  const minute = Math.min(95, live.minute ?? 0);
  const r = Math.max(0.02, (93 - minute) / 93); // ~3 min stoppage
  let mh = 1, ma = 1;
  const rh = live.redCards?.home || 0; const ra = live.redCards?.away || 0;
  mh *= 0.7 ** rh * 1.2 ** ra; ma *= 0.7 ** ra * 1.2 ** rh;
  return scoreMatrix(lh * r * mh, la * r * ma, { offsetH: live.scoreHome || 0, offsetA: live.scoreAway || 0, maxGoals: 8 });
}

export const NHL_MU = 3.05;
export function hockeyLambdas(match) {
  const h = match.stats?.home || {}; const a = match.stats?.away || {};
  if (![h.gfPg, h.gaPg, a.gfPg, a.gaPg].every(Number.isFinite)) return { lh: 3.2, la: 2.9, estimated: true };
  const lh = NHL_MU * (h.gfPg / NHL_MU) * (a.gaPg / NHL_MU) * 1.03;
  const la = NHL_MU * (a.gfPg / NHL_MU) * (h.gaPg / NHL_MU) / 1.03;
  return { lh: clamp(lh, 1.5, 5), la: clamp(la, 1.5, 5), estimated: false };
}

export const poissonModel = { id: 'poisson', name: 'Poisson gólmodell (Dixon–Coles)', sports: ['football'] };
