// Player data for NBA / NHL props: box scores of recent games (ESPN game
// summaries), stored compactly in data/boxscores.json, turned into per-player
// profiles (recency-weighted per-game averages, minutes, double-/triple-double
// rates, freshness) and combined with the fresh injury report.
//
// Box scores also settle the player markets: a finished match gets m.box, or
// m.boxState = 'pending' while the summary is not fetched yet (settlement and the
// AI labelling wait), 'failed' when it never arrives (bets are void).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { nameSimilarity } from '../providers/base.js';
import { injuryOf } from '../engine/props.js';

const log = createLogger('players');
const FILE = path.join(config.dataDir, 'boxscores.json');
const KEEP_DAYS = 35;      // box scores kept
const HISTORY_DAYS = 14;   // past days fetched on first start
const MAX_PER_SYNC = 60;   // summaries per league per sync (polite to ESPN)
const SYNC_EVERY_MS = 15 * 60e3;
const ROSTER_GAMES = 15;   // last N team games used for a profile
const DECAY = 0.88;        // recency weight per game

let data = null; let timer = null;
const running = new Map(); const lastSync = new Map();

function load() {
  if (data) return data;
  try { data = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {}; } catch (err) { log.warn('boxscores.json unreadable, starting empty', { err }); data = {}; }
  return data;
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(data)); fs.renameSync(FILE + '.tmp', FILE); } catch (err) { log.warn('boxscores write failed', { err }); }
  }, 500);
}
const leagueData = (id) => { const d = load(); return (d[id] ||= { events: {}, days: {}, fail: {} }); };
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

/** Store a parsed box score (also used by tests). */
export function storeBox(leagueId, eventId, t, box) {
  const L = leagueData(leagueId);
  L.events[String(eventId)] = { t, home: box.home, away: box.away };
  delete L.fail[String(eventId)];
  save();
}

/** Fetch missing box scores: finished matches of the current window first, then the last 14 days. */
export async function syncLeague(league, matches, espn) {
  if (!['nba', 'nhl'].includes(league.sport) || !league.espn) return 0;
  if (running.has(league.id)) return running.get(league.id);
  const job = (async () => {
    const L = leagueData(league.id); const now = Date.now();
    const queue = [];
    for (const m of matches) if (m.status === 'post' && m.eventId && !L.events[m.eventId] && (L.fail[m.eventId] || 0) < 3) queue.push({ id: m.eventId, t: Date.parse(m.startTime), prio: 1 });
    for (let off = 2; off <= HISTORY_DAYS; off++) {
      const day = ymd(now - off * 864e5);
      if (L.days[day]) continue;
      try {
        const evs = await espn.finishedEvents(league, day);
        L.days[day] = evs.map((e) => e.id);
      } catch (err) { log.debug('past scoreboard failed', { league: league.id, day, err: err.message }); break; }
    }
    for (const ids of Object.values(L.days)) for (const id of Array.isArray(ids) ? ids : []) if (!L.events[id] && (L.fail[id] || 0) < 3 && !queue.some((q) => q.id === id)) queue.push({ id, t: 0, prio: 0 });
    queue.sort((a, b) => b.prio - a.prio || b.t - a.t);
    let got = 0;
    const batch = queue.slice(0, MAX_PER_SYNC);
    await Promise.allSettled(batch.map(async (q) => {
      try {
        const box = await espn.boxscore(league, q.id);
        if (!box) throw new Error('no box score in summary');
        L.events[q.id] = { t: q.t || null, home: box.home, away: box.away }; delete L.fail[q.id]; got++;
      } catch (err) { L.fail[q.id] = (L.fail[q.id] || 0) + 1; log.debug('box score failed', { league: league.id, id: q.id, err: err.message }); }
    }));
    // Events without a time (from past scoreboards): keep the day as the time.
    for (const [day, ids] of Object.entries(L.days)) for (const id of Array.isArray(ids) ? ids : []) if (L.events[id] && !L.events[id].t) L.events[id].t = Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), 23);
    // Prune.
    const cut = now - KEEP_DAYS * 864e5;
    for (const [id, e] of Object.entries(L.events)) if (e.t && e.t < cut) delete L.events[id];
    for (const day of Object.keys(L.days)) if (Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) < cut) delete L.days[day];
    lastSync.set(league.id, Date.now());
    if (got) { save(); log.info('box scores synced', { league: league.id, new: got, total: Object.keys(L.events).length, backlog: Math.max(0, queue.length - batch.length) }); }
    else save();
    return got;
  })().finally(() => running.delete(league.id));
  running.set(league.id, job);
  return job;
}

export const syncDue = (leagueId) => !running.has(leagueId) && Date.now() - (lastSync.get(leagueId) || 0) > SYNC_EVERY_MS;
export const syncRunning = (leagueId) => running.has(leagueId);

/** Box score of a finished match, if stored. */
export function boxFor(match) {
  if (!match.eventId) return null;
  const e = load()[match.league]?.events?.[match.eventId];
  return e ? { home: e.home, away: e.away } : null;
}
export function boxState(match) {
  if (boxFor(match)) return 'ok';
  const L = load()[match.league];
  if ((L?.fail?.[match.eventId] || 0) >= 3) return 'failed';
  return Date.now() - Date.parse(match.startTime) > 30 * 3600e3 ? 'failed' : 'pending';
}

const sameTeam = (a, b) => a && b && (a === b || nameSimilarity(a, b) >= 0.9);

/** Team's recent games, newest first: [{ t, players }] */
export function teamGames(leagueId, teamName, n = ROSTER_GAMES) {
  const ev = Object.values(load()[leagueId]?.events || {});
  const out = [];
  for (const e of ev) {
    for (const side of ['home', 'away']) if (sameTeam(e[side]?.name, teamName)) out.push({ t: e.t || 0, players: e[side].players || {} });
  }
  return out.sort((a, b) => b.t - a.t).slice(0, n);
}

/**
 * Player profiles of a team from its recent box scores.
 * NBA: min, pts, reb, ast, tpm, stl, blk, ddRate, tdRate. NHL: toi, g, a, sog.
 * fresh = recency-weighted share of the team's games the player played.
 */
export function buildRoster(leagueId, sport, teamName) {
  const games = teamGames(leagueId, teamName);
  if (games.length < 2) return null;
  const isNba = sport === 'nba';
  const K = isNba ? ['min', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk'] : ['toi', 'g', 'a', 'sog'];
  const W = games.map((_, i) => DECAY ** i); const Wt = W.reduce((a, b) => a + b, 0);
  const acc = {};
  games.forEach((g, i) => {
    for (const [name, line] of Object.entries(g.players)) {
      if (!line || line.dnp) continue;
      if (isNba && !(line.min > 0)) continue;
      const a = (acc[name] ||= { name, gp: 0, w: 0, sums: {}, dd: 0, td: 0, recent: [] });
      a.gp++; a.w += W[i];
      for (const k of K) a.sums[k] = (a.sums[k] || 0) + W[i] * (Number(line[k]) || 0);
      if (isNba) {
        const c = ['pts', 'reb', 'ast', 'stl', 'blk'].filter((k) => (Number(line[k]) || 0) >= 10).length;
        if (c >= 2) a.dd += W[i]; if (c >= 3) a.td += W[i];
        if (a.recent.length < 5) a.recent.push(isNba ? `${line.pts ?? 0}/${line.reb ?? 0}/${line.ast ?? 0}` : '');
      } else if (a.recent.length < 5) a.recent.push(`${line.g ?? 0}+${line.a ?? 0}`);
    }
  });
  const roster = Object.values(acc).map((a) => {
    const p = { name: a.name, gp: a.gp, fresh: Math.round((a.w / Wt) * 1000) / 1000, recent: a.recent };
    for (const k of K) p[k] = a.sums[k] / a.w;
    if (isNba) { p.ddRate = a.dd / a.w; p.tdRate = a.td / a.w; }
    return p;
  }).sort((x, y) => (isNba ? y.min * y.fresh - x.min * x.fresh : y.toi * y.fresh - x.toi * x.fresh)).slice(0, isNba ? 15 : 20);
  const teamAvg = {};
  for (const k of K) teamAvg[k] = roster.reduce((s, p) => s + p[k] * p.fresh, 0);
  return { roster, teamAvg, games: games.length, lastGame: games[0].t };
}

/** Injury impact from the player's share of recent team production (0.05–1). */
export function injuryImpact(sport, roster, name) {
  const p = roster?.find((x) => injuryOf(x.name, [{ name }]));
  if (!p) return 0.1; // not in the recent box scores: long-term absence, already priced in
  const prod = (q) => (sport === 'nba' ? q.pts + 0.5 * q.reb + 0.7 * q.ast : q.g + 0.7 * q.a);
  const team = roster.reduce((s, q) => s + prod(q) * q.fresh, 0) || 1;
  return Math.round(Math.min(1, Math.max(0.05, (prod(p) * p.fresh / team) * (sport === 'nba' ? 2.2 : 3))) * 100) / 100;
}

/**
 * Attach roster, injuries and (finished matches) the box score to a live match.
 * @param inj  ESPN injury report { teams, status, fetchedAt } or null
 */
export function applyPlayerData(league, m, inj) {
  if (!['nba', 'nhl'].includes(league.sport)) return;
  const findInj = (name) => {
    if (!inj?.teams) return null;
    if (inj.teams[name]) return inj.teams[name];
    let best = null; let bs = 0.8;
    for (const [k, v] of Object.entries(inj.teams)) { const s = nameSimilarity(k, name); if (s > bs) { best = v; bs = s; } }
    return best || [];
  };
  let anyRoster = false;
  for (const side of ['home', 'away']) {
    const st = (m.stats[side] ||= {});
    const r = buildRoster(league.id, league.sport, m[side].name);
    if (r) {
      anyRoster = true;
      st.roster = r.roster; st.teamAvg = r.teamAvg; st.rosterSrc = { games: r.games, lastGame: r.lastGame, src: 'ESPN box score' };
      if (league.sport === 'nhl') {
        // Goalscorer market from the box scores: goal share of the top scorers (not the injured).
        const gpg = r.teamAvg.g || 3;
        st.players = r.roster.filter((p) => p.fresh >= 0.3 && p.g > 0.05 && !(findInj(m[side].name) || []).some((i) => i.playProb === 0 && injuryOf(p.name, [i])))
          .sort((a, b) => b.g - a.g).slice(0, 4).map((p) => ({ name: p.name, share: Math.min(0.45, p.g / gpg), starter: 0.97 }));
        st.playersSrc = 'boxscore';
      }
    }
    if (inj?.teams) {
      const list = findInj(m[side].name) || [];
      st.injuries = list.map((i) => {
        const p = st.roster?.find((x) => injuryOf(x.name, [i]));
        return { ...i, impact: st.roster ? injuryImpact(league.sport, st.roster, i.name) : 0.3, freshAbsence: p ? p.fresh >= 0.35 : false };
      });
    }
  }
  if (inj?.teams) m.meta.injuries = { status: inj.status, fetchedAt: inj.fetchedAt, src: 'ESPN sérüléslista' };
  if (anyRoster) m.meta.players = { status: 'live', fetchedAt: Date.now(), src: 'ESPN box score-ok (utolsó meccsek)' };
  if (m.status === 'post') {
    const box = boxFor(m);
    if (box) { m.box = box; m.boxState = 'ok'; } else m.boxState = boxState(m);
  }
}

/** For the sources page. */
export function playerDataStatus() {
  const d = load();
  return Object.fromEntries(Object.entries(d).map(([id, L]) => [id, { boxScores: Object.keys(L.events || {}).length, days: Object.keys(L.days || {}).length, lastSync: lastSync.get(id) || null }]));
}
