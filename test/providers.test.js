import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTeamEvent, normaliseTennis } from '../server/providers/espn.js';
import { nameSimilarity, normName } from '../server/providers/base.js';
import { leagueById } from '../server/config.js';
import { analyzeMatch } from '../server/engine/analyze.js';

// Synthetic payload in the shape of ESPN's public scoreboard JSON.
const nbaEvent = {
  id: '401', date: '2026-11-06T00:30Z',
  competitions: [{
    date: '2026-11-06T00:30Z', venue: { fullName: 'Ball Arena', address: { city: 'Denver' }, indoor: true },
    status: { type: { state: 'in', shortDetail: 'Q3 5:12', detail: '3rd Quarter' }, period: 3, displayClock: '5:12' },
    competitors: [
      { homeAway: 'home', score: '78', team: { id: '7', displayName: 'Denver Nuggets', abbreviation: 'DEN' }, records: [{ type: 'total', summary: '8-3' }, { type: 'home', summary: '5-1' }, { type: 'road', summary: '3-2' }] },
      { homeAway: 'away', score: '70', team: { id: '13', displayName: 'Los Angeles Lakers', abbreviation: 'LAL' }, records: [{ type: 'total', summary: '6-5' }, { type: 'home', summary: '4-2' }, { type: 'road', summary: '2-3' }] },
    ],
    odds: [{ provider: { name: 'ESPN BET' }, overUnder: 229.5, spread: -4.5, homeTeamOdds: { moneyLine: -180 }, awayTeamOdds: { moneyLine: 150 } }],
  }],
};

test('ESPN team event normalisation (live NBA with odds)', () => {
  const m = normaliseTeamEvent(nbaEvent, leagueById('nba'), Date.now());
  assert.equal(m.status, 'live');
  assert.equal(m.home.name, 'Denver Nuggets');
  assert.equal(m.home.score, 78);
  assert.ok(Math.abs(m.stats.home.winPct - 8 / 11) < 1e-9);
  assert.ok(Math.abs(m.live.elapsedMin - (24 + 12 - 5.2)) < 1e-9);
  assert.equal(m.lines.total, 229.5);
  assert.ok(Math.abs(m.odds.ml.home[0].odds - 1.56) < 0.01);
  // The analysis must work with the sparse real-world stats.
  const a = analyzeMatch(m);
  assert.ok(a.tip && a.tip.confidence >= 1);
  assert.ok(a.coverage < 1, 'missing advanced metrics lower coverage');
  assert.equal(a.markets.find((x) => x.key === 'ml').selections[0].oddsSource, 'live');
});

test('ESPN soccer W-D-L records and form', () => {
  const ev = { id: '9', date: '2026-11-08T15:00Z', competitions: [{ date: '2026-11-08T15:00Z', status: { type: { state: 'pre' } }, venue: { fullName: 'Anfield', address: { city: 'Liverpool' } },
    competitors: [
      { homeAway: 'home', score: '0', form: 'WWDLW', team: { displayName: 'Liverpool' }, records: [{ type: 'total', summary: '7-2-1' }] },
      { homeAway: 'away', score: '0', form: 'LDLWD', team: { displayName: 'Everton' }, records: [{ type: 'total', summary: '3-3-4' }] }] }] };
  const m = normaliseTeamEvent(ev, leagueById('epl'), Date.now());
  assert.equal(m.status, 'pre'); assert.equal(m.home.score, null);
  assert.ok(Math.abs(m.stats.home.winPct - 0.7) < 1e-9);
  assert.deepEqual(m.stats.home.form, ['W', 'L', 'D', 'W', 'W']); // oldest → newest
  assert.equal(analyzeMatch(m).markets[0].key, '1x2');
});

test('ESPN tennis groupings', () => {
  const ev = { name: 'Nitto ATP Finals', groupings: [{ grouping: { displayName: "Men's Singles" }, competitions: [{ id: 'c1', date: '2026-11-09T13:00Z', status: { type: { state: 'post', detail: 'Final' } },
    competitors: [{ order: 1, athlete: { displayName: 'Player One' }, curatedRank: { current: 3 }, linescores: [{ value: 6 }, { value: 4 }, { value: 6 }] },
      { order: 2, athlete: { displayName: 'Player Two' }, curatedRank: { current: 8 }, linescores: [{ value: 3 }, { value: 6 }, { value: 2 }] }] }] }] };
  const [m] = normaliseTennis(ev, leagueById('atp'), Date.now());
  assert.equal(m.home.sets, 2); assert.equal(m.away.sets, 1); assert.equal(m.stats.home.rank, 3);
});

test('name matching across providers', () => {
  assert.equal(normName('Atlético Madrid'), 'atletico madrid');
  assert.ok(nameSimilarity('Manchester United FC', 'Manchester United') > 0.8);
  assert.ok(nameSimilarity('Manchester United', 'Manchester City') < 0.66);
});

test('ESPN soccer: goalscorers and yellow cards from a finished match; NBA leaders', () => {
  const ev = { id: '77', date: '2026-11-04T20:00Z', competitions: [{ date: '2026-11-04T20:00Z', status: { type: { state: 'post' } },
    competitors: [
      { homeAway: 'home', score: '2', team: { id: '1', displayName: 'Arsenal' }, statistics: [{ name: 'yellowCards', displayValue: '2' }] },
      { homeAway: 'away', score: '1', team: { id: '2', displayName: 'Chelsea' }, statistics: [{ name: 'yellowCards', displayValue: '3' }] }],
    details: [
      { scoringPlay: true, team: { id: '1' }, athletesInvolved: [{ displayName: 'Bukayo Saka' }] },
      { scoringPlay: true, ownGoal: true, team: { id: '2' }, athletesInvolved: [{ displayName: 'X' }] },
      { scoringPlay: true, team: { id: '2' }, athletesInvolved: [{ displayName: 'Cole Palmer' }] }] }] };
  const m = normaliseTeamEvent(ev, leagueById('epl'), Date.now());
  assert.deepEqual(m.scorers, { home: ['Bukayo Saka'], away: ['Cole Palmer'] });
  assert.deepEqual(m.cards, { home: 2, away: 3 });
  // an incomplete scorer list is not trusted (settles as void instead of a wrong "lost")
  const ev2 = structuredClone(ev); ev2.competitions[0].details.pop();
  assert.equal(normaliseTeamEvent(ev2, leagueById('epl'), Date.now()).scorers, undefined);

  const nba = structuredClone(nbaEvent);
  nba.competitions[0].status = { type: { state: 'pre' } };
  nba.competitions[0].competitors[0].leaders = [{ name: 'pointsPerGame', leaders: [{ value: 27.4, athlete: { displayName: 'Nikola Jokic' } }] }];
  const pre = normaliseTeamEvent(nba, leagueById('nba'), Date.now());
  assert.equal(pre.stats.home.players[0].name, 'Nikola Jokic');
  assert.ok(analyzeMatch(pre).markets.some((mk) => mk.key.startsWith('pl:home:') && mk.line === 26.5));
});
