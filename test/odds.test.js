import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  impliedProb, overround, devigProportional, devigShin, fairOdds, expectedValue,
  kelly, kellyStake, americanToDecimal, combineOdds,
} from '../server/engine/odds.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('implied probability and fair odds are inverses', () => {
  close(impliedProb(2), 0.5);
  close(impliedProb(1.25), 0.8);
  close(fairOdds(0.4), 2.5);
  assert.throws(() => impliedProb(1));
});

test('overround of a two-way 1.91/1.91 market is ~4.7%', () => {
  close(overround([1.91, 1.91]), 2 / 1.91 - 1);
});

test('proportional devig sums to one and keeps ratios', () => {
  const p = devigProportional([1.5, 4.2, 6.5]);
  close(p.reduce((a, b) => a + b, 0), 1);
  close(p[0] / p[1], (1 / 1.5) / (1 / 4.2));
});

test('Shin devig sums to one and shades the longshot more than proportional', () => {
  const odds = [1.3, 4.0, 11.0];
  const { probs, z } = devigShin(odds);
  close(probs.reduce((a, b) => a + b, 0), 1, 1e-9);
  assert.ok(z > 0 && z < 0.2, `z=${z}`);
  const prop = devigProportional(odds);
  assert.ok(probs[2] < prop[2], 'longshot gets lower prob under Shin');
  assert.ok(probs[0] > prop[0], 'favourite gets higher prob under Shin');
});

test('Shin devig with no margin returns the implied probabilities', () => {
  const { probs, z } = devigShin([2, 2]);
  assert.equal(z, 0); close(probs[0], 0.5);
});

test('symmetric market devigs to 50/50 with both methods', () => {
  close(devigShin([1.9, 1.9]).probs[0], 0.5);
  close(devigProportional([1.9, 1.9])[0], 0.5);
});

test('expected value', () => {
  close(expectedValue(0.55, 2), 0.1);
  close(expectedValue(0.5, 1.9), -0.05);
});

test('Kelly criterion', () => {
  close(kelly(0.55, 2), 0.1);           // (0.55·2 − 1)/(2 − 1)
  assert.equal(kelly(0.4, 2), 0);       // negative edge -> no bet
  close(kelly(0.6, 1.8), (0.6 * 1.8 - 1) / 0.8);
});

test('fractional Kelly stake respects the hard cap and remaining limit', () => {
  const s1 = kellyStake({ p: 0.55, odds: 2, bankroll: 100000, fraction: 0.25, cap: 0.05 });
  assert.equal(s1.stake, 2500); // 0.25 × 10% = 2.5%
  const s2 = kellyStake({ p: 0.8, odds: 2, bankroll: 100000, fraction: 0.5, cap: 0.05 });
  assert.equal(s2.stake, 5000); assert.ok(s2.capped);
  const s3 = kellyStake({ p: 0.8, odds: 2, bankroll: 100000, fraction: 0.5, cap: 0.05, remainingLimit: 1200 });
  assert.equal(s3.stake, 1200); assert.ok(s3.limited);
  assert.equal(kellyStake({ p: 0.3, odds: 2, bankroll: 1e5 }).stake, 0);
});

test('American odds conversion', () => {
  close(americanToDecimal(150), 2.5);
  close(americanToDecimal(-200), 1.5);
  assert.equal(americanToDecimal(0), null);
  assert.equal(americanToDecimal('n/a'), null);
});

test('combined odds are the product', () => {
  close(combineOdds([1.5, 2, 3]), 9);
  close(combineOdds([]), 1);
});
