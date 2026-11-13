// Logistic regression for NBA and NHL winner (two-way, incl. overtime).
//   p_home = σ(β0 + Σ β_j · x_j)    where x_j are the normalised factor diffs.
// Default coefficients are hand-set priors; `fit()` re-estimates them from
// historical rows (used by the backtest module, results saved to data/models.json).
import fs from 'node:fs';
import path from 'node:path';
import { sigmoid } from '../mathutil.js';
import { config } from '../../config.js';

export const DEFAULT_COEF = {
  nba: { intercept: 0.25, strength: 0.55, form: 0.3, momentum: 0.1, netRtg: 0.9, ts: 0.15, drtg: 0.15, rest: 0.15, b2b: 0.3, injuries: 0.4, venue: 0.2, h2h: 0.05, usage: 0.05, congestion: 0.1, market: 0.3 },
  nhl: { intercept: 0.15, strength: 0.4, form: 0.25, momentum: 0.08, goalDiff: 0.45, goalie: 0.35, corsi: 0.25, fenwick: 0.08, pdo: 0.1, injuries: 0.25, b2b: 0.2, rest: 0.1, venue: 0.15, h2h: 0.05, congestion: 0.08, market: 0.3 },
};

const MODEL_FILE = path.join(config.dataDir, 'models.json');
let trained = {};
try { if (fs.existsSync(MODEL_FILE)) trained = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')).logistic || {}; } catch { trained = {}; }

export const coefFor = (sport) => trained[sport]?.coef || DEFAULT_COEF[sport];

export function vectorize(factors) {
  const x = {};
  for (const f of factors) x[f.key] = f.available ? f.diff : 0;
  return x;
}

export function predictLogit(coef, x) {
  let z = coef.intercept || 0;
  for (const [k, b] of Object.entries(coef)) if (k !== 'intercept') z += b * (x[k] || 0);
  return z;
}

/**
 * Batch gradient descent with L2 regularisation.
 * rows: [{ x: {key: diff}, y: 0|1 }]
 */
export function fit(rows, { init, lr = 0.1, epochs = 400, l2 = 0.01 } = {}) {
  const coef = { ...(init || { intercept: 0 }) };
  const keys = Object.keys(coef);
  for (let e = 0; e < epochs; e++) {
    const grad = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const { x, y } of rows) {
      const err = sigmoid(predictLogit(coef, x)) - y;
      for (const k of keys) grad[k] += err * (k === 'intercept' ? 1 : (x[k] || 0));
    }
    for (const k of keys) coef[k] -= lr * (grad[k] / rows.length + (k === 'intercept' ? 0 : l2 * coef[k]));
  }
  return coef;
}

export function saveTrained(sport, coef, metrics) {
  trained[sport] = { coef, metrics, trainedAt: new Date().toISOString() };
  let file = {};
  try { if (fs.existsSync(MODEL_FILE)) file = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')); } catch { file = {}; }
  file.logistic = trained;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify(file, null, 2));
}

export const logisticModel = {
  id: 'logistic',
  name: 'Logisztikus regresszió',
  sports: ['nba', 'nhl'],
  predict(match, factors) {
    const coef = coefFor(match.sport);
    const x = vectorize(factors);
    const contributions = Object.entries(coef).filter(([k]) => k !== 'intercept' && x[k]).map(([k, b]) => ({ key: k, c: b * x[k] }));
    return { pHome: sigmoid(predictLogit(coef, x)), contributions, trained: !!trained[match.sport] };
  },
};
