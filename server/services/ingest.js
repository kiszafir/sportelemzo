// Ingestion pipeline: fetch fixtures per league (live provider → cache → mock),
// enrich with standings / injuries / odds / weather, analyse every match,
// log and settle tips, then notify SSE listeners.
import { config, LEAGUES } from '../config.js';
import { createLogger } from '../logger.js';
import { db, store } from '../store.js';
import { providers } from '../providers/registry.js';
import { nameSimilarity } from '../providers/base.js';
import { mockMatches, mockOdds } from '../providers/mock.js';
import { analyzeMatch } from '../engine/analyze.js';
import { confidenceScore } from '../engine/analyze.js';
import { logTips, settleTips, seedMockHistory, archiveFinished, cardHistory } from './tips.js';
import { YELLOW_BASE } from '../engine/extras.js';
import { localDay } from '../lib/time.js';
import { recordSnapshot, labelFinished, maybeTrain, adjusterFor } from './learn.js';

const log = createLogger('ingest');

export const state = {
  matches: new Map(),   // id -> match
  analyses: new Map(),  // id -> analysis
  leagueStatus: {},     // leagueId -> { source, fetchedAt, error, count }
  lastUpdate: null,
  version: 0,
  refreshing: false,
};

const listeners = new Set();
export const onUpdate = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (evt) => { for (const fn of listeners) { try { fn(evt); } catch { /* ignore */ } } };

// ---------------------------------------------------------------------------
const noticeOnce = new Set();
async function loadLeague(league, liveOnly) {
  const mock = (extra = {}) => ({ matches: mockMatches({ leagues: [league.id] }), source: 'mock', fetchedAt: Date.now(), ...extra });
  if (config.dataMode === 'mock') return mock();
  try {
    if (league.sport === 'handball') {
      if (!providers.apisports.enabled()) {
        const msg = 'Kézilabdához az ESPN nem ad adatot; élő adathoz API_SPORTS_KEY szükséges (API-Handball).';
        if (!noticeOnce.has(league.id)) { noticeOnce.add(league.id); log.info('league uses mock data', { league: league.id, reason: msg }); }
        return mock({ fallback: true, error: msg });
      }
      const hasLive = [...state.matches.values()].some((m) => m.league === league.id && m.status === 'live' && m.provider !== 'mock');
      const r = await providers.apisports.handballFixtures(league, { hasLive });
      return { matches: r.matches, source: r.status, fetchedAt: r.fetchedAt };
    }
    if (!league.espn) {
      // ESPN does not cover this league (NB I): API-Football with the optional key.
      if (!providers.apisports.enabled()) {
        const msg = 'Az ESPN nem közli ezt a bajnokságot; élő adathoz API_SPORTS_KEY szükséges.';
        if (!noticeOnce.has(league.id)) { noticeOnce.add(league.id); log.info('league uses mock data', { league: league.id, reason: msg }); }
        return mock({ fallback: true, error: msg });
      }
      const hasLive = [...state.matches.values()].some((m) => m.league === league.id && m.status === 'live' && m.provider !== 'mock');
      const r = await providers.apisports.fixtures(league, { hasLive });
      return { matches: r.matches, source: r.status, fetchedAt: r.fetchedAt };
    }
    if (!providers.espn.enabled()) return mock();
    const ttl = liveOnly ? 25e3 : Math.max(60e3, config.refresh.fixtures * 900);
    const r = await providers.espn.fixtures(league, ttl);
    return { matches: r.matches, source: r.status, fetchedAt: r.fetchedAt };
  } catch (err) {
    log.warn('league fell back to mock data', { league: league.id, err });
    return mock({ fallback: true, error: err.message });
  }
}

const findTeam = (map, name) => {
  if (!map || !name) return null;
  if (map[name]) return map[name];
  let best = null; let bestS = 0.66;
  for (const [k, v] of Object.entries(map)) {
    const s = Math.max(nameSimilarity(k, name), ...(v.aliases || []).filter(Boolean).map((a) => nameSimilarity(a, name)));
    if (s > bestS) { best = v; bestS = s; }
  }
  return best;
};

const findTeamList = (map, name) => {
  if (map[name]) return map[name];
  let best = null; let bestS = 0.66;
  for (const [k, v] of Object.entries(map)) { const sc = nameSimilarity(k, name); if (sc > bestS) { best = v; bestS = sc; } }
  return best;
};

const metaOf = (r, src) => ({ status: r.status, fetchedAt: r.fetchedAt, src });

async function enrichLive(league, matches, allMatches) {
  const P = providers;
  // Standings → season stats (football-data preferred for football, ESPN otherwise).
  let st = null; let stSrc = null;
  try {
    if (league.sport === 'football' && P.footballdata.enabled() && league.fd) { st = await P.footballdata.standings(league); stSrc = 'football-data.org'; }
  } catch { st = null; }
  if (!st && league.sport === 'handball') {
    try { if (P.apisports.enabled()) { st = await P.apisports.handballStandings(league); stSrc = 'API-Handball'; } } catch { st = null; }
  }
  if (!st && !league.espn && league.as) {
    try { if (P.apisports.enabled()) { st = await P.apisports.standings(league); stSrc = 'API-Sports'; } } catch { st = null; }
  }
  if (!st && league.espn) {
    try { if (P.espn.enabled()) { st = await P.espn.standings(league); stSrc = 'ESPN'; } } catch { st = null; }
  }
  // Quota protection: injuries and odds only for leagues with an upcoming match soon.
  const startsWithin = (h) => matches.some((m) => m.status === 'pre' && Date.parse(m.startTime) - Date.now() < h * 3600e3);
  let inj = null;
  try { if (league.sport === 'football' && P.apisports.enabled() && startsWithin(72)) inj = await P.apisports.injuries(league); } catch { inj = null; }
  let odds = null;
  try { if (P.oddsapi.enabled() && (startsWithin(36) || matches.some((m) => m.status === 'live'))) odds = await P.oddsapi.odds(league); } catch { odds = null; }
  let scorers = null;
  try { if (league.sport === 'football' && P.apisports.enabled() && (startsWithin(36) || matches.some((m) => m.status === 'live'))) scorers = await P.apisports.topScorers(league); } catch { scorers = null; }
  const cards = league.sport === 'football' ? cardHistory() : null;

  // Back-to-back detection from the fetched window (team played the previous day).
  const playedOn = new Map();
  for (const m of allMatches) for (const side of ['home', 'away']) {
    const k = m[side].name; const day = Math.floor(Date.parse(m.startTime) / 864e5);
    if (!playedOn.has(k)) playedOn.set(k, new Set());
    playedOn.get(k).add(day);
  }

  let wxBudget = 12;
  for (const m of matches) {
    const fxSrc = m.provider === 'apisports' ? 'API-Sports' : 'ESPN';
    m.meta = { ...(m.meta || {}), form: { status: m.dataStatus, fetchedAt: m.fetchedAt, src: fxSrc }, live: { status: m.dataStatus, fetchedAt: m.fetchedAt, src: fxSrc } };
    if (st?.teams) {
      for (const side of ['home', 'away']) {
        const t = findTeam(st.teams, m[side].name);
        if (t) {
          const { aliases, ...rest } = t; void aliases;
          m.stats[side] = { ...rest, ...Object.fromEntries(Object.entries(m.stats[side] || {}).filter(([, v]) => v !== undefined && v !== null)) };
          if (league.sport === 'football' && st.leagueSize) m.stats[side].leagueSize = st.leagueSize;
        }
      }
      m.meta.advanced = metaOf(st, stSrc); m.meta.stats = metaOf(st, stSrc);
      if (league.sport === 'football' || league.sport === 'handball') addMotivation(m);
    }
    if (inj?.teams) {
      for (const side of ['home', 'away']) m.stats[side].injuries = findTeam(inj.teams, m[side].name) || [];
      m.meta.injuries = metaOf(inj, 'API-Sports');
    }
    // Goalscorer data: share of the team's goals × share of minutes played.
    if (scorers?.teams) {
      for (const side of ['home', 'away']) {
        const list = findTeamList(scorers.teams, m[side].name); const st = m.stats[side];
        if (!list?.length) continue;
        const gp = st.gamesPlayed || Math.max(...list.map((x) => x.apps), 1);
        const teamGoals = Number.isFinite(st.gfPg) ? st.gfPg * gp : Math.max(list.reduce((t, x) => t + x.goals, 0) * 1.6, 1);
        st.players = list.map((x) => ({ name: x.name, share: Math.min(0.6, x.goals / teamGoals), starter: Math.min(1, Math.max(0.3, x.minutes / (gp * 90))) }));
      }
      m.meta.players = metaOf(scorers, 'API-Sports (góllövőlista)');
    }
    if (league.sport === 'nhl') {
      for (const side of ['home', 'away']) {
        const st = m.stats[side]; const l = st.leaderGoals;
        if (l && Number.isFinite(st.gfPg) && st.gamesPlayed) st.players = [{ name: l.name, share: Math.min(0.4, l.value / (st.gfPg * st.gamesPlayed)), starter: 0.95 }];
      }
    }
    // Yellow-card averages from archived matches, shrunk towards the league average (k = 4 matches).
    if (cards) {
      const prior = YELLOW_BASE[league.id] ?? 2.0;
      for (const side of ['home', 'away']) {
        const h = cards[`${league.id}|${m[side].name}`];
        if (h?.n) m.stats[side].yellowPg = (h.sum + 4 * prior) / (h.n + 4);
      }
    }
    if (league.sport === 'nba' || league.sport === 'nhl') {
      const day = Math.floor(Date.parse(m.startTime) / 864e5);
      for (const side of ['home', 'away']) {
        const b2b = playedOn.get(m[side].name)?.has(day - 1) || false;
        m.stats[side].backToBack = b2b; if (b2b) m.stats[side].restDays = 0;
      }
      m.meta.schedule = { status: m.dataStatus, fetchedAt: m.fetchedAt, src: 'ESPN (menetrend)' };
    }
    if (odds?.events) attachOddsEvents(m, odds, league);
    if (league.sport === 'football' && P.weather.enabled() && m.status !== 'post' && wxBudget > 0) {
      wxBudget--;
      const w = await P.weather.weather(m);
      if (w) { m.weather = w; m.meta.weather = { status: w.status, fetchedAt: w.fetchedAt, src: 'Open-Meteo' }; if (w.altitude != null) m.venue.altitude = w.altitude; }
    }
  }
}

function addMotivation(m) {
  for (const side of ['home', 'away']) {
    const t = m.stats[side]; if (!t.position || !t.leagueSize) continue;
    const p = t.position; const n = t.leagueSize;
    [t.motivation, t.motivationLabel] = p <= 3 ? [0.6, 'bajnoki címért harcol'] : p > n - 3 ? [0.5, 'kiesés ellen küzd'] : p <= 6 ? [0.35, 'európai helyért hajt'] : [0, 'középmezőny'];
  }
  m.meta.context = m.meta.stats;
}

function attachOddsEvents(m, odds, league) {
  const t = Date.parse(m.startTime);
  const ev = odds.events.find((e) => Math.abs(Date.parse(e.commence) - t) < 3 * 3600e3 && nameSimilarity(e.home, m.home.name) > 0.6 && nameSimilarity(e.away, m.away.name) > 0.6);
  if (!ev) return;
  m.odds = m.odds || {};
  const key = league.sport === 'football' || league.sport === 'handball' ? '1x2' : 'ml';
  const src = odds.status;
  for (const b of ev.books) {
    const h = b.h2h[ev.home]; const a = b.h2h[ev.away]; const d = b.h2h.Draw;
    if (h && a) {
      m.odds[key] = m.odds[key] || { home: [], away: [], ...(key === '1x2' ? { draw: [] } : {}) };
      m.odds[key].home.push({ book: b.book, odds: h, src, t: b.t });
      m.odds[key].away.push({ book: b.book, odds: a, src, t: b.t });
      if (key === '1x2' && d) m.odds[key].draw.push({ book: b.book, odds: d, src, t: b.t });
    }
    if (b.totals?.point && b.totals.over && b.totals.under) {
      const tk = league.sport === 'football' ? `ou${String(b.totals.point).replace('.', '')}` : 'total';
      if (league.sport !== 'football') m.lines = { ...(m.lines || {}), total: m.lines?.total ?? b.totals.point };
      if (league.sport === 'football' || m.lines.total === b.totals.point) {
        m.odds[tk] = m.odds[tk] || { over: [], under: [] };
        m.odds[tk].over.push({ book: b.book, odds: b.totals.over, src, t: b.t });
        m.odds[tk].under.push({ book: b.book, odds: b.totals.under, src, t: b.t });
      }
    }
  }
  m.meta.odds = { status: odds.status, fetchedAt: odds.fetchedAt, src: 'The Odds API' };
}

// Opening vs current price history for the main market (live data).
function trackMovement(m, analysis) {
  const main = analysis.markets[0]; const sel = main?.selections?.[0];
  if (!sel || sel.oddsSource === 'estimated' || sel.oddsSource === 'manual') return;
  const H = db().oddsHistory;
  const k = `${main.key}:${sel.key}`;
  H[m.id] = H[m.id] || {};
  const arr = (H[m.id][k] = H[m.id][k] || []);
  if (!arr.length || arr[arr.length - 1].odds !== sel.odds) { arr.push({ t: Date.now(), odds: sel.odds, src: sel.oddsSource }); if (arr.length > 60) arr.splice(1, 1); store.save(); }
  if (arr.length >= 2) m.movement = { homeOpen: arr[0].odds, homeNow: arr[arr.length - 1].odds, openedAt: arr[0].t, updatedAt: arr[arr.length - 1].t, market: main.key, selection: sel.key };
}

function analyse(m) {
  const manual = db().manualOdds[m.id] || {};
  const adjust = adjusterFor(m); // AI-motor (null until a validated calibrator exists)
  let a = analyzeMatch(m, { manualOdds: manual });
  if (m.provider === 'mock') {
    // the simulated market is built from the raw model view, never from the AI-adjusted one
    const o = mockOdds(m, a);
    m.odds = o.odds; m.movement = o.movement; m.oddsHistoryMock = o.history;
    a = analyzeMatch(m, { manualOdds: manual, adjust });
  } else {
    trackMovement(m, a);
    if (m.movement || adjust) a = analyzeMatch(m, { manualOdds: manual, adjust });
  }
  return a;
}

/** Re-run the analysis for one match (e.g. after manual odds were entered). */
export function reanalyse(id) {
  const m = state.matches.get(id); if (!m) return null;
  const a = analyse(m); state.analyses.set(id, a);
  state.version++; emit({ type: 'match', id, version: state.version });
  return a;
}

export async function refresh({ liveOnly = false, reason = 'schedule' } = {}) {
  if (state.refreshing) return state.lastUpdate;
  state.refreshing = true;
  const t0 = Date.now();
  try {
    const leagues = liveOnly
      ? LEAGUES.filter((L) => [...state.matches.values()].some((m) => m.league === L.id && (m.status === 'live' || (m.status === 'pre' && Date.parse(m.startTime) - Date.now() < 20 * 60e3))))
      : LEAGUES;
    // Leagues are loaded in parallel and each one is published as soon as it is
    // ready (slow, rate-limited sources such as API-Sports — 10 requests/minute
    // on the free plan — must not hold back the fast ones).
    let lastEmit = 0;
    const publish = () => {
      if (Date.now() - lastEmit < 1500) return;
      lastEmit = Date.now();
      if (!state.lastUpdate) state.lastUpdate = Date.now();
      state.version++;
      emit({ type: 'update', version: state.version, lastUpdate: state.lastUpdate, partial: true });
    };
    await Promise.all(leagues.map(async (L) => {
      const r = await loadLeague(L, liveOnly);
      if (r.source !== 'mock') await enrichLive(L, r.matches, r.matches).catch((err) => log.warn('enrich failed', { league: L.id, err }));
      for (const [id, m] of state.matches) if (m.league === L.id) { state.matches.delete(id); state.analyses.delete(id); }
      for (const m of r.matches) {
        state.matches.set(m.id, m);
        try { state.analyses.set(m.id, analyse(m)); } catch (err) { log.error('analysis failed', { id: m.id, err }); }
      }
      state.leagueStatus[L.id] = { source: r.source, fetchedAt: r.fetchedAt, error: r.error || null, fallback: !!r.fallback, count: r.matches.length };
      publish();
    }));
    // Tip log + settlement + history archive.
    logTips([...state.matches.values()], state.analyses);
    settleTips(state.matches);
    archiveFinished([...state.matches.values()]);
    const allMock = Object.values(state.leagueStatus).every((s) => s.source === 'mock');
    if ((!db().seededHistory || !db().seededLearn) && (config.dataMode === 'mock' || allMock)) seedMockHistory();
    // AI-motor: pre-match snapshots, outcomes, (re)training when enough new results arrived.
    for (const m of state.matches.values()) if (m.status === 'pre') recordSnapshot(m, state.analyses.get(m.id), { save: false });
    labelFinished([...state.matches.values()]);
    store.save();
    if (maybeTrain()) {
      for (const m of state.matches.values()) { try { state.analyses.set(m.id, analyse(m)); } catch { /* keep previous */ } }
    }
    state.lastUpdate = Date.now(); state.version++;
    log.info('refresh done', { reason, liveOnly, leagues: leagues.length, matches: state.matches.size, ms: Date.now() - t0 });
    emit({ type: 'update', version: state.version, lastUpdate: state.lastUpdate, liveOnly });
    return state.lastUpdate;
  } finally { state.refreshing = false; }
}

// ---------------------------------------------------------------------------
// Read models for the API
// ---------------------------------------------------------------------------
export function matchSummary(m) {
  const a = state.analyses.get(m.id);
  const main = a?.markets?.[0];
  return {
    id: m.id, sport: m.sport, league: m.league, leagueName: m.leagueName, startTime: m.startTime, status: m.status, statusText: m.statusText,
    home: m.home, away: m.away, venue: m.venue, live: m.live || null, setScores: m.setScores || m.live?.setScores || null, surface: m.surface, tournament: m.tournament,
    dataStatus: m.dataStatus, fetchedAt: m.fetchedAt, provider: m.provider,
    tip: a?.tip || null, confidence: a?.confidence ?? null, coverage: a?.coverage ?? null,
    main: main ? { key: main.key, label: main.label, selections: main.selections } : null,
    manualOddsCount: Object.keys(db().manualOdds[m.id] || {}).length,
  };
}

export function matchDetail(id) {
  const m = state.matches.get(id); if (!m) return null;
  const a = state.analyses.get(id);
  const history = m.oddsHistoryMock || db().oddsHistory[id] || {};
  const { odds: _odds, oddsHistoryMock: _h, ...rest } = m; void _odds; void _h;
  return { ...matchSummary(m), match: rest, analysis: a, oddsHistory: history, manualOdds: db().manualOdds[id] || {} };
}

function blendP(s) {
  if (s.oddsSource === 'estimated') return s.p;
  const pm = s.novig ?? Math.min(0.99, (1 / s.odds) / 1.05);
  return 0.5 * s.p + 0.5 * pm;
}

/** Candidate legs for the bet builders, from the latest analyses. */
export function legCandidates() {
  const out = [];
  for (const [id, a] of state.analyses) {
    const m = state.matches.get(id); if (!m || m.status === 'post') continue;
    for (const mk of a.markets) {
      for (const s of mk.selections) {
        if (s.p >= 0.985 || s.odds < 1.05) continue; // nothing left to bet on
        out.push({
          id: s.id, matchId: id, sport: m.sport, league: m.league, leagueName: m.leagueName, day: localDay(Date.parse(m.startTime)),
          matchName: `${m.home.name} – ${m.away.name}`, startTime: m.startTime, status: m.status, statusText: m.statusText,
          market: mk.key, marketLabel: mk.label, family: mk.family, line: mk.line ?? null, selection: s.key, label: s.label, name: s.name,
          // Tickets use a market-blended probability to curb compounding model error:
          //   p = 0.5·p_model + 0.5·p_market  (p_market = vig-free, else implied/1.05)
          pModel: s.p, p: blendP(s), odds: s.odds, oddsSource: s.oddsSource, ev: blendP(s) * s.odds - 1, dataStatus: m.dataStatus,
          confidence: confidenceScore({ cov: a.coverage, pSpec: null, pW: s.p, pPick: s.p, nOutcomes: mk.selections.length === 3 ? 3 : 2, live: m.status === 'live' }),
        });
      }
    }
  }
  // Estimated-odds legs stay in the pool (the extra markets rarely have bookmaker
  // prices on free plans); they are labelled BECSÜLT on the ticket, and their EV
  // is slightly negative by construction, so priced value legs are preferred.
  return out;
}
