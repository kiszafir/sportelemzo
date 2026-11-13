// Odds mathematics. All odds are DECIMAL (e.g. 1.85). Probabilities are in [0,1].
// Formulas are documented in the README and on the "Módszertan" page.

export const clampProb = (p, lo = 1e-6, hi = 1 - 1e-6) => Math.min(hi, Math.max(lo, p));

/** Implied probability of decimal odds: 1 / o */
export function impliedProb(odds) {
  if (!(odds > 1)) throw new RangeError('decimal odds must be > 1');
  return 1 / odds;
}

/** Bookmaker margin (overround): Σ(1/o_i) − 1 */
export function overround(oddsList) {
  return oddsList.reduce((s, o) => s + impliedProb(o), 0) - 1;
}

/** Proportional (basic normalisation) vig removal: p_i = q_i / Σq */
export function devigProportional(oddsList) {
  const q = oddsList.map(impliedProb);
  const sum = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / sum);
}

/**
 * Shin (1992/1993) vig removal. Models the margin as protection against insider
 * traders (proportion z). For a given z:
 *   p_i = ( sqrt(z² + 4(1−z)·q_i²/B) − z ) / ( 2(1−z) ),   B = Σ q_i
 * z is found by bisection so that Σ p_i = 1. Reduces favourite–longshot bias
 * compared with proportional normalisation.
 */
export function devigShin(oddsList, { tol = 1e-12, maxIter = 200 } = {}) {
  const q = oddsList.map(impliedProb);
  const B = q.reduce((a, b) => a + b, 0);
  if (B <= 1) return { probs: q.map((x) => x / B), z: 0 }; // no margin: nothing to remove
  const probsFor = (z) => q.map((qi) => (Math.sqrt(z * z + (4 * (1 - z) * qi * qi) / B) - z) / (2 * (1 - z)));
  const sumFor = (z) => probsFor(z).reduce((a, b) => a + b, 0);
  let lo = 0, hi = 0.999;
  // sumFor(0) = Σq/√B = √B > 1 ; sumFor decreases as z grows.
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    if (sumFor(mid) > 1) lo = mid; else hi = mid;
    if (hi - lo < tol) break;
  }
  const z = (lo + hi) / 2;
  const probs = probsFor(z);
  const s = probs.reduce((a, b) => a + b, 0);
  return { probs: probs.map((p) => p / s), z };
}

export function devig(oddsList, method = 'shin') {
  return method === 'proportional' ? devigProportional(oddsList) : devigShin(oddsList).probs;
}

/** Fair (zero-margin) odds from a probability: 1 / p */
export const fairOdds = (p) => 1 / clampProb(p);

/** Expected value per 1 unit staked: EV = p·o − 1 */
export const expectedValue = (p, odds) => p * odds - 1;

/** Kelly fraction of bankroll: f* = (p·o − 1) / (o − 1), floored at 0 */
export function kelly(p, odds) {
  if (!(odds > 1)) return 0;
  return Math.max(0, (p * odds - 1) / (odds - 1));
}

/**
 * Fractional Kelly stake with a hard cap and an optional remaining-limit cap.
 * stake = min( bankroll · min(fraction·f*, cap), remainingLimit )
 */
export function kellyStake({ p, odds, bankroll, fraction = 0.25, cap = 0.05, remainingLimit = Infinity }) {
  const f = kelly(p, odds);
  const share = Math.min(fraction * f, cap);
  const stake = Math.max(0, Math.min(bankroll * share, remainingLimit));
  return { fullKelly: f, share, stake: Math.floor(stake), capped: fraction * f > cap, limited: bankroll * share > remainingLimit };
}

/** American moneyline → decimal */
export function americanToDecimal(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

/** Product of decimal odds */
export const combineOdds = (list) => list.reduce((a, b) => a * b, 1);

export const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
