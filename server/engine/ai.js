// Local self-learning layer ("AI-motor"). Pure functions, no I/O.
//
// 1) Stacking calibrator per (data source, sport, market family):
//      p_AI = σ( b0 + bm·logit(p_model) + bk·logit(p_market)·[has market] + bh·[has market] )
//    Fitted by ridge-regularised Newton/IRLS with the prior centred on the
//    identity (bm = 1, everything else 0), so with little data it changes nothing.
//    It learns (a) calibration — is the model over/under-confident, biased
//    towards home/over — and (b) how much to trust the model vs. the market.
// 2) Factor learner per (source, sport): ridge logistic regression of "home win"
//    on the factor differences → which factors really predicted results.
// 3) A guard: parameters are only activated if, trained on the older 75 % of
//    the data, they beat the raw model on the newest 25 % (log loss).
// 4) Hungarian insights generated from the same statistics.

const EPS = 1e-6;
const clampP = (p) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export const MIN_ROWS = 80;          // rows needed before a calibrator may activate
export const MIN_GAIN = 0.002;       // required holdout log-loss improvement
export const PRIOR = [0, 1, 0, 0];   // [b0, bm, bk, bh] = identity

export const features = (r) => {
  const has = r.pk != null ? 1 : 0;
  return [1, logit(r.pm), has ? logit(r.pk) : 0, has];
};

export const predict = (beta, r) => sigmoid(features(r).reduce((s, x, i) => s + x * beta[i], 0));

/** Solve A·x = b (small dense system, Gaussian elimination with partial pivoting). */
export function solve(A, b) {
  const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/**
 * Ridge logistic regression by Newton/IRLS:
 *   minimise Σ logloss + (λ/2)·Σ (β − β0)²
 * X: rows of feature arrays, y: 0/1, prior: β0.
 */
export function ridgeLogistic(X, y, prior, lambda = 2, iters = 25) {
  const d = prior.length; let beta = [...prior];
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0); const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i]; const p = sigmoid(x.reduce((s, v, j) => s + v * beta[j], 0)); const w = Math.max(1e-6, p * (1 - p));
      for (let j = 0; j < d; j++) {
        g[j] += (p - y[i]) * x[j];
        for (let k = 0; k < d; k++) H[j][k] += w * x[j] * x[k];
      }
    }
    for (let j = 0; j < d; j++) { g[j] += lambda * (beta[j] - prior[j]); H[j][j] += lambda; }
    const step = solve(H, g);
    beta = beta.map((b, j) => b - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return beta;
}

export const logLoss = (ps, ys) => -ps.reduce((s, p, i) => s + (ys[i] ? Math.log(clampP(p)) : Math.log(1 - clampP(p))), 0) / ps.length;
export const brier = (ps, ys) => ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / ps.length;

/** Reliability bins (10 % wide). */
export function calibration(ps, ys, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, sumY: 0 }));
  ps.forEach((p, i) => { const b = out[Math.min(bins - 1, Math.floor(p * bins))]; b.n++; b.sumP += p; b.sumY += ys[i]; });
  return out.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, predicted: b.n ? b.sumP / b.n : null, actual: b.n ? b.sumY / b.n : null }));
}

/**
 * Train + validate one calibrator. rows: [{ t, pm, pk|null, y }] in any order.
 * Returns { active, beta, metrics, reason }.
 */
export function trainCalibrator(rows) {
  const n = rows.length;
  if (n < MIN_ROWS) return { active: false, beta: PRIOR, reason: 'collecting', metrics: { n, need: MIN_ROWS } };
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const cut = Math.floor(n * 0.75);
  const train = sorted.slice(0, cut); const test = sorted.slice(cut);
  const fit = (rs) => ridgeLogistic(rs.map(features), rs.map((r) => r.y), PRIOR, 2);
  const bTrain = fit(train);
  const yT = test.map((r) => r.y);
  const raw = test.map((r) => r.pm); const ai = test.map((r) => predict(bTrain, r));
  const llRaw = logLoss(raw, yT); const llAi = logLoss(ai, yT);
  const withMkt = rows.filter((r) => r.pk != null);
  const metrics = {
    n, train: train.length, test: test.length, marketShare: withMkt.length / n,
    llRaw, llAi, gain: llRaw - llAi, brierRaw: brier(raw, yT), brierAi: brier(ai, yT),
    llMarket: withMkt.length >= 30 ? logLoss(withMkt.map((r) => r.pk), withMkt.map((r) => r.y)) : null,
    llModelOnMarketRows: withMkt.length >= 30 ? logLoss(withMkt.map((r) => r.pm), withMkt.map((r) => r.y)) : null,
    calRaw: calibration(raw, yT), calAi: calibration(ai, yT),
    calAll: calibration(rows.map((r) => r.pm), rows.map((r) => r.y)),
  };
  if (test.length < 20 || llRaw - llAi < MIN_GAIN) return { active: false, beta: PRIOR, reason: 'no-gain', metrics };
  const beta = fit(sorted); // refit on everything once validated
  return { active: true, beta, reason: 'ok', metrics };
}

/** How much the fitted calibrator trusts the model vs the market (for display). */
export function interpret(beta) {
  const [, bm, bk] = beta;
  const tot = Math.max(1e-9, Math.abs(bm) + Math.abs(bk));
  return { modelShare: Math.abs(bm) / tot, marketShare: Math.abs(bk) / tot, sharpness: bm + bk, intercept: beta[0] };
}

/**
 * Apply a calibrator to one market's selections (raw probabilities + market
 * no-vig probabilities). Two-way markets adjust the first outcome and mirror
 * it; multi-way markets adjust each outcome and renormalise.
 */
export function adjustMarket(beta, sels) {
  if (sels.length === 2) {
    const p = predict(beta, { pm: sels[0].p, pk: sels[0].pk });
    return [p, 1 - p];
  }
  const ps = sels.map((s) => predict(beta, { pm: s.p, pk: s.pk }));
  const sum = ps.reduce((a, b) => a + b, 0);
  return ps.map((p) => p / sum);
}

/** Factor learner: which factors predicted home wins. rows: [{ x:{key:diff}, y }] */
export function trainFactors(rows, keys) {
  if (rows.length < 60 || !keys.length) return null;
  const X = rows.map((r) => [1, ...keys.map((k) => r.x[k] || 0)]);
  const y = rows.map((r) => r.y);
  const beta = ridgeLogistic(X, y, new Array(keys.length + 1).fill(0), 8);
  const sd = keys.map((k, j) => { const v = X.map((x) => x[j + 1]); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); });
  const importance = keys.map((k, j) => ({ key: k, coef: beta[j + 1], importance: beta[j + 1] * sd[j], used: sd[j] > 1e-6 }))
    .filter((f) => f.used).sort((a, b) => Math.abs(b.importance) - Math.abs(a.importance));
  return { n: rows.length, intercept: beta[0], importance };
}
