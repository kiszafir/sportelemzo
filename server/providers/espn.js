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
    id: `espn-${league.id}-${ev.id}`, eventId: String(ev.id), provider: 'espn', sport: league.sport, league: league.id, leagueName: league.name,
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
  // Cup matches decided after extra time / penalties: markets settle on the 90-minute
  // score, taken from the per-half linescores when ESPN provides them.
  if (league.sport === 'football' && state === 'post') {
    const st = comp.status?.type || {};
    if (/AET|PEN/i.test(st.name || '') || /AET|pen|extra/i.test(`${st.detail || ''} ${st.shortDetail || ''}`)) {
      m.extraTime = true;
      const reg = (c) => { const ls = (c.linescores || []).map((x) => Number(x.value)); return ls.length >= 2 && ls.slice(0, 2).every(Number.isFinite) ? ls[0] + ls[1] : null; };
      const rh = reg(home); const ra = reg(away);
      if (rh != null && ra != null) m.regScore = { home: rh, away: ra };
      m.statusText = /PEN/i.test(st.name || '') || /pen/i.test(st.detail || '') ? 'Vége (11-esek)' : 'Vége (hossz.)';
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


// ---------------------------------------------------------------------------
// Injury report (league-wide, one request) and box scores (game summary)
// ---------------------------------------------------------------------------
const INJ_TYPE_HU = { knee: 'térd', ankle: 'boka', hamstring: 'combhajlító', foot: 'lábfej', back: 'hát', hip: 'csípő', shoulder: 'váll', groin: 'ágyék', calf: 'vádli',
  illness: 'betegség', concussion: 'agyrázkódás', wrist: 'csukló', hand: 'kéz', finger: 'ujj', thumb: 'hüvelykujj', achilles: 'Achilles-ín', 'upper body': 'felsőtest', 'lower body': 'alsótest',
  personal: 'személyes ok', rest: 'pihentetés', elbow: 'könyök', neck: 'nyak', quadriceps: 'combfeszítő', quad: 'combfeszítő', leg: 'láb', toe: 'lábujj', head: 'fej', face: 'arc', eye: 'szem',
  abdomen: 'has', oblique: 'oldalizom', chest: 'mellkas', ribs: 'bordák', shin: 'sípcsont', heel: 'sarok', 'not injury related': 'nem sérülés', suspension: 'eltiltás', undisclosed: 'nem közölt' };
const injTypeHu = (t) => { if (!t) return 'sérülés'; const k = String(t).toLowerCase(); return INJ_TYPE_HU[k] || Object.entries(INJ_TYPE_HU).find(([e]) => k.includes(e))?.[1] || t; };

/** ESPN status → { status (HU), playProb }. */
export function injuryStatus(raw, typeName = '') {
  const s = `${raw || ''} ${typeName || ''}`.toLowerCase();
  if (/suspen/.test(s)) return { status: 'eltiltva', playProb: 0 };
  if (/\bout\b|injured reserve|\bir\b|ltir|long[- ]term|season|inactive|_out/.test(s)) return { status: 'kiesik', playProb: 0 };
  if (/doubtful/.test(s)) return { status: 'kétséges', playProb: 0.25 };
  if (/questionable|game[- ]time|gtd/.test(s)) return { status: 'kétséges', playProb: 0.5 };
  if (/day[- ]to[- ]day|dtd/.test(s)) return { status: 'kétséges', playProb: 0.6 };
  if (/probable/.test(s)) return { status: 'valószínűleg játszik', playProb: 0.85 };
  return { status: 'kétséges', playProb: 0.5 };
}

/** League injuries endpoint → { teams: { [teamName]: [entry] } }. Defensive parsing. */
export function parseInjuries(json, now = Date.now()) {
  const teams = {};
  for (const t of json?.injuries || []) {
    const team = t.displayName || t.team?.displayName; if (!team) continue;
    const list = [];
    for (const it of t.injuries || []) {
      const name = it.athlete?.displayName || it.athlete?.fullName; if (!name) continue;
      const { status, playProb } = injuryStatus(it.status || it.details?.fantasyStatus?.description, it.type?.name || it.type?.description);
      const date = Date.parse(it.date) || null;
      list.push({
        name, status, playProb, statusRaw: it.status || null, type: injTypeHu(it.details?.type || it.type?.description),
        detail: it.details?.detail || null, returnDate: it.details?.returnDate || null, date: date ? new Date(date).toISOString() : null,
        fresh: date ? now - date < 48 * 3600e3 : false, comment: (it.shortComment || '').slice(0, 300) || null, impact: 0.3,
      });
    }
    teams[team] = list;
  }
  return { teams };
}

const num = (x) => { const v = parseFloat(String(x ?? '').split('-')[0]); return Number.isFinite(v) ? v : null; };
const minutes = (x) => { if (x == null || x === '' || x === '--') return null; const [m, s] = String(x).split(':'); const v = Number(m) + (Number(s) || 0) / 60; return Number.isFinite(v) ? v : null; };

/** Game summary → compact box score { home:{name, players:{…}}, away:{…} } or null. */
export function parseBoxscore(json, sport) {
  const bx = json?.boxscore; if (!bx?.players?.length) return null;
  const comps = json?.header?.competitions?.[0]?.competitors || [];
  const sideOfId = {}; for (const c of comps) if (c.team?.id) sideOfId[String(c.team.id)] = c.homeAway;
  const out = {};
  bx.players.forEach((tm, idx) => {
    const side = sideOfId[String(tm.team?.id)] || tm.homeAway || (idx === 0 ? 'away' : 'home');
    const players = {};
    for (const grp of tm.statistics || []) {
      const keys = (grp.keys || grp.names || []).map((k) => String(k).toLowerCase());
      const labels = (grp.labels || []).map((k) => String(k).toUpperCase());
      if (keys.some((k) => /saves|goalsagainst/.test(k)) || /goalie/i.test(grp.name || grp.text || '')) continue; // goalies
      const at = (ks, ls) => { for (const k of ks) { const i = keys.indexOf(k.toLowerCase()); if (i >= 0) return i; } for (const l of ls) { const i = labels.indexOf(l); if (i >= 0) return i; } return -1; };
      const I = sport === 'nba'
        ? { min: at(['minutes'], ['MIN']), pts: at(['points'], ['PTS']), reb: at(['rebounds', 'totalRebounds'], ['REB']), ast: at(['assists'], ['AST']),
          tpm: at(['threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'threePointFieldGoalsMade'], ['3PT', '3PM']), stl: at(['steals'], ['STL']), blk: at(['blocks'], ['BLK']) }
        : { toi: at(['timeOnIce'], ['TOI']), g: at(['goals'], ['G']), a: at(['assists'], ['A']), sog: at(['shotsTotal', 'shotsOnGoal', 'shots'], ['S', 'SOG']) };
      if ((sport === 'nba' && I.pts < 0) || (sport === 'nhl' && I.g < 0)) continue;
      for (const a of grp.athletes || []) {
        const name = a.athlete?.displayName || a.athlete?.fullName; if (!name) continue;
        const st = a.stats || [];
        if (a.didNotPlay || !st.length) { players[name] = { dnp: true }; continue; }
        const line = {};
        for (const [k, i] of Object.entries(I)) { if (i < 0) continue; line[k] = k === 'min' || k === 'toi' ? minutes(st[i]) : num(st[i]); }
        if (sport === 'nba' && !(line.min > 0)) { players[name] = { dnp: true }; continue; }
        if (a.starter) line.starter = true;
        players[name] = line;
      }
    }
    if (Object.keys(players).length) out[side] = { name: tm.team?.displayName || tm.team?.name || null, players };
  });
  return out.home && out.away ? out : null;
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
    super({ id: 'espn', name: 'ESPN (nyilvános JSON)', kinds: ['fixtures', 'standings', 'odds', 'injuries (NBA, NHL)', 'box scores (NBA, NHL)'], homepage: 'https://www.espn.com',
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


  /** League-wide injury report (NBA, NHL). Cached 30 min; parsed compactly. */
  async injuries(league) {
    if (!['nba', 'nhl'].includes(league.sport)) return null;
    const url = `${BASE}/${league.espn}/injuries`;
    try {
      const res = await cache.wrap(`espn:inj:${league.id}`, 30 * 60e3, async () => parseInjuries(await getJson('espn', url)));
      this.ok();
      return { teams: res.value?.teams || {}, status: res.status, fetchedAt: res.fetchedAt };
    } catch (err) { this.fail(err); throw err; }
  }

  /** Box score of one finished game (summary endpoint), parsed. Not cached here (the caller stores it). */
  async boxscore(league, eventId) {
    const url = `${BASE}/${league.espn}/summary?event=${encodeURIComponent(eventId)}`;
    return parseBoxscore(await getJson('espn', url), league.sport);
  }

  /** Finished event ids of one past day (scoreboard). */
  async finishedEvents(league, day) {
    const json = await getJson('espn', `${BASE}/${league.espn}/scoreboard?dates=${day}`);
    return (json?.events || []).filter((ev) => ev.competitions?.[0]?.status?.type?.state === 'post' || ev.status?.type?.state === 'post')
      .map((ev) => ({ id: String(ev.id), t: Date.parse(ev.date) || null }));
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
