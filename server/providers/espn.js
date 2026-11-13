// ESPN public JSON endpoints (no key). Undocumented and may change without notice:
// every field is read defensively and anything missing is marked unavailable.
import { Provider } from './base.js';
import { getJson, registerLimit } from '../lib/http.js';
import { cache } from '../lib/cache.js';
import { americanToDecimal } from '../engine/odds.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports';
registerLimit('espn', { minIntervalMs: 60, concurrency: 6 });

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

function parseRecord(summary, sport) {
  if (!summary || typeof summary !== 'string') return null;
  const n = summary.split('-').map(Number);
  if (n.some((x) => !Number.isFinite(x))) return null;
  if (sport === 'football' && n.length === 3) { const [w, d, l] = n; const g = w + d + l; return g ? { winPct: w / g, gp: g, w, d, l } : null; }
  const [w, l, otl = 0] = n; const g = w + l + otl;
  return g ? { winPct: w / g, gp: g, w, l } : null;
}

const STATE = { pre: 'pre', in: 'live', post: 'post' };

export function normaliseTeamEvent(ev, league, now) {
  const comp = ev.competitions?.[0]; if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === 'home'); const away = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  const state = STATE[comp.status?.type?.state] || 'pre';
  const rec = (c, type) => c.records?.find((r) => r.type === type || r.name === type)?.summary;
  const side = (c) => {
    const tot = parseRecord(rec(c, 'total') || c.records?.[0]?.summary, league.sport);
    const homeRec = parseRecord(rec(c, 'home'), league.sport); const roadRec = parseRecord(rec(c, 'road') || rec(c, 'away'), league.sport);
    const form = typeof c.form === 'string' ? c.form.split('').filter((x) => 'WDL'.includes(x)).reverse() : null; // ESPN: newest first
    return {
      team: { id: c.team?.id, name: c.team?.displayName || c.team?.name, short: c.team?.abbreviation, score: state === 'pre' ? null : Number(c.score) },
      stats: { winPct: tot?.winPct, gamesPlayed: tot?.gp, homeWinPct: homeRec?.winPct, awayWinPct: roadRec?.winPct, form: form?.length ? form : undefined },
    };
  };
  const h = side(home); const a = side(away);
  const m = {
    id: `espn-${league.id}-${ev.id}`, provider: 'espn', sport: league.sport, league: league.id, leagueName: league.name,
    startTime: new Date(comp.date || ev.date).toISOString(), status: state,
    statusText: state === 'pre' ? 'Közelgő' : state === 'post' ? 'Vége' : (comp.status?.type?.shortDetail || 'Élő'),
    home: h.team, away: a.team,
    venue: { name: comp.venue?.fullName || null, city: comp.venue?.address?.city || null, country: comp.venue?.address?.country || null, indoor: comp.venue?.indoor ?? (league.sport !== 'football') },
    stats: { home: h.stats, away: a.stats },
    dataStatus: 'live', fetchedAt: now,
  };
  if (state === 'live') {
    const period = comp.status?.period; const clock = comp.status?.displayClock;
    m.live = { period, clock: comp.status?.type?.shortDetail || clock, periodLabel: comp.status?.type?.detail };
    if (league.sport === 'nba') m.live.elapsedMin = Math.min(48, (period - 1) * 12 + (12 - clockMin(clock)));
    if (league.sport === 'nhl') m.live.elapsedMin = Math.min(60, (period - 1) * 20 + (20 - clockMin(clock)));
    if (league.sport === 'football') { const min = parseInt(String(clock).replace(/[^0-9]/g, ''), 10); m.live.minute = Number.isFinite(min) ? min : 45; m.live.elapsedMin = m.live.minute; }
    // In-game team stats when present (soccer: possession, cards, fouls).
    const st = (c, name) => Number(c.statistics?.find((s) => s.name === name)?.displayValue);
    if (league.sport === 'football') {
      const ph = st(home, 'possessionPct'); if (Number.isFinite(ph)) m.live.possession = { home: ph / 100, away: 1 - ph / 100 };
      m.live.redCards = { home: st(home, 'redCards') || 0, away: st(away, 'redCards') || 0 };
      m.live.fouls = { home: st(home, 'foulsCommitted'), away: st(away, 'foulsCommitted') };
    }
  }
  // Player leaders: NBA points per game (player props), NHL season goals (goalscorer market).
  const leader = (c, rx) => {
    const L = (c.leaders || []).find((l) => rx.test(l.name || '') || rx.test(l.abbreviation || ''));
    const x = L?.leaders?.[0];
    return x?.athlete ? { name: x.athlete.displayName || x.athlete.fullName, value: Number(x.value ?? parseFloat(x.displayValue)) } : null;
  };
  for (const [c, sd] of [[home, 'home'], [away, 'away']]) {
    if (league.sport === 'nba' && state === 'pre') { const l = leader(c, /points/i); if (l && l.value > 5 && l.value < 60) m.stats[sd].players = [{ name: l.name, ppg: l.value, starter: 0.92 }]; }
    if (league.sport === 'nhl' && state !== 'post') { const l = leader(c, /^goals$/i); if (l && l.value >= 0) m.stats[sd].leaderGoals = l; }
  }
  if (league.sport === 'nba' && state === 'post') {
    const pp = {};
    for (const c of [home, away]) { const l = leader(c, /^points$|^pts$/i); if (l && Number.isFinite(l.value)) pp[l.name] = l.value; }
    if (Object.keys(pp).length) m.playerPoints = pp; // only the game's points leaders: other players settle as void
  }
  // Soccer: goalscorers and yellow cards (live and finished matches).
  if (league.sport === 'football' && state !== 'pre') {
    const det = Array.isArray(comp.details) ? comp.details : [];
    const sideOf = (tid) => (String(tid) === String(home.team?.id) ? 'home' : String(tid) === String(away.team?.id) ? 'away' : null);
    const sc = { home: [], away: [] }; let named = 0; let ownGoals = 0;
    for (const d of det) {
      if (!d.scoringPlay) continue;
      if (d.ownGoal || /own goal/i.test(d.type?.text || '')) { ownGoals++; continue; }
      const nm = d.athletesInvolved?.[0]?.displayName; const sd = sideOf(d.team?.id);
      if (nm && sd) { sc[sd].push(nm); named++; }
    }
    const goals = (Number(home.score) || 0) + (Number(away.score) || 0);
    // trust the list only if it explains every goal
    if (named + ownGoals === goals) { m.scorers = sc; if (m.live) m.live.scorers = sc; }
    const yc = (c) => { const v = Number(c.statistics?.find((x) => x.name === 'yellowCards')?.displayValue); return Number.isFinite(v) ? v : null; };
    let yh = yc(home); let ya = yc(away);
    if ((yh == null || ya == null) && det.some((d) => d.yellowCard)) {
      yh = det.filter((d) => d.yellowCard && sideOf(d.team?.id) === 'home').length; ya = det.filter((d) => d.yellowCard && sideOf(d.team?.id) === 'away').length;
    }
    if (yh != null && ya != null) { m.cards = { home: yh, away: ya }; if (m.live) m.live.cards = { home: { y: yh, r: m.live.redCards?.home || 0 }, away: { y: ya, r: m.live.redCards?.away || 0 } }; }
  }
  // Embedded odds (provider varies; American moneylines).
  const o = comp.odds?.[0];
  if (o) {
    const book = o.provider?.name || 'ESPN odds';
    const q = (american) => { const d = americanToDecimal(american); return d ? [{ book, odds: Math.round(d * 100) / 100, src: 'live', t: now }] : []; };
    m.odds = {};
    const mlH = o.homeTeamOdds?.moneyLine ?? o.moneyline?.home?.close?.odds; const mlA = o.awayTeamOdds?.moneyLine ?? o.moneyline?.away?.close?.odds;
    if (league.sport === 'football') {
      const dr = o.drawOdds?.moneyLine ?? o.moneyline?.draw?.close?.odds;
      if (mlH && mlA && dr) m.odds['1x2'] = { home: q(mlH), draw: q(dr), away: q(mlA) };
    } else if (mlH && mlA) m.odds.ml = { home: q(mlH), away: q(mlA) };
    if (Number.isFinite(Number(o.overUnder))) {
      m.lines = { ...(m.lines || {}), total: Number(o.overUnder) };
      const ov = o.overOdds ?? o.total?.over?.close?.odds; const un = o.underOdds ?? o.total?.under?.close?.odds;
      const key = league.sport === 'football' ? `ou${String(o.overUnder).replace('.', '')}` : 'total';
      if (ov && un) m.odds[key] = { over: q(ov), under: q(un) };
    }
    if (league.sport === 'nba' && Number.isFinite(Number(o.spread))) m.lines = { ...(m.lines || {}), spread: Number(o.spread) };
  }
  return m;
}

const clockMin = (c) => { const [mm, ss] = String(c || '0:0').split(':').map(Number); return (mm || 0) + (ss || 0) / 60; };

export function normaliseTennis(ev, league, now) {
  const out = [];
  const groups = ev.groupings?.length ? ev.groupings : [{ competitions: ev.competitions || [] }];
  for (const g of groups) {
    const gname = g.grouping?.displayName || '';
    if (/double|páros/i.test(gname)) continue; // singles only
    for (const comp of g.competitions || []) {
      const cs = comp.competitors || []; if (cs.length !== 2) continue;
      const [c1, c2] = [...cs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const state = STATE[comp.status?.type?.state] || 'pre';
      const sets = (c) => (c.linescores || []).map((l) => Number(l.value));
      const s1 = sets(c1); const s2 = sets(c2);
      let w1 = 0, w2 = 0;
      s1.forEach((v, i) => { const u = s2[i]; if (!Number.isFinite(v) || !Number.isFinite(u)) return; const done = state === 'post' || i < s1.length - 1; if (!done) return; if (v > u) w1++; else if (u > v) w2++; });
      const nm = (c) => c.athlete?.displayName || c.athlete?.fullName || c.team?.displayName || 'Ismeretlen';
      const rank = (c) => c.curatedRank?.current ?? c.athlete?.rank ?? null;
      const m = {
        id: `espn-${league.id}-${comp.id}`, provider: 'espn', sport: 'tennis', league: league.id, leagueName: league.name,
        startTime: new Date(comp.date || comp.startDate || ev.date).toISOString(), status: state,
        statusText: state === 'pre' ? 'Közelgő' : state === 'post' ? 'Vége' : (comp.status?.type?.shortDetail || 'Élő'),
        home: { name: nm(c1), score: state === 'pre' ? null : w1, sets: w1 }, away: { name: nm(c2), score: state === 'pre' ? null : w2, sets: w2 },
        tournament: ev.name || ev.shortName, venue: { name: ev.venue?.fullName || ev.name, city: ev.venue?.address?.city || null, indoor: null },
        surface: null, bestOf: /grand slam|australian open|roland|wimbledon|us open/i.test(ev.name || '') && /men/i.test(gname) ? 5 : 3,
        round: comp.round?.displayName || null,
        stats: { home: { rank: Number(rank(c1)) || undefined }, away: { rank: Number(rank(c2)) || undefined } },
        setScores: s1.map((v, i) => `${v}-${s2[i] ?? '-'}`).join(', '),
        retired: /ret/i.test(comp.status?.type?.detail || ''),
        dataStatus: 'live', fetchedAt: now,
      };
      if (state === 'live') m.live = { clock: comp.status?.type?.shortDetail, periodLabel: `${s1.length}. szett`, setScores: m.setScores };
      out.push(m);
    }
  }
  return out;
}

class EspnProvider extends Provider {
  constructor() {
    super({ id: 'espn', name: 'ESPN (nyilvános JSON)', kinds: ['fixtures', 'standings', 'odds'], homepage: 'https://www.espn.com',
      terms: 'Nem hivatalos, dokumentálatlan végpontok; kizárólag személyes, nem kereskedelmi használatra. Bármikor megváltozhatnak.', freeTier: 'Kulcs nélkül' });
  }

  /**
   * Scoreboard for yesterday … +2 days.
   * ESPN rejects date ranges (YYYYMMDD-YYYYMMDD → HTTP 400), so each day is a
   * separate request: dates=YYYYMMDD. Days are cached separately. Yesterday and
   * today use the caller's TTL (late US games fall on "yesterday" in UTC);
   * future days are refreshed at most every 5 minutes. ttl in ms.
   */
  async fixtures(league, ttlMs) {
    const now = Date.now();
    const offsets = [-1, 0, 1, 2];
    const settled = await Promise.allSettled(offsets.map((off) => {
      const day = ymd(new Date(now + off * 24 * 3600e3));
      const url = `${BASE}/${league.espn}/scoreboard?dates=${day}`;
      const ttl = off > 0 ? Math.max(ttlMs, 5 * 60e3) : ttlMs;
      return cache.wrap(`espn:sb:${league.id}:${day}`, ttl, () => getJson('espn', url));
    }));
    const results = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value);
    const lastErr = settled.find((x) => x.status === 'rejected')?.reason || null;
    if (!results.length) { this.fail(lastErr); throw lastErr; }
    this.ok();
    const seen = new Set(); const matches = [];
    for (const res of results) {
      const events = res.value?.events || [];
      const ms = league.sport === 'tennis'
        ? events.flatMap((ev) => normaliseTennis(ev, league, res.fetchedAt))
        : events.map((ev) => normaliseTeamEvent(ev, league, res.fetchedAt)).filter(Boolean);
      for (const m of ms) {
        if (seen.has(m.id)) continue; // tennis tournaments span several days
        seen.add(m.id); m.dataStatus = res.status; m.fetchedAt = res.fetchedAt; matches.push(m);
      }
    }
    const status = results.some((r) => r.status === 'cached') || lastErr ? 'cached' : 'live';
    return { matches, status, fetchedAt: Math.min(...results.map((r) => r.fetchedAt)) };
  }

  async standings(league) {
    if (league.sport === 'tennis') return null;
    const url = `${STANDINGS}/${league.espn}/standings`;
    const res = await cache.wrap(`espn:st:${league.id}`, 6 * 3600e3, () => getJson('espn', url));
    const entries = [];
    const walk = (n) => { if (!n) return; if (n.standings?.entries) entries.push(...n.standings.entries); (n.children || []).forEach(walk); };
    walk(res.value);
    const out = {};
    for (const e of entries) {
      const s = Object.fromEntries((e.stats || []).map((x) => [x.name || x.type, Number(x.value)]));
      const gp = s.gamesPlayed || (s.wins + s.losses + (s.ties || 0) + (s.otLosses || 0));
      const name = e.team?.displayName; if (!name || !gp) continue;
      const t = { gamesPlayed: gp };
      if (league.sport === 'football') {
        t.gfPg = s.pointsFor / gp; t.gaPg = s.pointsAgainst / gp; t.ppg = s.points / gp; t.position = s.rank || null;
      } else if (league.sport === 'nba') {
        t.ppg = s.avgPointsFor || s.pointsFor / gp; t.oppPpg = s.avgPointsAgainst || s.pointsAgainst / gp;
      } else if (league.sport === 'nhl') {
        t.gfPg = s.pointsFor / gp; t.gaPg = s.pointsAgainst / gp;
      }
      out[name] = t;
    }
    return { teams: out, status: res.status, fetchedAt: res.fetchedAt, leagueSize: entries.length };
  }
}

export const espn = new EspnProvider();
