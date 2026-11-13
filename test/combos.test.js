import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTickets, conflicts, evaluateTicket, MODES } from '../server/engine/combos.js';
import { rng } from '../server/engine/mathutil.js';

// Synthetic candidate legs across 4 sports, two markets per match.
function makeLegs(n = 40, seed = 3) {
  const r = rng(seed); const sports = ['nba', 'nhl', 'tennis', 'football']; const legs = [];
  for (let i = 0; i < n; i++) {
    const sport = sports[i % 4];
    const pFav = 0.55 + r() * 0.35;
    const mk = (fam, sel, p) => ({
      id: `m${i}|${fam}|${sel}`, matchId: `m${i}`, sport, league: sport + (i % 2), family: fam, market: fam, selection: sel,
      p, odds: Math.round((1 / p) * (0.95 + r() * 0.12) * 100) / 100, status: i % 9 === 0 ? 'live' : 'pre',
      startTime: new Date(Date.UTC(2026, 10, 6, i % 24)).toISOString(), confidence: 60, ev: 0, name: 'x',
    });
    legs.push(mk('result', 'home', pFav), mk('result', 'away', 1 - pFav), mk('totals', 'over', 0.5 + r() * 0.2), mk('totals', 'under', 0.3 + r() * 0.2));
  }
  legs.forEach((l) => { l.ev = l.p * l.odds - 1; });
  return legs;
}

test('conflict rules: same match same family conflicts; different families only when allowed', () => {
  const a = { id: '1', matchId: 'm', family: 'result' }; const b = { id: '2', matchId: 'm', family: 'totals' };
  const c = { id: '3', matchId: 'm', family: 'spread' }; const d = { id: '4', matchId: 'x', family: 'result' };
  assert.equal(conflicts(a, b, false), true);
  assert.equal(conflicts(a, b, true), false);
  assert.equal(conflicts(a, c, true), true); // spread vs result = both "who wins"
  assert.equal(conflicts(a, d, false), false);
});

test('Könnyű tickets respect odds ≤ 10, 2–6 legs, one leg per match', () => {
  const res = buildTickets('easy', makeLegs(), { seed: 1 });
  assert.ok(res.tickets.length >= 1, 'at least one ticket');
  for (const t of res.tickets) {
    assert.ok(t.odds <= MODES.easy.maxOdds + 1e-9, `odds ${t.odds}`);
    assert.ok(t.legs.length >= 2 && t.legs.length <= 6);
    assert.equal(new Set(t.legs.map((l) => l.matchId)).size, t.legs.length);
    assert.ok(t.legs.every((l) => l.p >= MODES.easy.leg.minP && l.status !== 'live'));
    assert.ok(['alacsony', 'közepes', 'magas'].includes(t.risk));
  }
});

test('Brutális tickets reach ≥ 70 and mix all sports', () => {
  const res = buildTickets('brutal', makeLegs(), { seed: 2 });
  assert.ok(res.tickets.length >= 1);
  for (const t of res.tickets) {
    assert.ok(t.odds >= 70, `odds ${t.odds}`);
    assert.deepEqual([...t.sports].sort(), ['football', 'nba', 'nhl', 'tennis']);
    // no conflicting same-match legs
    for (let i = 0; i < t.legs.length; i++) for (let j = i + 1; j < t.legs.length; j++) assert.equal(conflicts(t.legs[i], t.legs[j], true), false);
  }
});

test('locked legs are kept when regenerating', () => {
  const legs = makeLegs();
  const lockId = legs.find((l) => l.p > 0.7 && l.odds < 1.6 && l.status === 'pre').id;
  for (const seed of [5, 6, 7]) {
    const res = buildTickets('easy', legs, { seed, locked: [lockId] });
    assert.ok(res.tickets.length > 0);
    for (const t of res.tickets) assert.ok(t.legs.some((l) => l.id === lockId && l.locked));
  }
});

test('conflicting locked legs are rejected with a Hungarian message', () => {
  const legs = makeLegs();
  const res = buildTickets('easy', legs, { locked: ['m1|result|home', 'm1|result|away'] });
  assert.equal(res.tickets.length, 0);
  assert.match(res.warnings.join(' '), /ütköznek/);
});

test('different seeds give different tickets; same seed is deterministic', () => {
  const legs = makeLegs();
  const a = buildTickets('easy', legs, { seed: 11 }); const b = buildTickets('easy', legs, { seed: 11 }); const c = buildTickets('easy', legs, { seed: 12 });
  assert.deepEqual(a.tickets.map((t) => t.legs.map((l) => l.id)), b.tickets.map((t) => t.legs.map((l) => l.id)));
  assert.notDeepEqual(a.tickets.map((t) => t.legs.map((l) => l.id)), c.tickets.map((t) => t.legs.map((l) => l.id)));
});

test('correlation penalty and diversification', () => {
  const base = { sport: 'football', league: 'x', startTime: '2026-11-06T12:00:00Z', p: 0.6, odds: 1.7, confidence: 50 };
  const same = [{ ...base, id: 'a', matchId: 'm', family: 'totals' }, { ...base, id: 'b', matchId: 'm', family: 'btts' }];
  const diff = [{ ...base, id: 'a', matchId: 'm', family: 'totals' }, { ...base, id: 'b', matchId: 'n', sport: 'nba', league: 'y', family: 'result' }];
  const e1 = evaluateTicket(same, ['football', 'nba']); const e2 = evaluateTicket(diff, ['football', 'nba']);
  assert.ok(e1.correlationPenalty > e2.correlationPenalty);
  assert.ok(e1.diversification < e2.diversification);
  assert.ok(Math.abs(e2.odds - 2.89) < 1e-9);
  assert.ok(Math.abs(e2.p - 0.36) < 1e-9);
});

test('same-day tickets: every leg of a ticket is on the chosen day', async () => {
  const { dayOptions, pickDay } = await import('../server/engine/combos.js');
  const legs = makeLegs(60, 9).map((l, i) => ({ ...l, day: Number(l.matchId.slice(1)) % 3 === 0 ? '2026-11-05' : Number(l.matchId.slice(1)) % 3 === 1 ? '2026-11-06' : '2026-11-07' }));
  const opts = dayOptions('easy', legs);
  assert.deepEqual(opts.map((d) => d.day), ['2026-11-05', '2026-11-06', '2026-11-07']);
  const day = pickDay('easy', legs);
  assert.equal(day, '2026-11-05');
  for (const mode of ['easy', 'brutal']) {
    for (const d of ['2026-11-05', '2026-11-06']) {
      const res = buildTickets(mode, legs, { seed: 4, day: d });
      assert.ok(res.tickets.length >= 1, `${mode} ${d}`);
      for (const t of res.tickets) assert.ok(t.legs.every((l) => l.day === d), 'all legs on one day');
    }
  }
  // a locked leg from another day is dropped with a Hungarian warning
  const other = legs.find((l) => l.day === '2026-11-06' && l.p > 0.6 && l.status === 'pre');
  const res = buildTickets('easy', legs, { seed: 5, day: '2026-11-05', locked: [other.id] });
  assert.match(res.warnings.join(' '), /másik napon/);
  assert.ok(res.tickets.every((t) => t.legs.every((l) => l.day === '2026-11-05')));
});

test('market filter: tickets only use the selected market groups', async () => {
  const { filterByGroups, MARKET_GROUPS } = await import('../server/engine/combos.js');
  const legs = makeLegs(60, 13);
  // turn some legs into cards / scorer legs
  legs.forEach((l, i) => { if (i % 4 === 2) l.family = 'cards'; if (i % 4 === 3) { l.family = 'scorer'; } });
  const only = filterByGroups(legs, ['cards']);
  assert.ok(only.length > 0 && only.every((l) => l.family === 'cards'));
  assert.equal(filterByGroups(legs, []).length, legs.length, 'no filter = everything');
  const res = buildTickets('brutal', filterByGroups(legs, ['cards', 'scorer']), { seed: 3 });
  for (const t of res.tickets) assert.ok(t.legs.every((l) => ['cards', 'scorer'].includes(l.family)));
  assert.ok(Object.keys(MARKET_GROUPS).includes('scorer'));
});
