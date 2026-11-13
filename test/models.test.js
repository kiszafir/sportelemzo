import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatrix, marketsFromMatrix } from '../server/engine/models/poisson.js';
import { setFromMatch, matchFromSet, matchFromState, eloExpected } from '../server/engine/models/elo.js';
import { fit, predictLogit } from '../server/engine/models/logistic.js';
import { normCdf, normInv, sigmoid, rng } from '../server/engine/mathutil.js';
import { analyzeMatch, confidenceScore } from '../server/engine/analyze.js';
import { settleSelection } from '../server/engine/settle.js';
import { mockMatches, mockOdds } from '../server/providers/mock.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('Poisson score matrix is a probability distribution and 1X2 sums to 1', () => {
  const mat = scoreMatrix(1.6, 1.1);
  const m = marketsFromMatrix(mat);
  close(m.home + m.draw + m.away, 1, 1e-9);
  assert.ok(m.home > m.away);
  assert.ok(m.over[1.5] > m.over[2.5] && m.over[2.5] > m.over[3.5]);
});

test('Poisson live offsets: a 2-0 lead with little time left is almost a win', () => {
  const m = marketsFromMatrix(scoreMatrix(0.05, 0.05, { offsetH: 2, offsetA: 0, rho: 0 }));
  assert.ok(m.home > 0.99);
  assert.ok(m.over[1.5] > 0.999);
});

test('normal CDF / inverse are consistent', () => {
  for (const p of [0.01, 0.2, 0.5, 0.8, 0.99]) close(normCdf(normInv(p)), p, 1e-4);
});

test('tennis set <-> match probability conversion round-trips', () => {
  for (const p of [0.2, 0.5, 0.75]) {
    close(matchFromSet(setFromMatch(p, 3), 3), p, 1e-9);
    close(matchFromSet(setFromMatch(p, 5), 5), p, 1e-9);
  }
  close(eloExpected(1600, 1600), 0.5);
  close(matchFromState(0.6, 1, 0, 3), 0.6 + 0.4 * 0.6);
});

test('logistic regression fit recovers the direction of a known effect', () => {
  const r = rng(42); const rows = [];
  for (let i = 0; i < 1500; i++) {
    const x = { a: r() * 2 - 1, b: r() * 2 - 1 };
    const y = r() < sigmoid(0.3 + 1.5 * x.a) ? 1 : 0;
    rows.push({ x, y });
  }
  const c = fit(rows, { init: { intercept: 0, a: 0, b: 0 }, epochs: 600, lr: 0.5, l2: 0.001 });
  assert.ok(c.a > 1.0 && c.a < 2.0, `a=${c.a}`);
  assert.ok(Math.abs(c.b) < 0.35, `b=${c.b}`);
  assert.ok(predictLogit(c, { a: 1, b: 0 }) > predictLogit(c, { a: -1, b: 0 }));
});

test('confidence score is bounded 1..100 and rewards data coverage', () => {
  const lo = confidenceScore({ cov: 0.2, pSpec: 0.5, pW: 0.7, pPick: 0.52 });
  const hi = confidenceScore({ cov: 1, pSpec: 0.72, pW: 0.7, pPick: 0.75 });
  assert.ok(lo >= 1 && hi <= 100 && hi > lo);
});

test('analysis of every mock match yields coherent markets', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const withTip = [];
  for (const m of mockMatches({ now })) {
    const a0 = analyzeMatch(m);
    const o = mockOdds(m, a0, now); m.odds = o.odds; m.movement = o.movement;
    const a = analyzeMatch(m);
    for (const mk of a.markets) {
      for (const s of mk.selections) {
        assert.ok(s.p > 0 && s.p < 1, `${m.id} ${mk.key}`);
        assert.ok(s.odds > 1, 'odds > 1');
      }
      if (['ml', '1x2', 'total', 'spread', 'btts'].includes(mk.key) || mk.key.startsWith('ou')) {
        close(mk.selections.reduce((t, s) => t + s.p, 0), 1, 0.003);
      }
    }
    if (m.status === 'pre') withTip.push(!!a.tip);
    if (a.tip) {
      assert.ok(a.tip.confidence >= 1 && a.tip.confidence <= 100);
      assert.ok(a.tip.reasoning.length > 20);
      assert.ok(a.tip.odds >= 1.1, 'no trivial recommendations');
      assert.ok(a.tip.kind === 'value' ? a.tip.ev >= 0.03 : a.tip.p >= 0.55);
    }
  }
  assert.ok(withTip.filter(Boolean).length / withTip.length > 0.9, 'almost every upcoming match gets a tip');
});

test('settlement rules', () => {
  const f = { sport: 'football', status: 'post', home: { score: 2 }, away: { score: 1 } };
  assert.equal(settleSelection(f, '1x2', 'home'), 'won');
  assert.equal(settleSelection(f, 'dc', 'x2'), 'lost');
  assert.equal(settleSelection(f, 'ou25', 'over', 2.5), 'won');
  assert.equal(settleSelection(f, 'btts', 'yes'), 'won');
  const b = { sport: 'nba', status: 'post', home: { score: 100 }, away: { score: 96 } };
  assert.equal(settleSelection(b, 'spread', 'home', -4.5), 'lost');
  assert.equal(settleSelection(b, 'spread', 'away', -4.5), 'won');
  assert.equal(settleSelection(b, 'spread', 'home', -4), 'void');
  const t = { sport: 'tennis', status: 'post', home: { score: 2, sets: 2 }, away: { score: 1, sets: 1 } };
  assert.equal(settleSelection(t, 'straight', 'home'), 'lost');
  assert.equal(settleSelection(t, 'oneset', 'away'), 'won');
  assert.equal(settleSelection({ ...f, status: 'live' }, '1x2', 'home'), null);
});

test('every market of every finished mock match settles, and two-way markets have exactly one winner', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const seen = new Set();
  for (const fin of mockMatches({ now }).filter((m) => m.status === 'post')) {
    const pre = { ...fin, status: 'pre', live: null, home: { ...fin.home, score: null, sets: undefined }, away: { ...fin.away, score: null, sets: undefined } };
    const a = analyzeMatch(pre);
    for (const mk of a.markets) {
      const res = mk.selections.map((s) => settleSelection(fin, mk.key, s.key, mk.line));
      for (const r of res) assert.ok(['won', 'lost', 'void'].includes(r), `${fin.sport} ${mk.key}: ${r}`);
      if (mk.exhaustive && !res.includes('void')) assert.equal(res.filter((r) => r === 'won').length, 1, `${fin.sport} ${mk.key} ${fin.home.score}-${fin.away.score}`);
      seen.add(`${fin.sport}:${mk.family}`);
    }
  }
  for (const k of ['football:scorer', 'football:cards', 'football:teamtotals', 'nhl:scorer', 'nhl:btts', 'nba:player', 'handball:player', 'tennis:btts', 'tennis:spread', 'tennis:totals'])
    assert.ok(seen.has(k), `market family present: ${k}`);
});

test('goalscorer and card settlement', () => {
  const m = { sport: 'football', status: 'post', home: { score: 2 }, away: { score: 1 }, scorers: { home: ['Kylian Mbappé', 'A. Tóth'], away: ['B. Kane'] }, cards: { home: 2, away: 3 } };
  assert.equal(settleSelection(m, 'scorer', 'home:k-mbappe'), 'won');
  assert.equal(settleSelection(m, 'scorer', 'home:a-toth'), 'won');
  assert.equal(settleSelection(m, 'scorer', 'away:a-toth'), 'lost');
  assert.equal(settleSelection(m, 'yc45', 'over', 4.5), 'won');
  assert.equal(settleSelection({ ...m, cards: undefined }, 'yc45', 'over', 4.5), 'void');
  assert.equal(settleSelection({ ...m, scorers: undefined }, 'scorer', 'home:a-toth'), 'void');
  assert.equal(settleSelection(m, 'tth15', 'over', 1.5), 'won');
  assert.equal(settleSelection(m, 'ah', 'home', -0.5), 'won'); // 2-1: home -0.5 wins
  assert.equal(settleSelection(m, 'ah', 'away', -1.5), 'won'); // away +1.5 covers a 1-goal defeat
});
