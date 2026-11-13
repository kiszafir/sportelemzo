// Deterministic mock provider. Works with no network and no keys.
// Matches sit on a fixed time grid per league, so the same match always has the
// same teams, stats and final result, and live matches progress with the clock
// (score, game clock, cards, sets) — enough to exercise SSE/auto-refresh offline.
import { LEAGUES, leagueById } from '../config.js';
import { rng, hashStr, gaussSample, poissonSample, sigmoid, clamp, logit } from '../engine/mathutil.js';
import { eloExpected, setFromMatch } from '../engine/models/elo.js';
import { YELLOW_BASE } from '../engine/extras.js';
import { TEAMS, PLAYERS, SURNAMES, INITIALS, INJURY_TYPES, BOOKS, ALTITUDE } from './mockdata.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Grid per league: one match every `every` minutes, shifted by `offset` minutes.
const GRID = {
  nba: { every: 180, offset: 0, dur: 140 },
  nhl: { every: 180, offset: 70, dur: 150 },
  atp: { every: 150, offset: 20, dur: null },
  wta: { every: 150, offset: 95, dur: null },
  epl: { every: 360, offset: 30, dur: 110 },
  laliga: { every: 360, offset: 120, dur: 110 },
  seriea: { every: 360, offset: 210, dur: 110 },
  bundesliga: { every: 360, offset: 300, dur: 110 },
  ligue1: { every: 480, offset: 60, dur: 110 },
  ucl: { every: 480, offset: 250, dur: 110 },
  nbi: { every: 480, offset: 400, dur: 110 },
  uel: { every: 600, offset: 150, dur: 110 },
  uecl: { every: 600, offset: 330, dur: 110 },
  eredivisie: { every: 600, offset: 45, dur: 110 },
  primeira: { every: 600, offset: 240, dur: 110 },
  championship: { every: 480, offset: 180, dur: 110 },
  superlig: { every: 720, offset: 380, dur: 110 },
  belgium: { every: 720, offset: 500, dur: 110 },
  scotland: { every: 720, offset: 620, dur: 110 },
  mls: { every: 720, offset: 260, dur: 110 },
  ehfcl: { every: 360, offset: 90, dur: 95 },
  ehfclw: { every: 480, offset: 200, dur: 95 },
  hbnbi: { every: 480, offset: 330, dur: 95 },
  hbnbiw: { every: 600, offset: 420, dur: 95 },
  hbl: { every: 480, offset: 30, dur: 95 },
  unl: { every: 720, offset: 140, dur: 110 },
  facup: { every: 1440, offset: 300, dur: 110 },
  eflcup: { every: 1440, offset: 1020, dur: 110 },
  copadelrey: { every: 1440, offset: 560, dur: 110 },
  coppaitalia: { every: 1440, offset: 820, dur: 110 },
  dfbpokal: { every: 1440, offset: 1180, dur: 110 },
  cdf: { every: 1440, offset: 440, dur: 110 },
  libertadores: { every: 1440, offset: 1380, dur: 110 },
  mkupa: { every: 1440, offset: 660, dur: 110 },
};

// ---------------------------------------------------------------------------
// Hidden "true" strengths. Observed stats are noisy reflections of these, and
// results are simulated from them — so the model is realistic but imperfect.
// ---------------------------------------------------------------------------
const trueRating = (league, name) => gaussSample(rng(`r:${league}:${name}`), 0, 1);
const fakePerson = (r) => `${INITIALS[Math.floor(r() * INITIALS.length)]}. ${SURNAMES[Math.floor(r() * SURNAMES.length)]}`;

// Fictional squads (stable per team): football/NHL goal shares, NBA scoring
// leader, handball top scorers. Names are invented on purpose.
export function squad(sport, league, team) {
  const r = rng(`squad:${league}:${team}`);
  const used = new Set();
  const uniqueName = () => { let n; do { n = fakePerson(r); } while (used.has(n)); used.add(n); return n; };
  const mk = (base) => base.map((b) => ({ name: uniqueName(), share: b * (0.8 + 0.4 * r()), starter: 0.8 + 0.2 * r() }));
  if (sport === 'football') return mk([0.3, 0.17, 0.11, 0.07]);
  if (sport === 'nhl') {
    // goal shares of the fictional roster (every goal gets a scorer)
    const ro = mockRoster('nhl', league, team); const tot = ro.reduce((a, p) => a + p.g, 0);
    return ro.map((p) => ({ name: p.name, share: p.g / tot, starter: 1 })).sort((a, b) => b.share - a.share);
  }
  if (sport === 'nba') return [{ name: uniqueName(), ppg: 20 + 11 * r(), starter: 0.92 }];
  if (sport === 'handball') return [6.0, 4.5].map((g) => ({ name: uniqueName(), gpg: g * (0.85 + 0.3 * r()), starter: 0.95 }));
  return [];
}

// ---------------------------------------------------------------------------
// Fictional NBA / NHL rosters with per-game profiles (player props), daily
// injury reports drawn from the roster, and simulated box scores.
// ---------------------------------------------------------------------------
const NBA_MIN = [35, 33, 31, 29, 27, 23, 20, 17, 13, 10];
const NBA_POS = ['G', 'W', 'W', 'B', 'G', 'G', 'W', 'B', 'W', 'B'];
const NHL_F = [[20, 0.46], [19, 0.39], [18, 0.33], [17, 0.27], [16, 0.22], [15, 0.17], [14, 0.13], [13, 0.1], [12, 0.07]];
const NHL_D = [[24, 0.1], [22, 0.08], [20, 0.06], [18, 0.04]];
const rosterCache = new Map();
export function mockRoster(sport, league, team) {
  const key = `${sport}:${league}:${team}`;
  if (rosterCache.has(key)) return rosterCache.get(key);
  const r = rng(`roster:${key}`); const tr = trueRating(league, team);
  const used = new Set(); const uniq = () => { let n; do { n = fakePerson(r); } while (used.has(n)); used.add(n); return n; };
  const v = () => 0.8 + 0.4 * r();
  let out = [];
  if (sport === 'nba') {
    out = NBA_MIN.map((min, i) => {
      const pos = NBA_POS[i];
      const ppm = (i < 2 ? 0.68 : i < 5 ? 0.52 : 0.4) * v() * (1 + 0.04 * tr);
      const rpm = { B: 0.3, W: 0.17, G: 0.12 }[pos] * v(); const apm = { G: 0.2, W: 0.09, B: 0.07 }[pos] * v();
      const tpmR = { G: 0.07, W: 0.075, B: 0.018 }[pos] * v(); const blkR = pos === 'B' ? 0.045 * v() : 0.012 * v();
      return { name: uniq(), pos, gp: 12, fresh: 1, min, pts: ppm * min, reb: rpm * min, ast: apm * min, tpm: tpmR * min, stl: 0.032 * v() * min, blk: blkR * min };
    });
  } else if (sport === 'nhl') {
    const sk = (toi, g, d) => { const gg = g * v() * (1 + 0.06 * tr); const a = (d ? 0.35 * v() : gg * 1.25 * v()); return { name: uniq(), pos: d ? 'D' : 'F', gp: 12, fresh: 1, toi, g: gg, a, sog: d ? 1.6 * v() : Math.max(0.8, gg / 0.125) }; };
    out = [...NHL_F.map(([t, g]) => sk(t, g, false)), ...NHL_D.map(([t, g]) => sk(t, g, true))];
  }
  rosterCache.set(key, out);
  return out;
}

/** Daily fictional injury report for an NBA/NHL team, drawn from its roster. */
export function mockTeamInjuries(sport, league, team, t) {
  const ro = mockRoster(sport, league, team); if (!ro.length) return [];
  const day = Math.floor(t / (24 * HOUR));
  const r = rng(`inj:${league}:${team}:${day}`);
  const n = Math.floor(r() * 3 * r());
  const picked = new Set(); const list = [];
  const prod = (p) => (sport === 'nba' ? p.pts + 0.5 * p.reb + 0.7 * p.ast : p.g + 0.7 * p.a);
  const teamProd = ro.reduce((s, p) => s + prod(p), 0);
  for (let k = 0; k < n; k++) {
    const i = Math.floor(r() * ro.length); if (picked.has(i)) continue; picked.add(i);
    const u = r(); const [status, playProb] = u < 0.55 ? ['kiesik', 0] : u < 0.9 ? ['kétséges', 0.5] : ['valószínűleg játszik', 0.85];
    list.push({ name: ro[i].name, type: INJURY_TYPES[Math.floor(r() * INJURY_TYPES.length)], status, playProb,
      impact: Math.round(Math.min(1, Math.max(0.05, prod(ro[i]) / teamProd * (sport === 'nba' ? 2.2 : 3))) * 100) / 100,
      date: new Date(Math.min(t, day * 24 * HOUR + 2 * HOUR)).toISOString(), fresh: true, freshAbsence: true });
  }
  return list;
}

const nbSample = (mean, r, disp) => Math.max(0, Math.round(gaussSample(r, mean, Math.sqrt(mean + mean * mean / disp))));

/** Simulated NBA box score consistent with the final score; injured players DNP. */
function nbaBox(league, team, inj, pts, r) {
  const ro = mockRoster('nba', league, team);
  const players = {}; const act = [];
  for (const p of ro) {
    const i = inj.find((x) => x.name === p.name);
    if (i && r() >= i.playProb) { players[p.name] = { dnp: true }; continue; }
    act.push(p);
  }
  const F = act.map(() => Math.exp(gaussSample(r, 0, 0.17)));
  const minSum = act.reduce((s, p, k) => s + p.min * F[k], 0) || 1;
  const lines = act.map((p, k) => {
    const min = Math.min(46, (p.min * F[k] * 240) / minSum); const f = min / p.min;
    return { name: p.name, min: Math.round(min), pts: nbSample(p.pts * f, r, 30), reb: nbSample(p.reb * f, r, 14), ast: nbSample(p.ast * f, r, 10),
      tpm: nbSample(p.tpm * f, r, 9), stl: nbSample(p.stl * f, r, 40), blk: nbSample(p.blk * f, r, 18) };
  });
  const sum = lines.reduce((s, l) => s + l.pts, 0) || 1;
  for (const l of lines) { l.pts = Math.round(l.pts * pts / sum); l.tpm = Math.min(l.tpm, Math.floor(l.pts / 3)); const { name, ...rest } = l; players[name] = rest; }
  return { name: team, players };
}

/** Simulated NHL box score: goals from the simulated scorers, assists and shots sampled. */
function nhlBox(league, team, inj, goals, shotsRate, r) {
  const ro = mockRoster('nhl', league, team);
  const out = new Set(inj.filter((x) => x.playProb === 0).map((x) => x.name));
  const players = {}; const act = ro.filter((p) => !out.has(p.name));
  for (const p of ro) if (out.has(p.name)) players[p.name] = { dnp: true };
  const line = Object.fromEntries(act.map((p) => [p.name, { toi: Math.round(p.toi * (0.85 + 0.3 * r()) * 10) / 10, g: 0, a: 0, sog: 0 }]));
  const totA = act.reduce((s, p) => s + p.a, 0) || 1;
  for (const g of goals) {
    const scorer = g.player && line[g.player] ? g.player : act[Math.floor(r() * act.length)]?.name; if (!scorer) continue;
    line[scorer].g++;
    const nA = r() < 0.62 ? 2 : r() < 0.8 ? 1 : 0; const used = new Set([scorer]);
    for (let k = 0; k < nA; k++) {
      let u = r() * totA;
      for (const p of act) { u -= p.a; if (u < 0) { if (!used.has(p.name)) { line[p.name].a++; used.add(p.name); } break; } }
    }
  }
  for (const p of act) { const l = line[p.name]; l.sog = Math.max(l.g, nbSample(p.sog * shotsRate / 30, r, 12)); players[p.name] = l; }
  return { name: team, players };
}

function rosterAvg(ro, sport) {
  const K = sport === 'nba' ? ['min', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk'] : ['toi', 'g', 'a', 'sog'];
  return Object.fromEntries(K.map((k) => [k, ro.reduce((s, p) => s + p[k] * p.fresh, 0)]));
}

const yellowRate = (league, team) => (YELLOW_BASE[league] ?? 2.0) * (0.75 + 0.55 * rng(`yc:${league}:${team}`)());

function formFrom(r, pWin, pDraw = 0, n = 10) {
  const out = [];
  for (let i = 0; i < n; i++) { const u = r(); out.push(u < pWin ? 'W' : u < pWin + pDraw ? 'D' : 'L'); }
  return out;
}

function injuries(r, sport, max = 3) {
  const n = Math.floor(r() * (max + 1) * r());
  const list = [];
  for (let i = 0; i < n; i++) {
    const susp = sport === 'football' && r() < 0.2;
    list.push({
      name: fakePerson(r),
      type: susp ? 'eltiltás' : INJURY_TYPES[Math.floor(r() * INJURY_TYPES.length)],
      status: susp ? 'eltiltva' : r() < 0.35 ? 'kétséges' : 'kiesik',
      impact: Math.round((0.1 + r() * 0.5) * 100) / 100,
    });
  }
  return list;
}

function teamStats(sport, league, name, seedTime, side) {
  const tr = trueRating(league, name);
  const r = rng(`s:${league}:${name}:${Math.floor(seedTime / (24 * HOUR))}`); // stats change daily
  const noisy = tr + gaussSample(r, 0, 0.35);
  const gp = 8 + Math.floor(r() * 8);
  const restDays = Math.floor(r() * 4);
  const base = { gamesPlayed: gp, restDays, injuries: injuries(r, sport), gamesLast7: 1 + Math.floor(r() * 3), travelKm: side === 'away' ? Math.round(r() * 3500) : Math.round(r() * 400) };
  if (sport === 'nba') {
    const pace = 99 + gaussSample(r, 0, 2.2);
    const net = 4.5 * noisy + gaussSample(r, 0, 1.2);
    const drtg = 114 - 2.4 * noisy + gaussSample(r, 0, 1.2);
    return { ...base, backToBack: restDays === 0, winPct: clamp(sigmoid(0.95 * noisy), 0.1, 0.9), homeWinPct: clamp(sigmoid(0.95 * noisy + 0.3), 0.1, 0.95), awayWinPct: clamp(sigmoid(0.95 * noisy - 0.3), 0.05, 0.9),
      form: formFrom(r, sigmoid(tr)), netRtg: net, drtg, pace, ts: 0.575 + 0.011 * noisy + gaussSample(r, 0, 0.005), usageTop: 0.27 + r() * 0.09,
      ppg: pace * (drtg + net) / 100, oppPpg: pace * drtg / 100, gamesLast7: 2 + Math.floor(r() * 3) };
  }
  if (sport === 'nhl') {
    const gfPg = 3.05 + 0.32 * noisy + gaussSample(r, 0, 0.12); const gaPg = 3.05 - 0.32 * noisy + gaussSample(r, 0, 0.12);
    return { ...base, backToBack: restDays === 0, winPct: clamp(sigmoid(0.7 * noisy), 0.15, 0.85), homeWinPct: clamp(sigmoid(0.7 * noisy + 0.15), 0.1, 0.9), awayWinPct: clamp(sigmoid(0.7 * noisy - 0.15), 0.1, 0.9),
      form: formFrom(r, sigmoid(0.7 * tr)), gfPg, gaPg, cfPct: 0.5 + 0.028 * noisy + gaussSample(r, 0, 0.01), ffPct: 0.5 + 0.025 * noisy + gaussSample(r, 0, 0.01),
      pdo: 1 + gaussSample(r, 0, 0.014), goalieSv: 0.903 + 0.007 * noisy + gaussSample(r, 0, 0.004), goalieName: fakePerson(r), starterConfirmed: r() < 0.7 };
  }
  if (sport === 'handball') {
    const women = /w$/.test(league); const mu = women ? 27.5 : 29.5;
    const gfPg = mu + 2.3 * noisy + gaussSample(r, 0, 0.6); const gaPg = mu - 2.3 * noisy + gaussSample(r, 0, 0.6);
    const winPct = clamp(sigmoid(1.15 * noisy - 0.1), 0.05, 0.95);
    return { ...base, gamesPlayed: 8 + Math.floor(r() * 6), winPct, homeWinPct: clamp(winPct + 0.08, 0.05, 0.97), awayWinPct: clamp(winPct - 0.08, 0.03, 0.93),
      form: formFrom(r, sigmoid(1.15 * tr - 0.1), 0.07), gfPg, gaPg, ppg: clamp(2 * winPct + 0.07, 0.1, 2), gamesLast7: 1 + Math.floor(r() * 2) };
  }
  // football
  const gfPg = 1.37 * Math.exp(0.24 * noisy) + gaussSample(r, 0, 0.08); const gaPg = 1.37 * Math.exp(-0.24 * noisy) + gaussSample(r, 0, 0.08);
  const ppg = clamp(1.38 + 0.62 * noisy + gaussSample(r, 0, 0.12), 0.3, 2.8);
  return { ...base, gamesPlayed: 9 + Math.floor(r() * 4), winPct: clamp(sigmoid(1.1 * noisy - 0.6), 0.05, 0.9), homeWinPct: clamp(sigmoid(1.1 * noisy - 0.3), 0.05, 0.95), awayWinPct: clamp(sigmoid(1.1 * noisy - 0.9), 0.03, 0.85),
    form: formFrom(r, sigmoid(1.1 * tr - 0.55), 0.26), gfPg: Math.max(0.4, gfPg), gaPg: Math.max(0.4, gaPg),
    xgPg: Math.max(0.5, 1.37 * Math.exp(0.22 * tr) + gaussSample(r, 0, 0.1)), xgaPg: Math.max(0.5, 1.37 * Math.exp(-0.22 * tr) + gaussSample(r, 0, 0.1)),
    possession: clamp(0.5 + 0.06 * noisy + gaussSample(r, 0, 0.02), 0.32, 0.7), ppg };
}

function footballContext(league, home, away) {
  // League position from true ratings; motivation from the table situation.
  const names = TEAMS[league];
  const ranked = [...names].sort((a, b) => trueRating(league, b) - trueRating(league, a));
  const pos = (n) => ranked.indexOf(n) + 1;
  const size = names.length;
  const mot = (p) => (p <= 3 ? [0.6, 'bajnoki címért harcol'] : p > size - 3 ? [0.5, 'kiesés ellen küzd'] : p <= 6 ? [0.35, 'európai helyért hajt'] : [0, 'középmezőny']);
  const isCup = !!leagueById(league)?.cup || ['ucl', 'uel', 'uecl', 'ehfcl', 'ehfclw'].includes(league);
  const cupLabel = leagueById(league)?.cup ? (leagueById(league)?.national ? 'válogatott, csoportmeccs' : 'kupameccs (kieséses)') : 'csoportkör / ligaszakasz';
  const [mh, lh] = isCup ? [0.45, cupLabel] : mot(pos(home));
  const [ma, la] = isCup ? [0.45, cupLabel] : mot(pos(away));
  return { home: { position: isCup ? null : pos(home), leagueSize: size, motivation: mh, motivationLabel: lh }, away: { position: isCup ? null : pos(away), leagueSize: size, motivation: ma, motivationLabel: la } };
}

function tennisStats(tour, name, seedTime) {
  const tr = trueRating(tour, name);
  const r = rng(`s:${tour}:${name}:${Math.floor(seedTime / (24 * HOUR))}`);
  const elo = 1950 + 140 * tr + gaussSample(r, 0, 25);
  const eloSurface = elo + gaussSample(r, 0, 55);
  const rank = Math.max(1, Math.round(Math.exp(4.6 - 1.05 * tr + gaussSample(r, 0, 0.25))));
  return {
    elo, eloSurface, rank, gamesPlayed: 20 + Math.floor(r() * 30),
    surfaceWinPct: clamp(sigmoid(0.9 * tr + gaussSample(r, 0, 0.2)), 0.2, 0.9),
    holdPct: clamp(0.79 + 0.04 * tr + gaussSample(r, 0, 0.015), 0.6, 0.93), breakPct: clamp(0.24 + 0.035 * tr + gaussSample(r, 0, 0.015), 0.1, 0.42),
    matchLoad14: Math.floor(r() * 8), retirements12m: r() < 0.8 ? 0 : 1 + Math.floor(r() * 2), form: formFrom(r, sigmoid(0.9 * tr)),
    injuries: r() < 0.12 ? [{ name, type: INJURY_TYPES[Math.floor(r() * 4)], status: 'kétséges', impact: 0.3 }] : [],
  };
}

// ---------------------------------------------------------------------------
// Result + live timeline simulation (from TRUE ratings)
// ---------------------------------------------------------------------------
function assignScorers(goals, homeSquad, awaySquad, r) {
  for (const g of goals) {
    const sq = g.team === 'home' ? homeSquad : awaySquad;
    let u = r();
    for (const pl of sq) { u -= pl.share * pl.starter; if (u < 0) { g.player = pl.name; break; } }
  }
}

function simulate(sport, league, home, away, seed, inj = { home: [], away: [] }) {
  const r = rng(`sim:${seed}`);
  const d = trueRating(league, home) - trueRating(league, away);
  if (sport === 'football') {
    const lh = 1.45 * Math.exp(0.28 * d); const la = 1.15 * Math.exp(-0.28 * d);
    const goals = [];
    const gh = poissonSample(lh, r); const ga = poissonSample(la, r);
    for (let i = 0; i < gh; i++) goals.push({ minute: 1 + Math.floor(r() * 93), team: 'home' });
    for (let i = 0; i < ga; i++) goals.push({ minute: 1 + Math.floor(r() * 93), team: 'away' });
    goals.sort((a, b) => a.minute - b.minute);
    const reds = []; if (r() < 0.1) reds.push({ minute: 20 + Math.floor(r() * 70), team: r() < 0.5 ? 'home' : 'away' });
    const yellows = { home: poissonSample(yellowRate(league, home), r), away: poissonSample(yellowRate(league, away), r) };
    assignScorers(goals, squad('football', league, home), squad('football', league, away), r);
    return { goals, reds, yellows, final: { home: gh, away: ga }, possession: clamp(0.5 + 0.05 * d + gaussSample(r, 0, 0.04), 0.3, 0.72) };
  }
  if (sport === 'nba') {
    let margin = Math.round(3 + 5.5 * d + gaussSample(r, 0, 12));
    const ot = margin === 0; if (ot) margin = r() < 0.5 ? 3 : -3;
    const total = Math.round(226 + gaussSample(r, 0, 17));
    const H = Math.round((total + margin) / 2); const A = total - H;
    const split = (pts) => { const w = Array.from({ length: 48 }, () => 0.6 + r()); const s = w.reduce((a, b) => a + b, 0); let acc = 0; return w.map((x) => { acc += (x / s) * pts; return Math.round(acc); }); };
    const br = rng(`box:${seed}`);
    const box = { home: nbaBox(league, home, inj.home, H, br), away: nbaBox(league, away, inj.away, A, br) };
    const pp = {}; for (const sd of ['home', 'away']) for (const [n, l] of Object.entries(box[sd].players)) if (!l.dnp) pp[n] = l.pts;
    return { final: { home: H, away: A }, cumHome: split(H), cumAway: split(A), ot, playerPoints: pp, box };
  }
  if (sport === 'handball') {
    const women = /w$/.test(league);
    const margin = Math.round(1.8 + 4.6 * d + gaussSample(r, 0, 6));
    const total = Math.round((women ? 55 : 59) + gaussSample(r, 0, 6));
    const H = Math.round((total + margin) / 2); const A = total - H;
    const split = (pts) => { const w = Array.from({ length: 60 }, () => 0.6 + r()); const s2 = w.reduce((a, b) => a + b, 0); let acc = 0; return w.map((x) => { acc += (x / s2) * pts; return Math.round(acc); }); };
    const pg = {};
    for (const team of [home, away]) for (const pl of squad('handball', league, team)) pg[pl.name] = r() < pl.starter ? poissonSample(pl.gpg, r) : 0;
    return { final: { home: H, away: A }, cumHome: split(H), cumAway: split(A), suspensions: { home: 2 + Math.floor(r() * 5), away: 2 + Math.floor(r() * 5) }, playerGoals: pg };
  }
  if (sport === 'nhl') {
    const lh = 3.15 * Math.exp(0.18 * d); const la = 2.95 * Math.exp(-0.18 * d);
    const goals = [];
    const gh = poissonSample(lh, r); const ga = poissonSample(la, r);
    for (let i = 0; i < gh; i++) goals.push({ minute: Math.floor(r() * 60), team: 'home' });
    for (let i = 0; i < ga; i++) goals.push({ minute: Math.floor(r() * 60), team: 'away' });
    goals.sort((a, b) => a.minute - b.minute);
    let ot = null;
    if (gh === ga) { ot = r() < sigmoid(0.3 * d) ? 'home' : 'away'; goals.push({ minute: 62, team: ot }); }
    const outOf = (side) => new Set(inj[side].filter((x) => x.playProb === 0).map((x) => x.name));
    const avail = (team, side) => { const o = outOf(side); const sq = squad('nhl', league, team).filter((p) => !o.has(p.name)); const t = sq.reduce((a, p) => a + p.share, 0) || 1; return sq.map((p) => ({ ...p, share: p.share / t })); };
    assignScorers(goals, avail(home, 'home'), avail(away, 'away'), r);
    const shotsRate = { home: 30 + 3 * d, away: 30 - 3 * d };
    const br = rng(`box:${seed}`);
    const box = { home: nhlBox(league, home, inj.home, goals.filter((g) => g.team === 'home'), shotsRate.home, br), away: nhlBox(league, away, inj.away, goals.filter((g) => g.team === 'away'), shotsRate.away, br) };
    return { goals, final: { home: gh + (ot === 'home' ? 1 : 0), away: ga + (ot === 'away' ? 1 : 0) }, ot, shotsRate, box };
  }
  // tennis
  const p = eloExpected(1950 + 140 * trueRating(league, home), 1950 + 140 * trueRating(league, away));
  const s = setFromMatch(p, 3);
  const sets = []; let wh = 0, wa = 0;
  while (wh < 2 && wa < 2) {
    const homeWins = r() < s;
    const loserGames = [0, 1, 2, 3, 4, 5, 6][Math.min(6, Math.floor(r() * 7))];
    const winnerGames = loserGames === 5 ? 7 : loserGames === 6 ? 7 : 6;
    sets.push(homeWins ? { h: winnerGames, a: loserGames } : { h: loserGames, a: winnerGames });
    if (homeWins) wh++; else wa++;
  }
  const retired = r() < 0.02;
  return { sets, final: { home: wh, away: wa }, retired };
}

function liveState(sport, sim, elapsedReal, dur) {
  const e = elapsedReal;
  if (sport === 'football') {
    let minute; let label;
    if (e < 47) { minute = Math.min(45, Math.floor(e)); label = e >= 45 ? '45+' : `${Math.floor(e) + 1}'`; }
    else if (e < 62) { minute = 45; label = 'Félidő'; }
    else { minute = Math.min(93, 45 + Math.floor(e - 62)); label = minute >= 90 ? '90+' : `${minute + 1}'`; }
    const done = sim.goals.filter((g) => g.minute <= minute);
    const reds = sim.reds.filter((x) => x.minute <= minute);
    const frac = minute / 90;
    const recent = sim.goals.filter((g) => g.minute <= minute && g.minute > minute - 15);
    const mom = recent.reduce((s, g) => s + (g.team === 'home' ? 0.5 : -0.5), 0);
    return {
      score: { home: done.filter((g) => g.team === 'home').length, away: done.filter((g) => g.team === 'away').length },
      live: { elapsedMin: minute, minute, clock: label, periodLabel: e < 47 ? '1. félidő' : e < 62 ? 'Félidő' : '2. félidő',
        possession: { home: sim.possession, away: 1 - sim.possession },
        cards: { home: { y: Math.round(sim.yellows.home * frac), r: reds.filter((x) => x.team === 'home').length }, away: { y: Math.round(sim.yellows.away * frac), r: reds.filter((x) => x.team === 'away').length } },
        redCards: { home: reds.filter((x) => x.team === 'home').length, away: reds.filter((x) => x.team === 'away').length },
        fouls: { home: Math.round(12 * frac), away: Math.round(13 * frac) },
        momentum: clamp(mom + (sim.possession - 0.5), -1, 1) },
    };
  }
  if (sport === 'nba') {
    const g = Math.min(47.99, (e / dur) * 48);
    const q = Math.floor(g / 12) + 1; const rem = 12 - (g % 12);
    const mm = Math.floor(rem); const ss = Math.floor((rem - mm) * 60);
    const idx = Math.max(0, Math.floor(g) - 1);
    const sh = g < 1 ? 0 : sim.cumHome[idx]; const sa = g < 1 ? 0 : sim.cumAway[idx];
    const momentum = clamp(((sh - (idx > 4 ? sim.cumHome[idx - 4] : 0)) - (sa - (idx > 4 ? sim.cumAway[idx - 4] : 0))) / 10, -1, 1);
    return { score: { home: sh, away: sa }, live: { elapsedMin: g, period: q, periodLabel: `${q}. negyed`, clock: `${q}. negyed ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
      fouls: { home: Math.round(g * 0.42), away: Math.round(g * 0.44) }, timeouts: { home: Math.max(0, 7 - Math.floor(g / 8)), away: Math.max(0, 7 - Math.floor(g / 7.5)) }, momentum } };
  }
  if (sport === 'handball') {
    // 95 real minutes: 1st half 0–32, break 32–47, 2nd half 47–95
    const g = e < 32 ? Math.min(30, e * 30 / 32) : e < 47 ? 30 : Math.min(59.99, 30 + (e - 47) * 30 / 48);
    const idx = Math.max(0, Math.floor(g) - 1);
    const sh = g < 1 ? 0 : sim.cumHome[idx]; const sa = g < 1 ? 0 : sim.cumAway[idx];
    const back = Math.max(0, idx - 5);
    const momentum = clamp(((sh - (idx > 5 ? sim.cumHome[back] : 0)) - (sa - (idx > 5 ? sim.cumAway[back] : 0))) / 4, -1, 1);
    const half = e < 32 ? '1. félidő' : e < 47 ? 'Félidő' : '2. félidő';
    return { score: { home: sh, away: sa }, live: { elapsedMin: g, minute: g, periodLabel: half, clock: e >= 32 && e < 47 ? 'Félidő' : `${Math.ceil(g)}'`,
      suspensions: { home: Math.round(sim.suspensions.home * g / 60), away: Math.round(sim.suspensions.away * g / 60) },
      timeouts: { home: Math.max(0, 3 - Math.floor(g / 22)), away: Math.max(0, 3 - Math.floor(g / 25)) }, momentum } };
  }
  if (sport === 'nhl') {
    const g = Math.min(59.99, (e / dur) * 60);
    const per = Math.floor(g / 20) + 1; const rem = 20 - (g % 20);
    const mm = Math.floor(rem); const ss = Math.floor((rem - mm) * 60);
    const done = sim.goals.filter((x) => x.minute <= g && x.minute < 60);
    return { score: { home: done.filter((x) => x.team === 'home').length, away: done.filter((x) => x.team === 'away').length }, live: { elapsedMin: g, period: per, periodLabel: `${per}. harmad`,
      clock: `${per}. harmad ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, shots: { home: Math.round(sim.shotsRate.home * g / 60), away: Math.round(sim.shotsRate.away * g / 60) },
      momentum: clamp((sim.shotsRate.home - sim.shotsRate.away) / 10, -1, 1) } };
  }
  // tennis: 40 real minutes per set
  const setIdx = Math.min(sim.sets.length - 1, Math.floor(e / 40));
  const frac = (e - setIdx * 40) / 40;
  let wh = 0, wa = 0; const shown = [];
  sim.sets.forEach((s, i) => {
    if (i < setIdx) { shown.push(`${s.h}-${s.a}`); if (s.h > s.a) wh++; else wa++; }
    else if (i === setIdx) shown.push(`${Math.floor(s.h * frac)}-${Math.floor(s.a * frac)}`);
  });
  return { score: { home: wh, away: wa }, sets: { home: wh, away: wa }, live: { elapsedMin: e, clock: `${setIdx + 1}. szett`, periodLabel: `${setIdx + 1}. szett`, setScores: shown.join(', '), momentum: 0 } };
}

const tennisDuration = (sim) => sim.sets.length * 40;

// ---------------------------------------------------------------------------
// Match construction
// ---------------------------------------------------------------------------
export function buildMockMatch(leagueId, t, now = Date.now()) {
  const L = leagueById(leagueId); const sport = L.sport;
  const seed = `${leagueId}:${t}`;
  const r = rng(`pair:${seed}`);
  const pool = sport === 'tennis' ? PLAYERS[leagueId] : TEAMS[leagueId];
  const i = Math.floor(r() * pool.length); let j = Math.floor(r() * (pool.length - 1)); if (j >= i) j++;
  const home = pool[i]; const away = pool[j];
  const teamInj = sport === 'nba' || sport === 'nhl' ? { home: mockTeamInjuries(sport, leagueId, home, t), away: mockTeamInjuries(sport, leagueId, away, t) } : { home: [], away: [] };
  const sim = simulate(sport, leagueId, home, away, seed, teamInj);
  const dur = sport === 'tennis' ? tennisDuration(sim) : GRID[leagueId].dur;
  const elapsed = (now - t) / MIN;
  const status = elapsed < 0 ? 'pre' : elapsed < dur ? 'live' : 'post';

  const stats = sport === 'tennis'
    ? { home: tennisStats(leagueId, home, t), away: tennisStats(leagueId, away, t) }
    : { home: teamStats(sport, leagueId, home, t, 'home'), away: teamStats(sport, leagueId, away, t, 'away') };
  if (sport !== 'tennis') {
    stats.home.players = squad(sport, leagueId, home); stats.away.players = squad(sport, leagueId, away);
    if (sport === 'nba' || sport === 'nhl') {
      for (const [side, team] of [['home', home], ['away', away]]) {
        const ro = mockRoster(sport, leagueId, team); const st = stats[side];
        st.roster = ro; st.teamAvg = rosterAvg(ro, sport); st.rosterSrc = { games: 12, src: 'Mintaadat' }; st.injuries = teamInj[side];
        if (sport === 'nhl') { const out = new Set(teamInj[side].filter((x) => x.playProb === 0).map((x) => x.name)); st.players = st.players.filter((p) => !out.has(p.name)); st.playersSrc = 'boxscore'; }
      }
    }
    if (sport === 'football') {
      const yr = rng(`ycs:${leagueId}:${t}`);
      stats.home.yellowPg = Math.max(0.6, yellowRate(leagueId, home) + gaussSample(yr, 0, 0.15));
      stats.away.yellowPg = Math.max(0.6, yellowRate(leagueId, away) + gaussSample(yr, 0, 0.15));
    }
  }
  if (sport === 'football' || sport === 'handball') {
    const ctx = footballContext(leagueId, home, away);
    Object.assign(stats.home, ctx.home); Object.assign(stats.away, ctx.away);
  }
  const hr = rng(`h2h:${leagueId}:${[home, away].sort().join('|')}`);
  const n = Math.floor(hr() * 9);
  const pH = sport === 'tennis' ? eloExpected(stats.home.elo, stats.away.elo) : sigmoid(trueRating(leagueId, home) - trueRating(leagueId, away) + 0.2);
  let hw = 0, dr = 0;
  for (let k = 0; k < n; k++) { const u = hr(); if ((sport === 'football' && u > 0.74) || (sport === 'handball' && u > 0.93)) dr++; else if (hr() < pH) hw++; }

  const m = {
    id: `mock-${leagueId}-${t}`, provider: 'mock', sport, league: leagueId, leagueName: L.name,
    startTime: new Date(t).toISOString(), status,
    home: { name: home, short: abbreviate(home), score: null }, away: { name: away, short: abbreviate(away), score: null },
    venue: sport === 'tennis' ? { name: `${L.name} Mintatorna, központi pálya`, city: 'Torino', indoor: true } : { name: sport === 'football' ? `${home} – hazai stadion` : `${home} – csarnok`, city: null, indoor: sport !== 'football', altitude: ALTITUDE[home] ?? 100 },
    surface: sport === 'tennis' ? 'kemény (fedett)' : null, bestOf: sport === 'tennis' ? 3 : undefined,
    tournament: sport === 'tennis' ? `${L.name} Mintatorna` : null,
    stats, h2h: n ? { n, homeWins: hw, draws: dr, awayWins: n - hw - dr } : null,
    weather: sport === 'football' ? mockWeather(seed) : null,
    dataStatus: 'mock', fetchedAt: now,
  };
  if (status === 'live') {
    const ls = liveState(sport, sim, elapsed, dur);
    m.home.score = ls.score.home; m.away.score = ls.score.away; m.live = ls.live;
    if (sim.goals && (sport === 'football' || sport === 'nhl')) {
      const done = sim.goals.filter((g) => g.player && g.minute <= (ls.live.minute ?? ls.live.elapsedMin ?? 0));
      m.live.scorers = { home: done.filter((g) => g.team === 'home').map((g) => g.player), away: done.filter((g) => g.team === 'away').map((g) => g.player) };
    }
    if (ls.sets) { m.home.sets = ls.sets.home; m.away.sets = ls.sets.away; }
    m.statusText = ls.live.clock;
  } else if (status === 'post') {
    m.home.score = sim.final.home; m.away.score = sim.final.away;
    if (sport === 'tennis') { m.home.sets = sim.final.home; m.away.sets = sim.final.away; m.setScores = sim.sets.map((s) => `${s.h}-${s.a}`).join(', '); m.retired = sim.retired; }
    if (sport === 'football' || sport === 'nhl') m.scorers = { home: sim.goals.filter((g) => g.player && g.team === 'home').map((g) => g.player), away: sim.goals.filter((g) => g.player && g.team === 'away').map((g) => g.player) };
    if (sport === 'football') m.cards = { home: sim.yellows.home, away: sim.yellows.away };
    if (sport === 'nba') m.playerPoints = sim.playerPoints;
    if (sport === 'nba' || sport === 'nhl') { m.box = sim.box; m.boxState = 'ok'; }
    if (sport === 'handball') m.playerGoals = sim.playerGoals;
    m.statusText = sport === 'nhl' && sim.ot ? 'Vége (h.u.)' : sport === 'nba' && sim.ot ? 'Vége (hossz.)' : 'Vége';
  } else m.statusText = 'Közelgő';
  const meta = { status: 'mock', src: 'Mintaadat', fetchedAt: now };
  m.meta = { form: meta, schedule: meta, injuries: meta, advanced: meta, h2h: meta, context: meta, market: meta, odds: meta, live: meta, stats: meta, weather: meta };
  return m;
}

function mockWeather(seed) {
  const r = rng(`wx:${seed}`);
  const precip = r() < 0.3 ? Math.round(r() * 8 * 10) / 10 : 0;
  const wind = Math.round(5 + r() * 35);
  return { tempC: Math.round(2 + r() * 12), windKmh: wind, precipMm: precip, desc: precip > 3 ? 'eső' : precip > 0 ? 'szitálás' : wind > 30 ? 'erős szél' : 'száraz', src: 'mock' };
}

const abbreviate = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();

/** All mock matches in [now − backH, now + aheadH]. */
export function mockMatches({ now = Date.now(), backH = 20, aheadH = 52, leagues = LEAGUES.map((l) => l.id) } = {}) {
  const out = [];
  for (const id of leagues) {
    const g = GRID[id]; if (!g) continue;
    const step = g.every * MIN; const off = g.offset * MIN;
    const from = now - backH * HOUR; const to = now + aheadH * HOUR;
    for (let k = Math.ceil((from - off) / step); k * step + off <= to; k++) out.push(buildMockMatch(id, k * step + off, now));
  }
  return out;
}

/** Historical finished matches for seeding the tip log and backtests. */
export function mockHistory({ days = 45, now = Date.now(), sparse = 3 } = {}) {
  const out = [];
  for (const L of LEAGUES) {
    const g = GRID[L.id]; const step = g.every * sparse * MIN; const off = g.offset * MIN;
    const from = now - days * 24 * HOUR; const to = now - 24 * HOUR;
    for (let k = Math.ceil((from - off) / step); k * step + off <= to; k++) out.push(buildMockMatch(L.id, k * step + off, now));
  }
  return out;
}

/**
 * Mock bookmaker odds for an analysed match: market view = model probability
 * perturbed in logit space (shared market noise + per-book noise) plus a 4–7 % margin.
 */
export function mockOdds(match, analysis, now = Date.now()) {
  const odds = {}; const hist = {};
  const r = rng(`odds:${match.id}`);
  const t0 = new Date(match.startTime).getTime() - 30 * HOUR;
  for (const mk of analysis.markets) {
    odds[mk.key] = {};
    const shared = mk.selections.map(() => gaussSample(r, 0, 0.16));
    const books = BOOKS.map((name, bi) => {
      const margin = 0.04 + 0.01 * bi + r() * 0.015;
      const ps = mk.selections.map((s, i) => sigmoid(logit(clamp(s.p, 0.02, 0.98)) + shared[i] + gaussSample(r, 0, 0.06)));
      const exhaustive = mk.exhaustive ?? (['ml', '1x2', 'total', 'spread', 'btts'].includes(mk.key) || mk.key.startsWith('ou'));
      const sum = exhaustive ? ps.reduce((a, b) => a + b, 0) : 1;
      return { name, prices: ps.map((p) => Math.max(1.01, Math.round((1 / ((p / sum) * (1 + margin))) * 100) / 100)) };
    });
    mk.selections.forEach((s, i) => {
      odds[mk.key][s.key] = books.map((b) => ({ book: b.name, odds: b.prices[i], src: 'mock', t: now }));
    });
  }
  // Opening price + movement history for the main market's home selection.
  const main = analysis.markets[0];
  const homeNow = Math.max(...odds[main.key][main.selections[0].key].map((q) => q.odds));
  const homeOpen = Math.max(1.02, Math.round(homeNow * Math.exp(gaussSample(r, 0, 0.06)) * 100) / 100);
  for (let k = 0; k < 5; k++) {
    const t = t0 + (k / 4) * Math.max(1, Math.min(now, new Date(match.startTime).getTime()) - t0);
    (hist[`${main.key}:${main.selections[0].key}`] ||= []).push({ t, odds: Math.round((homeOpen + (homeNow - homeOpen) * (k / 4)) * 100) / 100 });
  }
  return { odds, movement: { homeOpen, homeNow, openedAt: t0, updatedAt: now, market: main.key, selection: main.selections[0].key }, history: hist };
}

export const mockProvider = {
  id: 'mock', name: 'Mintaadat (beépített szimuláció)', kind: ['fixtures', 'odds', 'stats'], requiresKey: false,
  enabled: () => true,
  hashStr,
};
