import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sportelemzo-realonly-'));

test('ticket legs come from real matches only (mock allowed only in demo mode)', async () => {
  const { state, legCandidates } = await import('../server/services/ingest.js');
  const { mockMatches, mockOdds } = await import('../server/providers/mock.js');
  const { analyzeMatch } = await import('../server/engine/analyze.js');
  const now = Date.now();
  const ms = mockMatches({ now, leagues: ['epl', 'nba'] }).filter((m) => m.status === 'pre').slice(0, 6);
  ms.forEach((m, i) => {
    if (i % 2 === 0) { m.provider = 'espn'; m.dataStatus = 'live'; m.id = m.id.replace('mock-', 'espn-'); } // pretend real
    let a = analyzeMatch(m); const o = mockOdds(m, a, now); m.odds = o.odds; a = analyzeMatch(m);
    state.matches.set(m.id, m); state.analyses.set(m.id, a);
  });
  const real = legCandidates();
  assert.ok(real.length > 0);
  assert.ok(real.every((l) => !l.matchId.startsWith('mock-')), 'no simulated match in the pool');
  const demo = legCandidates({ allowMock: true });
  assert.ok(demo.some((l) => l.matchId.startsWith('mock-')));
});
