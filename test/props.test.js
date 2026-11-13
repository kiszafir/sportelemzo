import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sportelemzo-props-'));
process.env.DATA_MODE = 'auto';

const { parseInjuries, parseBoxscore, injuryStatus } = await import('../server/providers/espn.js');
const { nbPmf, convolve, factorNodes, projectTeam, playerProps, statValue } = await import('../server/engine/props.js');
const { settleSelection } = await import('../server/engine/settle.js');
const { storeBox, buildRoster, applyPlayerData, boxState } = await import('../server/services/players.js');
const { leagueById } = await import('../server/config.js');
const { analyzeMatch } = await import('../server/engine/analyze.js');
const { mockMatches } = await import('../server/providers/mock.js');

// --- ESPN parsing (structure of the public injuries / summary endpoints) ---
const INJ = { timestamp: '2026-11-13T10:00Z', injuries: [
  { id: '1', displayName: 'Atlanta Hawks', injuries: [
    { id: '9', status: 'Out', date: new Date(Date.now() - 6 * 3600e3).toISOString(), shortComment: 'Gilbert (knee) has been ruled out.',
      athlete: { displayName: 'Ezra Gilbert' }, type: { name: 'INJURY_STATUS_OUT', description: 'out' }, details: { type: 'Knee', detail: 'Inflammation', returnDate: '2026-11-20' } },
    { id: '10', status: 'Day-To-Day', date: '2026-11-01T10:00Z', athlete: { displayName: 'Tom Ward' }, type: { name: 'INJURY_STATUS_DAYTODAY' }, details: { type: 'Ankle' } }] },
  { id: '2', displayName: 'Boston Celtics', injuries: [] }] };

test('ESPN injury report: Hungarian status, play probability, freshness', () => {
  const r = parseInjuries(INJ);
  assert.deepEqual(Object.keys(r.teams), ['Atlanta Hawks', 'Boston Celtics']);
  const [g, w] = r.teams['Atlanta Hawks'];
  assert.equal(g.status, 'kiesik'); assert.equal(g.playProb, 0); assert.equal(g.type, 'térd'); assert.equal(g.fresh, true);
  assert.equal(w.status, 'kétséges'); assert.ok(w.playProb > 0.5 && w.playProb < 0.7); assert.equal(w.type, 'boka'); assert.equal(w.fresh, false);
  assert.equal(injuryStatus('Questionable').playProb, 0.5);
  assert.equal(injuryStatus('Injured Reserve').playProb, 0);
  assert.equal(injuryStatus('Probable').status, 'valószínűleg játszik');
});

const nbaSummary = (rows) => ({
  header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: '1' } }, { homeAway: 'away', team: { id: '2' } }] }] },
  boxscore: { players: [
    { team: { id: '2', displayName: 'Boston Celtics' }, statistics: [{ keys: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'rebounds', 'assists', 'steals', 'blocks', 'points'],
      labels: ['MIN', 'FG', '3PT', 'REB', 'AST', 'STL', 'BLK', 'PTS'], athletes: rows.away }] },
    { team: { id: '1', displayName: 'Atlanta Hawks' }, statistics: [{ keys: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'rebounds', 'assists', 'steals', 'blocks', 'points'],
      labels: ['MIN', 'FG', '3PT', 'REB', 'AST', 'STL', 'BLK', 'PTS'], athletes: rows.home }] }] },
});
const ath = (name, [min, tpm, reb, ast, stl, blk, pts], extra = {}) => ({ athlete: { displayName: name }, stats: [String(min), '8-15', `${tpm}-7`, String(reb), String(ast), String(stl), String(blk), String(pts)], ...extra });

test('ESPN box score (NBA): sides from the header, 3PT made, DNP', () => {
  const b = parseBoxscore(nbaSummary({
    home: [ath('Ezra Gilbert', [36, 3, 11, 10, 1, 0, 24], { starter: true }), { athlete: { displayName: 'Tom Ward' }, didNotPlay: true, stats: [] }],
    away: [ath('Jay Tatum', [38, 4, 8, 5, 2, 1, 31])],
  }), 'nba');
  assert.equal(b.home.name, 'Atlanta Hawks'); assert.equal(b.away.name, 'Boston Celtics');
  assert.deepEqual(b.home.players['Ezra Gilbert'], { min: 36, pts: 24, reb: 11, ast: 10, tpm: 3, stl: 1, blk: 0, starter: true });
  assert.equal(b.home.players['Tom Ward'].dnp, true);
  assert.equal(statValue(b.home.players['Ezra Gilbert'], 'pra'), 45);
  assert.equal(statValue(b.home.players['Ezra Gilbert'], 'dd'), 3); // pts 24, reb 11, ast 10 → three categories ≥ 10
});

test('ESPN box score (NHL): skaters only, goals/assists/shots', () => {
  const grp = (name, keys, labels, athletes) => ({ name, keys, labels, athletes });
  const json = { header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: '5' } }, { homeAway: 'away', team: { id: '6' } }] }] },
    boxscore: { players: [
      { team: { id: '5', displayName: 'Boston Bruins' }, statistics: [
        grp('forwards', ['blockedShots', 'timeOnIce', 'goals', 'assists', 'shotsTotal'], ['BS', 'TOI', 'G', 'A', 'S'], [{ athlete: { displayName: 'David Pastrnak' }, stats: ['0', '19:30', '2', '1', '6'] }]),
        grp('goalies', ['goalsAgainst', 'saves', 'timeOnIce'], ['GA', 'SV', 'TOI'], [{ athlete: { displayName: 'J. Swayman' }, stats: ['2', '30', '60:00'] }])] },
      { team: { id: '6', displayName: 'New Jersey Devils' }, statistics: [
        grp('forwards', ['timeOnIce', 'goals', 'assists', 'shotsTotal'], ['TOI', 'G', 'A', 'S'], [{ athlete: { displayName: 'Jack Hughes' }, stats: ['21:10', '0', '2', '4'] }])] }] } };
  const b = parseBoxscore(json, 'nhl');
  assert.deepEqual(b.home.players['David Pastrnak'], { toi: 19.5, g: 2, a: 1, sog: 6 });
  assert.ok(!b.home.players['J. Swayman'], 'goalies skipped');
  assert.equal(statValue(b.away.players['Jack Hughes'], 'p'), 2);
});

test('distribution helpers: NegBin pmf sums to 1, convolution keeps the mean', () => {
  const a = nbPmf(24, 30); const b = nbPmf(8, 14);
  const sum = (p) => p.reduce((s, x) => s + x, 0); const mean = (p) => p.reduce((s, x, k) => s + k * x, 0);
  assert.ok(Math.abs(sum(a) - 1) < 1e-6); assert.ok(Math.abs(mean(a) - 24) < 0.05);
  const c = convolve(a, b); assert.ok(Math.abs(mean(c) - 32) < 0.1);
  const nodes = factorNodes(0.17); assert.ok(Math.abs(nodes.reduce((s, [F, w]) => s + F * w, 0) - 1) < 0.01);
});

// --- Roster from stored box scores, injuries, redistribution ---
function storeGames() {
  const t0 = Date.now() - 10 * 864e5;
  for (let g = 0; g < 8; g++) {
    const star = g > 0; // the star played every game except the oldest one (g = 0)
    const home = { name: 'Atlanta Hawks', players: {
      'Ezra Gilbert': star ? { min: 35, pts: 28, reb: 6, ast: 7, tpm: 3, stl: 1, blk: 0 } : { dnp: true },
      'Tom Ward': { min: 30, pts: 14, reb: 9, ast: 2, tpm: 1, stl: 1, blk: 1 },
      'Al Reed': { min: 28, pts: 12, reb: 4, ast: 6, tpm: 2, stl: 1, blk: 0 },
      'Bo Lane': { min: 26, pts: 11, reb: 8, ast: 1, tpm: 0, stl: 0, blk: 2 },
      'Cy Moss': { min: 24, pts: 10, reb: 3, ast: 3, tpm: 2, stl: 1, blk: 0 },
      'Dee Pratt': { min: 20, pts: 8, reb: 3, ast: 2, tpm: 1, stl: 0, blk: 0 } } };
    const away = { name: 'Boston Celtics', players: { 'Jay Tatum': { min: 37, pts: 27, reb: 8, ast: 5, tpm: 3, stl: 1, blk: 1 }, 'Kip Holt': { min: 32, pts: 18, reb: 5, ast: 4, tpm: 3, stl: 1, blk: 0 } } };
    storeBox('nba', `ev${g}`, t0 + g * 864e5, { home, away });
  }
}

test('roster profiles from box scores: averages, freshness, double-double rate', () => {
  storeGames();
  const r = buildRoster('nba', 'nba', 'Atlanta Hawks');
  assert.equal(r.games, 8);
  const g = r.roster.find((p) => p.name === 'Ezra Gilbert');
  assert.equal(g.gp, 7); assert.ok(Math.abs(g.pts - 28) < 1e-9); assert.ok(g.fresh > 0.85 && g.fresh < 1);
  assert.equal(r.roster.find((p) => p.name === 'Tom Ward').ddRate, 0);
});

test('an out star gets no props and his production is redistributed to teammates', () => {
  const m = { id: 'x', sport: 'nba', league: 'nba', status: 'pre', startTime: new Date(Date.now() + 3600e3).toISOString(), home: { name: 'Atlanta Hawks' }, away: { name: 'Boston Celtics' }, stats: { home: {}, away: {} }, meta: {} };
  applyPlayerData(leagueById('nba'), m, { teams: { 'Atlanta Hawks': [{ name: 'Ezra Gilbert', status: 'kiesik', playProb: 0, type: 'térd' }] }, status: 'live', fetchedAt: Date.now() });
  const st = m.stats.home;
  assert.ok(st.roster.length >= 6); assert.equal(st.injuries[0].freshAbsence, true); assert.ok(st.injuries[0].impact > 0.3, 'star impact');
  const healthy = projectTeam('nba', { ...st, injuries: [] }, { teamMu: 111 });
  const without = projectTeam('nba', st, { teamMu: 111 });
  assert.equal(without.out[0].name, 'Ezra Gilbert');
  const ward = (pr) => pr.active.find((p) => p.name === 'Tom Ward').proj;
  assert.ok(ward(without).pts > ward(healthy).pts * 1.05, 'teammate scores more without the star');
  assert.ok(ward(without).min > ward(healthy).min, 'teammate plays more minutes');
  const ctx = { notes: [], dist: { T: 222, M: 0, sT: 18, sM: 13 } };
  const mks = playerProps(m, ctx);
  assert.ok(!mks.some((k) => k.player === 'Ezra Gilbert'));
  assert.ok(mks.some((k) => k.key === 'pp:home:tom-ward:pra'));
  assert.ok(ctx.notes.some((n) => /friss hiányzó/.test(n)));
});

test('player-prop markets: full NBA set, consistent probabilities, settlement from the box score', () => {
  const m = mockMatches({ leagues: ['nba'] }).find((x) => x.status === 'pre');
  const a = analyzeMatch(m);
  const pp = a.markets.filter((k) => k.key.startsWith('pp:'));
  const stats = new Set(pp.map((k) => k.stat));
  for (const s of ['pts', 'reb', 'ast', '3pm', 'pr', 'pra', 'ra', 'dd']) assert.ok(stats.has(s), `missing ${s}`);
  for (const k of pp) { assert.ok(Math.abs(k.selections[0].p + k.selections[1].p - 1) < 1e-3); assert.ok(k.alt); }
  // PRA line > PR line > points line for the same player
  const pl = pp[0].player; const line = (st) => pp.find((k) => k.player === pl && k.stat === st)?.line;
  assert.ok(line('pra') > line('pr') && line('pr') > line('pts'));
  assert.ok(a.players.home.players.length > 0);

  const box = { home: { players: { 'Ezra Gilbert': { min: 36, pts: 24, reb: 11, ast: 10, tpm: 3, stl: 1, blk: 0 }, 'Tom Ward': { dnp: true } } }, away: { players: {} } };
  const fin = { sport: 'nba', status: 'post', home: { score: 110 }, away: { score: 100 }, box, boxState: 'ok' };
  assert.equal(settleSelection(fin, 'pp:home:ezra-gilbert:pra', 'over', 44.5), 'won');
  assert.equal(settleSelection(fin, 'pp:home:ezra-gilbert:pts', 'over', 24.5), 'lost');
  assert.equal(settleSelection(fin, 'pp:home:ezra-gilbert:3pm', 'over', 2.5), 'won');
  assert.equal(settleSelection(fin, 'pp:home:ezra-gilbert:dd', 'yes'), 'won');
  assert.equal(settleSelection(fin, 'pp:home:ezra-gilbert:td', 'yes'), 'won');
  assert.equal(settleSelection(fin, 'pp:home:tom-ward:pts', 'over', 9.5), 'void', 'DNP → void');
  assert.equal(settleSelection(fin, 'pp:home:nobody-here:pts', 'over', 9.5), 'void');
  assert.equal(settleSelection({ ...fin, box: null, boxState: 'pending' }, 'pp:home:ezra-gilbert:pts', 'over', 9.5), null, 'waits for the box score');
  assert.equal(settleSelection({ ...fin, box: null, boxState: 'failed' }, 'pp:home:ezra-gilbert:pts', 'over', 9.5), 'void');
  // NHL: points 1.5 line key carries the line suffix
  const nhl = { sport: 'nhl', status: 'post', home: { score: 4 }, away: { score: 2 }, box: { home: { players: { 'David Pastrnak': { g: 2, a: 1, sog: 6 } } }, away: { players: {} } } };
  assert.equal(settleSelection(nhl, 'pp:home:david-pastrnak:p15', 'over', 1.5), 'won');
  assert.equal(settleSelection(nhl, 'pp:home:david-pastrnak:sog', 'under', 3.5), 'lost');
  assert.equal(settleSelection(nhl, 'pp:home:david-pastrnak:a', 'over', 0.5), 'won');
});

test('NHL mock: props, roster-based goalscorers, simulated box scores settle', () => {
  const ms = mockMatches({ leagues: ['nhl'] });
  const pre = ms.find((x) => x.status === 'pre');
  const a = analyzeMatch(pre);
  assert.ok(a.markets.some((k) => k.key.startsWith('pp:') && k.stat === 'sog'));
  assert.ok(a.markets.some((k) => k.key === 'scorer'));
  const post = ms.find((x) => x.status === 'post');
  assert.equal(post.boxState, 'ok');
  const goals = Object.values(post.box.home.players).reduce((s, l) => s + (l.g || 0), 0);
  assert.ok(goals <= post.home.score && goals >= post.home.score - 1, 'box goals match the score (OT goal aside)');
  assert.equal(boxState({ league: 'nhl', eventId: 'none', startTime: new Date().toISOString() }), 'pending');
});

test('box-score sync: current finished games first, past days once, failures retried at most 3×', async () => {
  const { syncLeague, boxFor } = await import('../server/services/players.js');
  const calls = { days: 0, box: [] };
  const fake = {
    finishedEvents: async () => { calls.days++; return [{ id: 'p1' }, { id: 'p2' }]; },
    boxscore: async (league, id) => { calls.box.push(id); if (id === 'p2') throw new Error('HTTP 500'); return { home: { name: 'Atlanta Hawks', players: { A: { min: 30, pts: 10, reb: 2, ast: 1 } } }, away: { name: 'Boston Celtics', players: {} } }; },
  };
  const L = { ...leagueById('nhl'), id: 'nhl' };
  const fin = { status: 'post', eventId: 'now1', startTime: new Date(Date.now() - 4 * 3600e3).toISOString(), league: 'nhl' };
  const n = await syncLeague(L, [fin], fake);
  assert.equal(n, 2); assert.equal(calls.box[0], 'now1', 'the just-finished game is fetched first');
  assert.equal(calls.days, 13, 'days −2 … −14');
  assert.ok(boxFor({ league: 'nhl', eventId: 'now1' }));
  await syncLeague(L, [fin], fake); await syncLeague(L, [fin], fake); await syncLeague(L, [fin], fake);
  assert.equal(calls.days, 13, 'past days are not fetched again');
  assert.equal(calls.box.filter((x) => x === 'p2').length, 3, 'a failing summary is retried at most 3 times');
});
