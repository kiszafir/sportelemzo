// Tennis: surface-blended Elo.
//   E = 0.5 · Elo_overall + 0.5 · Elo_surface
//   p1 = 1 / (1 + 10^((E2 − E1) / 400))
// Match → set probability: solve p = s²(3 − 2s) (best of 3) or
//   p = s³(1 + 3(1−s) + 6(1−s)²) (best of 5) for s by bisection.
import { clamp } from '../mathutil.js';

export const eloExpected = (e1, e2) => 1 / (1 + 10 ** ((e2 - e1) / 400));

/** Standard Elo update with K-factor (used for mock history / backtests). */
export function eloUpdate(e1, e2, result1, k = 32) {
  const exp = eloExpected(e1, e2);
  return [e1 + k * (result1 - exp), e2 + k * ((1 - result1) - (1 - exp))];
}

export const matchFromSet = (s, bestOf = 3) => (bestOf === 5 ? s ** 3 * (1 + 3 * (1 - s) + 6 * (1 - s) ** 2) : s * s * (3 - 2 * s));

export function setFromMatch(p, bestOf = 3) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (matchFromSet(mid, bestOf) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** P(player 1 wins match) given sets already won (a, b), set win prob s. */
export function matchFromState(s, a, b, bestOf = 3) {
  const need = Math.ceil(bestOf / 2);
  const memo = new Map();
  const f = (x, y) => {
    if (x >= need) return 1; if (y >= need) return 0;
    const key = x * 10 + y; if (memo.has(key)) return memo.get(key);
    const v = s * f(x + 1, y) + (1 - s) * f(x, y + 1); memo.set(key, v); return v;
  };
  return f(a, b);
}

export function tennisProbs(match) {
  const h = match.stats?.home || {}; const a = match.stats?.away || {};
  const e = (p) => (Number.isFinite(p.eloSurface) && Number.isFinite(p.elo) ? 0.5 * p.elo + 0.5 * p.eloSurface : Number.isFinite(p.elo) ? p.elo : Number.isFinite(p.rank) ? 2100 - 140 * Math.log(p.rank) : null);
  const e1 = e(h), e2 = e(a);
  if (e1 == null || e2 == null) return null;
  let p = eloExpected(e1, e2);
  // Fatigue / retirement-risk nudges (small, documented on the methodology page).
  const load = (Number(a.matchLoad14) || 0) - (Number(h.matchLoad14) || 0);
  p = clamp(p + 0.005 * load, 0.02, 0.98);
  return { p, e1, e2 };
}

export const eloModel = { id: 'elo', name: 'Borításfüggő Elo', sports: ['tennis'] };
