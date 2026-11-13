import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir so the cache file of a real run is not touched.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sportelemzo-test-'));
process.env.DATA_MODE = 'auto';

test('ESPN fixtures: one request per day (ranges are rejected with HTTP 400), merged and de-duplicated', async () => {
  const { espn } = await import('../server/providers/espn.js');
  const { leagueById } = await import('../server/config.js');
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    const day = new URL(url).searchParams.get('dates');
    if (!/^\d{8}$/.test(day)) return new Response('bad request', { status: 400 }); // behaves like ESPN
    const ev = (id) => ({ id, date: '2026-11-06T00:30Z', competitions: [{ status: { type: { state: 'pre' } }, competitors: [
      { homeAway: 'home', score: '0', team: { displayName: 'Boston Celtics' }, records: [{ type: 'total', summary: '5-3' }] },
      { homeAway: 'away', score: '0', team: { displayName: 'Miami Heat' }, records: [{ type: 'total', summary: '4-4' }] }] }] });
    // the same event appears on two days → must be de-duplicated
    return new Response(JSON.stringify({ events: [ev(`g${day}`), ev('shared')] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await espn.fixtures(leagueById('nba'), 1000);
    assert.equal(urls.length, 4, 'yesterday … +2 days');
    assert.ok(urls.every((u) => /dates=\d{8}$/.test(u)), 'single-day dates parameter, no range, no limit');
    assert.equal(r.matches.length, 5, '4 daily games + 1 shared game counted once');
    assert.equal(r.status, 'live');
  } finally { globalThis.fetch = realFetch; }
});

test('a 4xx answer does not switch the provider off (circuit breaker stays closed)', async () => {
  const { getJson, providerHealth } = await import('../server/lib/http.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('bad', { status: 400 });
  try {
    for (let i = 0; i < 4; i++) await assert.rejects(getJson('t4xx', 'https://example.invalid/x', { retries: 0 }));
    assert.equal(providerHealth('t4xx').circuitOpen, false);
  } finally { globalThis.fetch = realFetch; }
});

test('API-Football NB I: fixtures normalised, plan errors inside HTTP 200 are detected', async () => {
  const { normaliseFixture, checkApiErrors } = await import('../server/providers/apisports.js');
  const { leagueById } = await import('../server/config.js');
  const L = leagueById('nbi');
  assert.equal(L.espn, null, 'NB I is not requested from ESPN');
  const it = (short, gh, ga, elapsed) => ({ fixture: { id: 7, date: '2026-11-08T17:00:00+00:00', status: { short, elapsed }, venue: { name: 'Groupama Aréna', city: 'Budapest' } },
    teams: { home: { name: 'Ferencvarosi TC' }, away: { name: 'Paksi FC' } }, goals: { home: gh, away: ga } });
  const pre = normaliseFixture(it('NS', null, null), L, Date.now(), 'live');
  assert.equal(pre.status, 'pre'); assert.equal(pre.home.score, null); assert.equal(pre.venue.city, 'Budapest');
  const live = normaliseFixture(it('2H', 1, 0, 63), L, Date.now(), 'live');
  assert.equal(live.status, 'live'); assert.equal(live.live.minute, 63); assert.equal(live.home.score, 1);
  const post = normaliseFixture(it('FT', 2, 2), L, Date.now(), 'live');
  assert.equal(post.status, 'post'); assert.equal(post.away.score, 2);
  assert.equal(normaliseFixture(it('PST', null, null), L, Date.now(), 'live').void, true);
  assert.throws(() => checkApiErrors({ errors: { plan: 'Free plans do not have access to this season' }, response: [] }), /Free plans/);
  assert.doesNotThrow(() => checkApiErrors({ errors: [], response: [] }));
  // the analysis must work with the sparse fixture data
  const { analyzeMatch } = await import('../server/engine/analyze.js');
  assert.equal(analyzeMatch(pre).markets[0].key, '1x2');
  assert.ok(analyzeMatch(live).markets.length > 3);
});
