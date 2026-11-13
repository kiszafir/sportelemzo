import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainCalibrator, adjustMarket, ridgeLogistic, solve, trainFactors, predict, MIN_ROWS } from '../server/engine/ai.js';
import { rng } from '../server/engine/mathutil.js';
import { analyzeMatch } from '../server/engine/analyze.js';
import { mockMatches, mockOdds } from '../server/providers/mock.js';

const sig = (z) => 1 / (1 + Math.exp(-z)); const lg = (p) => Math.log(p / (1 - p));

function synth(n, { overconf = 1, seed = 1, market = false } = {}) {
  const r = rng(seed); const rows = [];
  for (let i = 0; i < n; i++) {
    const z = (r() * 2 - 1) * 2;               // true logit
    const pTrue = sig(z);
    // model: over-confident if overconf > 1; with a market present the model is also noisier
    const pm = sig((z + (market ? (r() - 0.5) * 2.4 : 0)) * overconf);
    const pk = market ? sig(z + (r() - 0.5) * 0.3) : null; // market: better informed
    rows.push({ t: i, pm, pk, y: r() < pTrue ? 1 : 0 });
  }
  return rows;
}

test('linear solver', () => {
  const x = solve([[2, 1], [1, 3]], [3, 5]);
  assert.ok(Math.abs(x[0] - 0.8) < 1e-9 && Math.abs(x[1] - 1.4) < 1e-9);
});

test('ridge logistic recovers a known slope', () => {
  const r = rng(3); const X = []; const y = [];
  for (let i = 0; i < 4000; i++) { const x = r() * 4 - 2; X.push([1, x]); y.push(r() < sig(0.5 + 1.2 * x) ? 1 : 0); }
  const b = ridgeLogistic(X, y, [0, 0], 1);
  assert.ok(Math.abs(b[0] - 0.5) < 0.15 && Math.abs(b[1] - 1.2) < 0.15, JSON.stringify(b));
});

test('calibrator stays off until enough data', () => {
  const res = trainCalibrator(synth(MIN_ROWS - 1, { overconf: 2 }));
  assert.equal(res.active, false); assert.equal(res.reason, 'collecting');
});

test('calibrator fixes an over-confident model and activates', () => {
  const res = trainCalibrator(synth(1500, { overconf: 2, seed: 7 }));
  assert.equal(res.active, true);
  assert.ok(res.metrics.llAi < res.metrics.llRaw - 0.01, `${res.metrics.llRaw} → ${res.metrics.llAi}`);
  assert.ok(res.beta[1] > 0.3 && res.beta[1] < 0.7, `slope ≈ 0.5, got ${res.beta[1]}`); // undo the doubling
});

test('calibrator does not activate on a well-calibrated model', () => {
  const res = trainCalibrator(synth(1500, { overconf: 1, seed: 11 }));
  assert.equal(res.active, false); assert.equal(res.reason, 'no-gain');
});

test('calibrator learns to trust a better market', () => {
  const res = trainCalibrator(synth(3000, { overconf: 1.8, seed: 5, market: true }));
  assert.equal(res.active, true);
  assert.ok(res.beta[2] > res.beta[1], `market weight ${res.beta[2]} > model weight ${res.beta[1]}`);
});

test('adjusted markets stay probability distributions', () => {
  const beta = [0.1, 0.6, 0.3, 0];
  const two = adjustMarket(beta, [{ p: 0.7, pk: 0.65 }, { p: 0.3, pk: 0.35 }]);
  assert.ok(Math.abs(two[0] + two[1] - 1) < 1e-12);
  const three = adjustMarket(beta, [{ p: 0.5, pk: 0.48 }, { p: 0.25, pk: 0.27 }, { p: 0.25, pk: 0.25 }]);
  assert.ok(Math.abs(three.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(predict([0, 1, 0, 0], { pm: 0.63, pk: null }) - 0.63) < 1e-9, 'prior = identity');
});

test('factor learner ranks the truly predictive factor first', () => {
  const r = rng(9); const rows = [];
  for (let i = 0; i < 1500; i++) { const x = { a: r() * 2 - 1, b: r() * 2 - 1, c: r() * 2 - 1 }; rows.push({ x, y: r() < sig(1.5 * x.b) ? 1 : 0 }); }
  const f = trainFactors(rows, ['a', 'b', 'c']);
  assert.equal(f.importance[0].key, 'b');
});

test('analysis applies the AI adjuster pre-match only and keeps raw values', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const m = mockMatches({ now, leagues: ['epl'] }).find((x) => x.status === 'pre');
  const a0 = analyzeMatch(m); const o = mockOdds(m, a0, now); m.odds = o.odds;
  const shrink = (family, sels) => (family === 'result' ? adjustMarket([0, 0.5, 0, 0], sels) : null);
  const a = analyzeMatch(m, { adjust: shrink });
  assert.equal(a.ai.applied, true);
  const x = a.markets.find((k) => k.key === '1x2'); const dc = a.markets.find((k) => k.key === 'dc');
  assert.ok(x.selections.every((s) => s.pRaw != null));
  assert.ok(Math.abs(x.selections.reduce((t, s) => t + s.p, 0) - 1) < 1e-3);
  const P = Object.fromEntries(x.selections.map((s) => [s.key, s.p]));
  assert.ok(Math.abs(dc.selections.find((s) => s.key === '1x').p - (P.home + P.draw)) < 1e-3, 'double chance rebuilt from adjusted 1X2');
  assert.ok(a.markets.filter((k) => k.family === 'totals').every((k) => k.selections.every((s) => s.pRaw == null)), 'inactive families untouched');
  const live = { ...m, status: 'live', live: { minute: 10, elapsedMin: 10 }, home: { ...m.home, score: 0 }, away: { ...m.away, score: 0 } };
  assert.equal(analyzeMatch(live, { adjust: shrink }).ai.applied, false);
});
