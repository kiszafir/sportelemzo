// Combination (accumulator) engine with constraints:
//   – min/max total odds, leg-count limits
//   – no conflicting legs from the same match
//   – correlation penalty for same-match legs (Brutális allows them, Könnyű does not)
//   – locked legs are always kept, the rest is regenerated
// Pure functions: candidates in, tickets out (deterministic for a given seed).
import { rng } from './mathutil.js';
import { combineOdds, round } from './odds.js';

const TOTAL_SPORTS = 5; // NBA, NHL, tenisz, labdarúgás, kézilabda

export const MODES = {
  easy: {
    id: 'easy', label: 'Könnyű mix', minOdds: 1.3, maxOdds: 10, minLegs: 2, maxLegs: 6,
    leg: { minP: 0.58, minOdds: 1.1, maxOdds: 2.4, live: false },
    allowSameMatch: false, requireAllSports: false, tickets: 4,
    buckets: [
      { label: 'Biztonsági', lo: 1.3, hi: 2.6 },
      { label: 'Kiegyensúlyozott', lo: 2.6, hi: 4.5 },
      { label: 'Merészebb', lo: 4.5, hi: 7 },
      { label: 'Plafon közelében', lo: 7, hi: 10 },
    ],
  },
  brutal: {
    id: 'brutal', label: 'Brutális mix', minOdds: 70, maxOdds: 2500, minLegs: 4, maxLegs: 12,
    leg: { minP: 0.16, minOdds: 1.3, maxOdds: 7.5, live: true },
    allowSameMatch: true, requireAllSports: true, tickets: 3,
    buckets: [
      { label: 'Brutális', lo: 70, hi: 160 },
      { label: 'Még brutálisabb', lo: 160, hi: 450 },
      { label: 'Holdra lövés', lo: 450, hi: 2500 },
    ],
  },
};

// Market families. Same match + same family = conflict.
// result/spread/sets all describe who wins, so they conflict with each other.
const FAMILY_GROUP = { result: 'winner', spread: 'winner', sets: 'winner', totals: 'totals', teamtotals: 'totals', btts: 'btts', scorer: 'scorer', player: 'player', playerdd: 'player', cards: 'cards' };
// Correlation magnitude for allowed same-match pairs (symmetric).
const RHO = { 'winner|totals': 0.15, 'winner|btts': 0.12, 'totals|btts': 0.45, 'winner|scorer': 0.2, 'totals|scorer': 0.3, 'btts|scorer': 0.25,
  'winner|player': 0.15, 'totals|player': 0.3, 'winner|cards': 0.05, 'totals|cards': 0.05, 'btts|cards': 0.05, 'scorer|cards': 0.03, 'player|cards': 0.03, 'scorer|player': 0.2 };
const SAME_MATCH_RHO = Object.fromEntries(Object.entries(RHO).flatMap(([k, v]) => { const [a, b] = k.split('|'); return [[`${a}|${b}`, v], [`${b}|${a}`, v]]; }));

/** Market filter groups offered in the UI ("which kinds of legs may the ticket use"). */
export const MARKET_GROUPS = {
  result: { label: 'Győztes / 1X2', families: ['result', 'sets'] },
  spread: { label: 'Hendikep', families: ['spread'] },
  totals: { label: 'Gól/pont over-under', families: ['totals', 'teamtotals'] },
  btts: { label: 'Mindkét csapat gól', families: ['btts'] },
  scorer: { label: 'Gólszerző', families: ['scorer'] },
  player: { label: 'Játékos-statok (PRA, DD…)', families: ['player', 'playerdd'] },
  cards: { label: 'Sárga lapok', families: ['cards'] },
};
export function filterByGroups(legs, groups) {
  if (!groups?.length) return legs;
  const fams = new Set(groups.flatMap((g) => MARKET_GROUPS[g]?.families || []));
  return legs.filter((l) => fams.has(l.family));
}

export function conflicts(a, b, allowSameMatch) {
  if (a.id === b.id) return true;
  if (a.matchId !== b.matchId) return false;
  if (!allowSameMatch) return true;
  return FAMILY_GROUP[a.family] === FAMILY_GROUP[b.family];
}

export function pairRho(a, b) {
  if (a.matchId === b.matchId) return SAME_MATCH_RHO[`${FAMILY_GROUP[a.family]}|${FAMILY_GROUP[b.family]}`] ?? 0.5;
  // Same league and same kick-off window: mild shared-condition correlation.
  if (a.league === b.league && Math.abs(new Date(a.startTime) - new Date(b.startTime)) < 3 * 3600e3) return 0.02;
  return 0;
}

/** Ticket statistics. Probability assumes independence; correlation is penalised separately. */
export function evaluateTicket(legs, sportsAvailable = []) {
  const odds = combineOdds(legs.map((l) => l.odds));
  const p = legs.reduce((s, l) => s * l.p, 1);
  const ev = p * odds - 1;
  let rhoSum = 0; let sameMatchPairs = 0;
  for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
    const r = pairRho(legs[i], legs[j]); rhoSum += r; if (legs[i].matchId === legs[j].matchId) sameMatchPairs++;
  }
  const n = legs.length;
  const sports = new Set(legs.map((l) => l.sport));
  const leagues = new Set(legs.map((l) => l.league));
  const matches = new Set(legs.map((l) => l.matchId));
  const families = new Set(legs.map((l) => FAMILY_GROUP[l.family]));
  const avail = Math.max(1, sportsAvailable.length || sports.size);
  // Diversification 0–100 (documented on the methodology page).
  const div = 100 * (0.35 * (sports.size / avail) + 0.2 * (leagues.size / n) + 0.25 * (matches.size / n) + 0.2 * Math.min(1, families.size / Math.min(n, 3))) - 15 * rhoSum;
  const risk = p >= 0.35 ? 'alacsony' : p >= 0.15 ? 'közepes' : 'magas';
  return {
    odds: round(odds, 2), p, ev: round(ev, 4), risk,
    diversification: Math.round(Math.max(0, Math.min(100, div))),
    correlationPenalty: round(rhoSum, 3), sameMatchPairs,
    sports: [...sports], avgConfidence: Math.round(legs.reduce((s, l) => s + (l.confidence || 50), 0) / n),
  };
}

function objective(mode, ev) {
  if (mode.id === 'easy') return ev.ev + 0.8 * ev.p + 0.002 * ev.avgConfidence - 0.6 * ev.correlationPenalty;
  // Brutális: value first, but reward diversification and punish correlation hard.
  return ev.ev + 0.006 * ev.diversification - 1.2 * ev.correlationPenalty - 0.25 * ev.sameMatchPairs;
}

export function filterCandidates(mode, legs) {
  const L = mode.leg;
  return legs.filter((l) => l.p >= L.minP && l.odds >= L.minOdds && l.odds <= L.maxOdds && (L.live || l.status !== 'live') && l.status !== 'post');
}

/**
 * Build tickets.
 * @param {'easy'|'brutal'} modeId
 * @param {Array} legs candidate legs (see buildLegCandidates in services)
 * @param {{seed?:number, locked?:string[], attempts?:number}} opts
 */
/**
 * Candidate counts per calendar day (legs carry a precomputed local `day`).
 * Every ticket is built from ONE day, so all its matches are played on the same date.
 */
export function dayOptions(modeId, legs) {
  const mode = MODES[modeId]; const by = new Map();
  for (const l of filterCandidates(mode, legs)) {
    if (!by.has(l.day)) by.set(l.day, { day: l.day, candidates: 0, sports: new Set(), matches: new Set() });
    const d = by.get(l.day); d.candidates++; d.sports.add(l.sport); d.matches.add(l.matchId);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ day: d.day, candidates: d.candidates, matches: d.matches.size, sports: [...d.sports] }));
}

/** Default day: the earliest day with a healthy offer, otherwise the day with the most matches. */
export function pickDay(modeId, legs) {
  const opts = dayOptions(modeId, legs);
  if (!opts.length) return null;
  const minMatches = modeId === 'brutal' ? 8 : 4;
  return (opts.find((d) => d.matches >= minMatches && (modeId !== 'brutal' || d.sports.length >= 3)) || [...opts].sort((a, b) => b.matches - a.matches)[0]).day;
}

export function buildTickets(modeId, legs, { seed = 1, locked = [], attempts = 600, day = null } = {}) {
  const mode = MODES[modeId];
  if (!mode) throw new Error('unknown mode');
  const warnings = [];
  const otherDay = day ? locked.filter((id) => legs.some((l) => l.id === id && l.day !== day)) : [];
  if (otherDay.length) warnings.push('Egy rögzített tétel másik napon játszott meccsről van, ezért ezen a napon kimaradt (egy szelvény csak egy nap meccseiből áll).');
  if (day) legs = legs.filter((l) => l.day === day);
  const byId = new Map(legs.map((l) => [l.id, l]));
  const lockedLegs = locked.map((id) => byId.get(id)).filter(Boolean);
  if (lockedLegs.length + otherDay.length < locked.length) warnings.push('Egy vagy több rögzített tétel már nem elérhető (pl. elkezdődött vagy véget ért a meccs), ezért kimaradt.');
  for (let i = 0; i < lockedLegs.length; i++) for (let j = i + 1; j < lockedLegs.length; j++) {
    if (conflicts(lockedLegs[i], lockedLegs[j], mode.allowSameMatch)) return { tickets: [], warnings: [...warnings, 'A rögzített tételek ütköznek egymással (ugyanaz a meccs és piac).'], mode: publicMode(mode), candidates: 0 };
  }
  const lockedOdds = combineOdds(lockedLegs.map((l) => l.odds));
  if (lockedOdds > mode.maxOdds) return { tickets: [], warnings: [...warnings, `A rögzített tételek eredő szorzója (${lockedOdds.toFixed(2)}) már meghaladja a ${mode.maxOdds}-es határt.`], mode: publicMode(mode), candidates: 0 };

  const pool = filterCandidates(mode, legs).filter((l) => !locked.includes(l.id));
  const sportsAvailable = [...new Set([...pool, ...lockedLegs].map((l) => l.sport))];
  const rand = rng(seed * 7919 + (modeId === 'easy' ? 1 : 2));

  // Leg attractiveness used for weighted sampling.
  const legScore = (l) => (mode.id === 'easy' ? 4 * l.p + 2 * Math.max(-0.05, l.ev) : 1.5 * l.ev + 0.6 * l.p + (l.status === 'live' ? 0.15 : 0));
  const weights = pool.map((l) => Math.exp(2.5 * legScore(l)));

  const results = [];
  for (const bucket of mode.buckets) {
    let best = null;
    for (let a = 0; a < attempts; a++) {
      const chosen = [...lockedLegs];
      let odds = lockedOdds;
      const target = Math.max(mode.minLegs, chosen.length) + Math.floor(rand() * (mode.maxLegs - Math.max(mode.minLegs, chosen.length) + 1));
      // In Brutális, seed one leg per sport first so every sport is represented.
      const order = [];
      if (mode.requireAllSports) {
        for (const sp of sportsAvailable) {
          if (chosen.some((c) => c.sport === sp)) continue;
          const idx = pickWeighted(pool, weights, rand, (l) => l.sport === sp);
          if (idx >= 0) order.push(idx);
        }
      }
      let guard = 0;
      while (chosen.length < target && guard++ < 60) {
        const idx = order.length ? order.shift() : pickWeighted(pool, weights, rand, () => true);
        if (idx < 0) break;
        const leg = pool[idx];
        if (chosen.some((c) => conflicts(c, leg, mode.allowSameMatch))) continue;
        if (odds * leg.odds > bucket.hi) continue;
        chosen.push(leg); odds *= leg.odds;
        if (odds >= bucket.lo && chosen.length >= mode.minLegs && rand() < 0.35) break;
      }
      if (chosen.length < mode.minLegs || odds < bucket.lo || odds > bucket.hi) continue;
      if (mode.requireAllSports && sportsAvailable.some((sp) => !chosen.some((c) => c.sport === sp))) continue;
      const ev = evaluateTicket(chosen, sportsAvailable);
      const score = objective(mode, ev);
      const key = chosen.map((c) => c.id).sort().join(',');
      if (results.some((r) => jaccard(r.key, key) > 0.6)) continue; // keep tickets distinct
      if (!best || score > best.score) best = { legs: chosen, ev, score, key };
    }
    if (best) {
      results.push({ ...best, bucket: bucket.label });
    }
  }
  if (!results.length) warnings.push(pool.length ? 'A feltételeknek megfelelő kombináció nem található. Próbáld újragenerálni vagy oldj fel rögzített tételeket.' : 'Nincs elég megfelelő tétel (közelgő vagy élő meccs szorzóval).');
  if (mode.requireAllSports && sportsAvailable.length < TOTAL_SPORTS) warnings.push(`Ezen a napon ${sportsAvailable.length} sportágból van megfelelő tétel (az ${TOTAL_SPORTS} közül), a szelvények ezeket keverik.`);

  return {
    mode: publicMode(mode),
    day,
    candidates: pool.length + lockedLegs.length,
    sportsAvailable,
    warnings,
    tickets: results.map((r, i) => ({
      id: `${modeId}-${seed}-${i}`, bucket: r.bucket,
      legs: r.legs.map((l) => ({ ...l, locked: locked.includes(l.id) })),
      ...r.ev, p: round(r.ev.p, 5),
    })),
  };
}

function pickWeighted(pool, weights, rand, pred) {
  let tot = 0;
  for (let i = 0; i < pool.length; i++) if (pred(pool[i])) tot += weights[i];
  if (tot <= 0) return -1;
  let u = rand() * tot;
  for (let i = 0; i < pool.length; i++) {
    if (!pred(pool[i])) continue;
    u -= weights[i];
    if (u <= 0) return i;
  }
  return -1;
}

function jaccard(a, b) {
  const A = new Set(a.split(',')); const B = new Set(b.split(','));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter);
}

const publicMode = (m) => ({ id: m.id, label: m.label, minOdds: m.minOdds, maxOdds: m.maxOdds, minLegs: m.minLegs, maxLegs: m.maxLegs });
