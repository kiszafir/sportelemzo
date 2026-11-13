// Backtesting: replay finished matches as if they were upcoming, compare the
// model's pre-match probabilities with the actual outcomes.
//   Accuracy  = share of matches where the favourite (p > 0.5 / argmax) won
//   Brier     = mean (p − y)²              (lower is better, 0.25 = coin flip for 2-way)
//   Log loss  = −mean(y·ln p + (1−y)·ln(1−p))
//   ROI       = Σ profit / Σ stake for value tips at flat 1-unit stakes
// Also re-fits the NBA/NHL logistic regression on the first 70 % (chronological)
// and reports out-of-sample log loss for default vs. fitted coefficients.
import { analyzeMatch } from './analyze.js';
import { buildFactors } from './features.js';
import { settleSelection } from './settle.js';
import { fit, vectorize, predictLogit, DEFAULT_COEF, coefFor } from './models/logistic.js';
import { sigmoid } from './mathutil.js';
import { mockOdds } from '../providers/mock.js';

const preView = (m) => ({ ...m, status: 'pre', live: null, home: { ...m.home, score: null, sets: undefined }, away: { ...m.away, score: null, sets: undefined } });

function homeOutcome(m) {
  const h = m.home.sets ?? m.home.score; const a = m.away.sets ?? m.away.score;
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (m.sport === 'football') return h > a ? 'home' : h < a ? 'away' : 'draw';
  return h > a ? 'home' : 'away';
}

export function runBacktest(finished, { withMockOdds = true } = {}) {
  const rows = [];
  for (const fin of finished) {
    if (fin.status !== 'post') continue;
    const y = homeOutcome(fin); if (!y) continue;
    const pre = preView(fin);
    let a = analyzeMatch(pre);
    if (withMockOdds && fin.provider === 'mock') { const o = mockOdds(pre, a, Date.parse(fin.startTime) - 2 * 3600e3); pre.odds = o.odds; pre.movement = o.movement; a = analyzeMatch(pre); }
    const main = a.markets[0];
    const probs = Object.fromEntries(main.selections.map((s) => [s.key, s.p]));
    const tip = a.tip;
    const tipRes = tip ? settleSelection(fin, tip.market, tip.selection, a.markets.find((m) => m.key === tip.market)?.line) : null;
    rows.push({ id: fin.id, sport: fin.sport, t: Date.parse(fin.startTime), y, probs, tip, tipRes, factors: buildFactors(pre) });
  }
  const bySport = {};
  for (const r of rows) (bySport[r.sport] ||= []).push(r);
  const metrics = Object.fromEntries(Object.entries(bySport).map(([s, rs]) => [s, metricsFor(rs)]));
  return { n: rows.length, overall: metricsFor(rows), bySport: metrics, logistic: refitLogistic(bySport) };
}

function metricsFor(rows) {
  let acc = 0, brier = 0, ll = 0, n = 0, homeBase = 0;
  let stake = 0, profit = 0, tipsWon = 0, tipsSettled = 0;
  for (const r of rows) {
    const keys = Object.keys(r.probs);
    const pick = keys.reduce((b, k) => (r.probs[k] > r.probs[b] ? k : b), keys[0]);
    acc += pick === r.y ? 1 : 0; homeBase += r.y === 'home' ? 1 : 0;
    for (const k of keys) brier += (r.probs[k] - (k === r.y ? 1 : 0)) ** 2 / 2; // binary case = (p − y)²
    ll += -Math.log(Math.max(1e-9, r.probs[r.y] ?? 1e-9));
    n++;
    if (r.tip && r.tip.kind === 'value' && (r.tipRes === 'won' || r.tipRes === 'lost')) {
      stake += 1; profit += r.tipRes === 'won' ? r.tip.odds - 1 : -1; tipsSettled++; if (r.tipRes === 'won') tipsWon++;
    }
  }
  return {
    n, accuracy: n ? acc / n : null, homeBaseline: n ? homeBase / n : null, brier: n ? brier / n : null, logLoss: n ? ll / n : null,
    valueTips: tipsSettled, valueHitRate: tipsSettled ? tipsWon / tipsSettled : null, valueRoi: stake ? profit / stake : null,
  };
}

function refitLogistic(bySport) {
  const out = {};
  for (const sport of ['nba', 'nhl']) {
    const rs = (bySport[sport] || []).slice().sort((a, b) => a.t - b.t);
    if (rs.length < 60) { out[sport] = { skipped: true, reason: 'Kevés adat (min. 60 meccs).' }; continue; }
    const data = rs.map((r) => ({ x: vectorize(r.factors), y: r.y === 'home' ? 1 : 0 }));
    const cut = Math.floor(data.length * 0.7);
    const train = data.slice(0, cut); const test = data.slice(cut);
    const coef = fit(train, { init: { ...DEFAULT_COEF[sport] }, lr: 0.2, epochs: 500, l2: 0.02 });
    const ll = (c) => test.reduce((s, d) => { const p = sigmoid(predictLogit(c, d.x)); return s - (d.y * Math.log(p) + (1 - d.y) * Math.log(1 - p)); }, 0) / test.length;
    out[sport] = { train: train.length, test: test.length, logLossCurrent: ll(coefFor(sport)), logLossDefault: ll(DEFAULT_COEF[sport]), logLossFitted: ll(coef), coef };
  }
  return out;
}
