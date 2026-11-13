// API-Sports (API-Football) — optional, needs API_SPORTS_KEY.
// Free plan: 100 requests/day per API, 10 requests/minute.
// Used for:
//   – NB I fixtures, live scores and standings (ESPN does not cover NB I)
//       fixtures: 1 request per refresh, cached 30 min (5 min while an NB I match is live)
//       standings: 1 request / 6 h
//   – football injuries & suspensions: 1 request per league / 24 h, only for
//     leagues with a match in the next 3 days
// Budget ≈ 48 + 4 + ~15 ≈ 67 requests/day; hard cap 90/day.
// Handball uses API-Handball (separate 100/day quota): 4 daily game lists
// shared by all handball leagues + standings every 12 h (≈ 65/day, cap 90).
// API-Football answers plan/permission problems with HTTP 200 and an `errors`
// object, so every response is checked for it.
import { Provider } from './base.js';
import { getJson, registerLimit, HttpError } from '../lib/http.js';
import { cache } from '../lib/cache.js';

const BASE = 'https://v3.football.api-sports.io';
registerLimit('apisports', { minIntervalMs: 6500, dailyQuota: 90 });
// API-Handball is a separate API with its own daily quota (same key).
const HB_BASE = 'https://v1.handball.api-sports.io';
registerLimit('apisports-hb', { minIntervalMs: 6500, dailyQuota: 90 });

const TYPE_HU = (type, reason) => {
  const r = String(reason || '').toLowerCase();
  if (/suspend|card/.test(r)) return { type: 'eltiltás', status: 'eltiltva' };
  return { type: reason || 'sérülés', status: /questionable|doubt/i.test(type) ? 'kétséges' : 'kiesik' };
};

// API-Football fixture status → app status
const PRE = new Set(['TBD', 'NS']);
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
const VOID = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);

export const currentSeason = (d = new Date()) => (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Throws when API-Football reports an error inside a 200 response. */
export function checkApiErrors(json) {
  const e = json?.errors;
  const msgs = Array.isArray(e) ? e : e && typeof e === 'object' ? Object.values(e) : [];
  if (msgs.length) {
    const err = new HttpError(`API-Football: ${msgs.join('; ')}`, 400);
    err.fatal = true;
    throw err;
  }
  return json;
}

export function normaliseFixture(it, league, fetchedAt, status) {
  const f = it.fixture || {}; const short = f.status?.short || 'NS';
  const st = PRE.has(short) ? 'pre' : LIVE.has(short) ? 'live' : 'post';
  const m = {
    id: `as-${league.id}-${f.id}`, provider: 'apisports', sport: 'football', league: league.id, leagueName: league.name,
    startTime: new Date(f.date || f.timestamp * 1000).toISOString(), status: st,
    statusText: st === 'pre' ? 'Közelgő' : st === 'post' ? (VOID.has(short) ? 'Elmaradt / félbeszakadt' : short === 'AET' ? 'Vége (hossz.)' : short === 'PEN' ? 'Vége (11-esek)' : 'Vége') : short === 'HT' ? 'Félidő' : `${f.status?.elapsed ?? ''}'`,
    home: { name: it.teams?.home?.name, score: st === 'pre' ? null : it.goals?.home ?? 0 },
    away: { name: it.teams?.away?.name, score: st === 'pre' ? null : it.goals?.away ?? 0 },
    venue: { name: f.venue?.name || null, city: f.venue?.city || null, indoor: false },
    round: it.league?.round || null,
    stats: { home: {}, away: {} },
    void: VOID.has(short) || undefined,
    dataStatus: status, fetchedAt,
  };
  if (st === 'live') {
    const min = Number(f.status?.elapsed) || 0;
    m.live = { minute: min, elapsedMin: min, clock: m.statusText, periodLabel: short === '1H' ? '1. félidő' : short === 'HT' ? 'Félidő' : short === '2H' ? '2. félidő' : 'Hosszabbítás', redCards: { home: 0, away: 0 } };
  }
  return m;
}

// ---------------------------------------------------------------------------
// Handball (API-Handball)
// ---------------------------------------------------------------------------
const HB_PRE = new Set(['NS', 'TBD']);
const HB_LIVE = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'PT', 'LIVE']);
const HB_VOID = new Set(['POST', 'CANC', 'INTR', 'ABD', 'AW']);
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isWomen = (name) => /\b(women|woman|w|female|noi|ladies)\b/.test(norm(name));

/** Pick the league from a /leagues?country= list that matches { name, women }. */
export function pickHandballLeague(list, { name, women }) {
  const target = norm(name);
  const cands = (list || []).filter((l) => norm(l.name).includes(target) && isWomen(l.name) === !!women);
  // Prefer the shortest matching name (e.g. "Bundesliga" over "2. Bundesliga").
  cands.sort((a, b) => norm(a.name).replace(target, '').length - norm(b.name).replace(target, '').length);
  const l = cands[0]; if (!l) return null;
  const season = (l.seasons || []).find((x) => x.current) || (l.seasons || []).slice(-1)[0];
  return { id: l.id, name: l.name, season: season?.season };
}

export function normaliseHandballGame(g, league, fetchedAt, status) {
  const short = g.status?.short || 'NS';
  const st = HB_PRE.has(short) ? 'pre' : HB_LIVE.has(short) ? 'live' : 'post';
  const start = g.timestamp ? g.timestamp * 1000 : Date.parse(g.date);
  const m = {
    id: `hb-${league.id}-${g.id}`, provider: 'apisports', sport: 'handball', league: league.id, leagueName: league.name,
    startTime: new Date(start).toISOString(), status: st,
    statusText: st === 'pre' ? 'Közelgő' : st === 'post' ? (HB_VOID.has(short) ? 'Elmaradt / félbeszakadt' : short === 'AET' ? 'Vége (hossz.)' : short === 'AP' ? 'Vége (7-esek)' : 'Vége') : short === 'HT' ? 'Félidő' : 'Élő',
    home: { name: g.teams?.home?.name, score: st === 'pre' ? null : Number(g.scores?.home ?? 0) },
    away: { name: g.teams?.away?.name, score: st === 'pre' ? null : Number(g.scores?.away ?? 0) },
    venue: { name: g.venue?.name || g.arena || null, city: null, indoor: true },
    stats: { home: {}, away: {} }, void: HB_VOID.has(short) || undefined,
    dataStatus: status, fetchedAt,
  };
  if (st === 'live') {
    // API-Handball gives no clock: estimate the game minute from kick-off (15-min break).
    const realMin = Math.max(0, (Date.now() - start) / 60e3);
    const g2 = short === '1H' ? Math.min(30, realMin) : short === 'HT' ? 30 : short === '2H' ? Math.min(59.5, 30 + Math.max(0, realMin - 45)) : 60;
    m.live = { elapsedMin: g2, minute: g2, clock: short === 'HT' ? 'Félidő' : `~${Math.ceil(g2)}'`, periodLabel: short === '1H' ? '1. félidő' : short === 'HT' ? 'Félidő' : short === '2H' ? '2. félidő' : 'Hosszabbítás' };
    m.statusText = m.live.clock;
  }
  return m;
}

const budapestDay = (t) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date(t));

class ApiSportsProvider extends Provider {
  constructor() {
    super({ id: 'apisports', name: 'API-Sports (API-Football)', kinds: ['fixtures (NB I, kézilabda)', 'standings (NB I, kézilabda)', 'injuries'], requiresKey: true, keyName: 'apiSports', homepage: 'https://api-sports.io',
      terms: 'Ingyenes csomag: napi 100 kérés API-nként. Csak a saját fiókodhoz kötött kulccsal használható.', freeTier: '100 kérés/nap' });
  }

  get(url) { return getJson('apisports', url, { headers: { 'x-apisports-key': this.key }, retries: 1 }).then(checkApiErrors); }

  /** Fixtures yesterday … +3 days (one request). */
  async fixtures(league, { hasLive = false } = {}) {
    if (!league.as) return null;
    const now = Date.now();
    const url = `${BASE}/fixtures?league=${league.as}&season=${currentSeason()}&from=${isoDay(now - 864e5)}&to=${isoDay(now + 3 * 864e5)}&timezone=UTC`;
    try {
      const res = await cache.wrap(`apisports:fx:${league.id}`, (hasLive ? 5 : 30) * 60e3, () => this.get(url));
      this.ok();
      const matches = (res.value?.response || []).map((it) => normaliseFixture(it, league, res.fetchedAt, res.status)).filter((m) => m.home.name && m.away.name);
      return { matches, status: res.status, fetchedAt: res.fetchedAt };
    } catch (err) { this.fail(err); throw err; }
  }

  /** Standings → season stats per team. */
  async standings(league) {
    if (!league.as) return null;
    try {
      const res = await cache.wrap(`apisports:st:${league.id}`, 6 * 3600e3, () => this.get(`${BASE}/standings?league=${league.as}&season=${currentSeason()}`));
      this.ok();
      const table = res.value?.response?.[0]?.league?.standings?.[0] || [];
      const teams = {};
      for (const r of table) {
        const gp = r.all?.played; if (!gp) continue;
        teams[r.team?.name] = {
          gamesPlayed: gp, position: r.rank, ppg: r.points / gp, winPct: r.all.win / gp,
          gfPg: r.all.goals?.for / gp, gaPg: r.all.goals?.against / gp,
          homeWinPct: r.home?.played ? r.home.win / r.home.played : undefined,
          awayWinPct: r.away?.played ? r.away.win / r.away.played : undefined,
        };
      }
      return { teams, status: res.status, fetchedAt: res.fetchedAt, leagueSize: table.length };
    } catch (err) { this.fail(err); throw err; }
  }

  hbGet(url) { return getJson('apisports-hb', url, { headers: { 'x-apisports-key': this.key }, retries: 1 }).then(checkApiErrors); }

  /** Resolve the API-Handball league id + current season (cached 30 days per country). */
  async handballLeague(league) {
    const res = await cache.wrap(`apisports:hb:leagues:${league.hb.country}`, 30 * 24 * 3600e3, () => this.hbGet(`${HB_BASE}/leagues?country=${encodeURIComponent(league.hb.country)}`));
    const found = pickHandballLeague(res.value?.response, league.hb);
    if (!found) { const e = new HttpError(`API-Handball: nem található bajnokság (${league.hb.country} / ${league.hb.name}${league.hb.women ? ', női' : ''})`, 404); e.fatal = true; throw e; }
    return found;
  }

  /**
   * Handball games yesterday … +2 days (Budapest days). One request per DAY covers
   * every league, so the five handball leagues share the same 4 cached requests.
   */
  async handballFixtures(league, { hasLive = false } = {}) {
    try {
      const L = await this.handballLeague(league);
      const now = Date.now(); const results = [];
      for (const off of [-1, 0, 1, 2]) {
        const day = budapestDay(now + off * 864e5);
        const ttl = off === 0 ? (hasLive ? 10 : 40) * 60e3 : off < 0 ? 6 * 3600e3 : 4 * 3600e3;
        try { results.push(await cache.wrap(`apisports:hb:games:${day}`, ttl, () => this.hbGet(`${HB_BASE}/games?date=${day}&timezone=Europe/Budapest`))); }
        catch (err) { if (off === 0) throw err; }
      }
      this.ok();
      const matches = [];
      for (const res of results) {
        for (const g of res.value?.response || []) {
          if (g.league?.id !== L.id) continue;
          const m = normaliseHandballGame(g, league, res.fetchedAt, res.status);
          if (m.home.name && m.away.name) matches.push(m);
        }
      }
      return { matches, status: results.some((r) => r.status === 'cached') ? 'cached' : 'live', fetchedAt: Math.min(...results.map((r) => r.fetchedAt)), resolved: L };
    } catch (err) { this.fail(err); throw err; }
  }

  async handballStandings(league) {
    try {
      const L = await this.handballLeague(league);
      const res = await cache.wrap(`apisports:hb:st:${league.id}`, 12 * 3600e3, () => this.hbGet(`${HB_BASE}/standings?league=${L.id}&season=${L.season}`));
      const rows = (res.value?.response || []).flat(2);
      const teams = {};
      for (const r of rows) {
        const gp = r.games?.played; if (!gp || !r.team?.name) continue;
        const w = r.games.win?.total ?? 0; const d = r.games.draw?.total ?? 0;
        teams[r.team.name] = { gamesPlayed: gp, position: r.position, winPct: w / gp, ppg: (r.points ?? 2 * w + d) / gp, gfPg: r.goals?.for / gp, gaPg: r.goals?.against / gp };
      }
      return { teams, status: res.status, fetchedAt: res.fetchedAt, leagueSize: Object.keys(teams).length };
    } catch (err) { this.fail(err); throw err; }
  }

  /** League top scorers → players per team (for the anytime-goalscorer market). Cached 24 h. */
  async topScorers(league) {
    if (league.sport !== 'football' || !league.as) return null;
    try {
      const res = await cache.wrap(`apisports:ts:${league.id}`, 24 * 3600e3, () => this.get(`${BASE}/players/topscorers?league=${league.as}&season=${currentSeason()}`));
      this.ok();
      const byTeam = {};
      for (const it of res.value?.response || []) {
        const st = it.statistics?.[0]; const team = st?.team?.name; const goals = st?.goals?.total;
        if (!team || !(goals > 0)) continue;
        (byTeam[team] ||= []).push({ name: it.player?.name, goals, apps: st.games?.appearences || 0, minutes: st.games?.minutes || 0 });
      }
      return { teams: byTeam, status: res.status, fetchedAt: res.fetchedAt };
    } catch (err) { this.fail(err); throw err; }
  }

  async injuries(league) {
    if (league.sport !== 'football' || !league.as) return null;
    const url = `${BASE}/injuries?league=${league.as}&season=${currentSeason()}`;
    try {
      const res = await cache.wrap(`apisports:inj:${league.id}`, 24 * 3600e3, () => this.get(url));
      this.ok();
      const soon = Date.now() + 8 * 24 * 3600e3; const past = Date.now() - 24 * 3600e3;
      const byTeam = {};
      for (const it of res.value?.response || []) {
        const t = Date.parse(it.fixture?.date); if (!(t > past && t < soon)) continue;
        const name = it.team?.name; if (!name) continue;
        const { type, status } = TYPE_HU(it.player?.type, it.player?.reason);
        (byTeam[name] ||= []).push({ name: it.player?.name, type, status, impact: 0.3 });
      }
      return { teams: byTeam, status: res.status, fetchedAt: res.fetchedAt };
    } catch (err) { this.fail(err); throw err; }
  }
}

export const apiSports = new ApiSportsProvider();
