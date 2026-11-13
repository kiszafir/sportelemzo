// Player props for NBA and NHL.
//
// Input (per side): match.stats[side].roster — player profiles built from recent
// box scores (live data) or the simulation (mock): per-game averages, minutes,
// double-/triple-double rates and "fresh" = the share of the team's recent
// (recency-weighted) games the player actually played.
// match.stats[side].injuries — fresh injury report entries (status, playProb).
//
// Model, per team:
//   1. Players listed as out are removed. Their recent production (× freshness,
//      so a long-term absence that is already in the averages is not counted
//      twice) is redistributed: minutes to the remaining rotation, points /
//      rebounds / assists by scaling the active players towards the team target.
//   2. Game environment: team points (NBA) / goals (NHL) expected by the match
//      model vs. the team's recent average scale the scoring stats.
//   3. Each stat ~ Negative binomial mixed over a shared minutes factor
//      F ~ LogNormal (7-point Gauss–Hermite), so points, rebounds and assists
//      of one player are correlated through playing time (blowouts, foul
//      trouble). Combos (PR, PRA, RA) are exact convolutions per node;
//      double-/triple-doubles come from a per-node Bernoulli DP over
//      pts/reb/ast/stl/blk ≥ 10, blended with the player's observed rate.
// Pre-match only. Market key: pp:<side>:<player-slug>:<stat>.
import { clamp } from './mathutil.js';

const fmt = (x) => String(x).replace('.', ',');
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const STAT_HU = {
  pts: { label: 'pontok', unit: 'pont', short: 'Pont' },
  reb: { label: 'lepattanók', unit: 'lepattanó', short: 'Lepattanó' },
  ast: { label: 'gólpasszok', unit: 'gólpassz', short: 'Gólpassz' },
  '3pm': { label: 'dobott hárompontosok', unit: 'hárompontos', short: 'Hárompontos' },
  pr: { label: 'pont + lepattanó (PR)', unit: 'P+R', short: 'PR' },
  pra: { label: 'pont + lepattanó + gólpassz (PRA)', unit: 'P+R+A', short: 'PRA' },
  ra: { label: 'lepattanó + gólpassz (RA)', unit: 'R+A', short: 'RA' },
  pa: { label: 'pont + gólpassz (PA)', unit: 'P+A', short: 'PA' },
  dd: { label: 'dupla-dupla', short: 'Dupla-dupla' },
  td: { label: 'tripla-dupla', short: 'Tripla-dupla' },
  g: { label: 'gólok', unit: 'gól', short: 'Gól' },
  a: { label: 'gólpasszok', unit: 'gólpassz', short: 'Gólpassz' },
  p: { label: 'pontok (gól + gólpassz)', unit: 'pont', short: 'Pont (G+A)' },
  sog: { label: 'kapura lövések', unit: 'lövés', short: 'Kapura lövés' },
};

/** Value of a stat in a box-score line (settlement); null if not available. */
export function statValue(line, stat) {
  if (!line) return null;
  const n = (k) => (Number.isFinite(Number(line[k])) ? Number(line[k]) : null);
  const sum = (...ks) => { const v = ks.map(n); return v.some((x) => x == null) ? null : v.reduce((a, b) => a + b, 0); };
  switch (stat) {
    case 'pts': return n('pts');
    case 'reb': return n('reb');
    case 'ast': return n('ast');
    case '3pm': return n('tpm');
    case 'pr': return sum('pts', 'reb');
    case 'pra': return sum('pts', 'reb', 'ast');
    case 'ra': return sum('reb', 'ast');
    case 'pa': return sum('pts', 'ast');
    case 'dd': case 'td': {
      const v = ['pts', 'reb', 'ast', 'stl', 'blk'].map(n);
      if (v.slice(0, 3).some((x) => x == null)) return null;
      return v.filter((x) => x != null && x >= 10).length;
    }
    case 'g': return n('g');
    case 'a': return n('a');
    case 'p': return sum('g', 'a');
    case 'sog': return n('sog');
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Distribution helpers
// ---------------------------------------------------------------------------
const GH = [[-2.651961356835233, 0.0005482688559722], [-1.673551628767471, 0.0307571239675865], [-0.816287882858965, 0.2401231786050126],
  [0, 0.4571428571428571], [0.816287882858965, 0.2401231786050126], [1.673551628767471, 0.0307571239675865], [2.651961356835233, 0.0005482688559722]];

/** Minutes-factor nodes [F, weight] for F ~ LogNormal(mean 1, sd ≈ sigma). */
export function factorNodes(sigma) {
  return GH.map(([z, w]) => [Math.min(1.7, Math.exp(sigma * z - sigma * sigma / 2)), w]);
}

/** NegBin(mean, r) pmf (Poisson for r = Infinity), truncated where the tail is negligible. */
export function nbPmf(mean, r = Infinity) {
  mean = Math.max(1e-6, mean);
  const sd = Math.sqrt(mean + (Number.isFinite(r) ? mean * mean / r : 0));
  const kmax = Math.min(140, Math.ceil(mean + 9 * sd + 4));
  const out = new Array(kmax + 1);
  if (!Number.isFinite(r)) {
    out[0] = Math.exp(-mean);
    for (let k = 1; k <= kmax; k++) out[k] = out[k - 1] * mean / k;
  } else {
    const p = r / (r + mean);
    out[0] = Math.exp(r * Math.log(p));
    for (let k = 1; k <= kmax; k++) out[k] = out[k - 1] * ((k - 1 + r) / k) * (1 - p);
  }
  return out;
}

export function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) { const ai = a[i]; if (ai < 1e-13) continue; for (let j = 0; j < b.length; j++) out[i + j] += ai * b[j]; }
  return out;
}
const over = (pmf, line) => { let s = 0; for (let k = Math.floor(line) + 1; k < pmf.length; k++) s += pmf[k]; return s; };
const atLeast = (pmf, k) => over(pmf, k - 0.5);

/** P(at least `need` of independent events with probabilities ps). */
function atLeastOf(ps, need) {
  let dp = [1];
  for (const p of ps) { const nx = new Array(dp.length + 1).fill(0); dp.forEach((v, i) => { nx[i] += v * (1 - p); nx[i + 1] += v * p; }); dp = nx; }
  return dp.slice(need).reduce((a, b) => a + b, 0);
}

/** Mixture over minutes nodes: returns { over(line), median, mean } for a pmf builder. */
function mixture(nodes, build) {
  const pm = nodes.map(([F, w]) => [build(F), w]);
  const len = Math.max(...pm.map(([p]) => p.length));
  const mix = new Array(len).fill(0);
  for (const [p, w] of pm) for (let k = 0; k < p.length; k++) mix[k] += w * p[k];
  return mix;
}

/** The half line whose over-probability is closest to 50 % (bookmaker-style main line). */
function mainLine(pmf, minLine = 0.5) {
  let best = null;
  for (let k = Math.floor(minLine); k < pmf.length - 1; k++) {
    const line = k + 0.5; const p = over(pmf, line);
    if (!best || Math.abs(p - 0.5) < Math.abs(best.p - 0.5)) best = { line, p };
    if (p < 0.3) break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Availability and projection
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
function sameName(a, b) {
  const x = norm(a).split(' ').filter(Boolean); const y = norm(b).split(' ').filter(Boolean);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}
export function injuryOf(name, injuries) {
  return (injuries || []).find((i) => sameName(i.name, name)) || null;
}
const playProbOf = (inj) => (inj ? (Number.isFinite(inj.playProb) ? inj.playProb : inj.status === 'kiesik' || inj.status === 'eltiltva' ? 0 : inj.status === 'kétséges' ? 0.5 : 0.85) : 1);

/**
 * Projected per-game means for the active players of one team.
 * @returns {{ active: object[], out: object[], doubtful: object[], missingShare: number, envRatio: number }}
 */
export function projectTeam(sport, st, { teamMu, margin = 0 } = {}) {
  const roster = (st?.roster || []).filter((p) => p && p.name && p.gp > 0);
  const inj = st?.injuries || [];
  const isNba = sport === 'nba';
  const P = isNba ? ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk'] : ['g', 'a', 'sog'];
  const timeKey = isNba ? 'min' : 'toi';
  const team = {}; for (const k of [...P, timeKey]) team[k] = 0;
  for (const p of roster) for (const k of [...P, timeKey]) team[k] += (p[k] || 0) * (p.fresh ?? 1);
  const active = []; const out = []; const doubtful = [];
  const missing = {}; for (const k of [...P, timeKey]) missing[k] = 0;
  for (const p of roster) {
    const i = injuryOf(p.name, inj); const pp = playProbOf(i);
    if (pp < 1) for (const k of [...P, timeKey]) missing[k] += (1 - pp) * (p[k] || 0) * (p.fresh ?? 1);
    if (pp <= 0.05) { out.push({ name: p.name, status: i?.status || 'kiesik', type: i?.type || null, fresh: p.fresh ?? 1, pts: p.pts, g: p.g, a: p.a }); continue; }
    const row = { ...p, playProb: pp, injury: i || null };
    if (pp < 1) doubtful.push({ name: p.name, status: i?.status, type: i?.type || null, playProb: pp });
    active.push(row);
  }
  // Environment: model's expected team score vs the team's recent scoring.
  const recent = isNba ? team.pts : team.g;
  const envRatio = Number.isFinite(teamMu) && recent > 0 ? clamp(teamMu / recent, isNba ? 0.88 : 0.8, isNba ? 1.12 : 1.25) : 1;
  const missingShare = recent > 0 ? clamp((isNba ? missing.pts : missing.g + 0.5 * missing.a) / Math.max(1e-6, isNba ? team.pts : team.g + 0.5 * team.a), 0, 0.6) : 0;
  // 1) time: 85 % of the missing minutes / ice time to the rotation, by current share.
  const rot = active.filter((p) => (p[timeKey] || 0) >= (isNba ? 10 : 8));
  const rotTime = rot.reduce((s, p) => s + p[timeKey], 0) || 1;
  const cap = isNba ? 40 : 24;
  // Blowout risk: big expected margins trim starters' minutes a little.
  const blow = isNba ? 1 - 0.004 * Math.max(0, Math.abs(margin) - 6) : 1;
  for (const p of active) {
    const base = p[timeKey] || 0;
    const add = rot.includes(p) ? 0.85 * missing[timeKey] * (base / rotTime) : 0;
    let t = Math.min(Math.max(base, cap), base + add);
    if (isNba && base >= 28) t *= blow;
    p.proj = { [timeKey]: t, timeRatio: base > 0 ? t / base : 1 };
  }
  // 2) production: scale towards the team target (recent total × environment, minus a
  //    small penalty for losing talent), each player capped at +30 %.
  for (const k of P) {
    // expected production of the active group: avg × time ratio × P(plays) (players who
    // have hardly featured recently — fresh < 0.5 without an injury entry — count partially)
    const totalActive = active.reduce((s, p) => s + (p[k] || 0) * p.proj.timeRatio * p.playProb * Math.min(1, (p.fresh ?? 1) / 0.5), 0);
    const target = (team[k] || 0) * (k === 'reb' || k === 'sog' ? Math.sqrt(envRatio) : envRatio) * (1 - 0.12 * missingShare);
    const f = totalActive > 0 ? clamp(target / totalActive, 0.8, 1.3) : 1;
    for (const p of active) p.proj[k] = (p[k] || 0) * clamp(p.proj.timeRatio * f, 0.6, 1.3);
  }
  return { active, out, doubtful, missingShare, envRatio };
}

// ---------------------------------------------------------------------------
// Market builders
// ---------------------------------------------------------------------------
function ouMarket(match, side, pl, stat, pmf, extra = {}) {
  const ml = mainLine(pmf, extra.minLine ?? 0.5);
  if (!ml || ml.p < 0.04 || ml.p > 0.96) return null;
  const S = STAT_HU[stat]; const team = match[side];
  return {
    key: `pp:${side}:${slug(pl.name)}:${stat}`, label: `${pl.name} – ${S.label} (${fmt(ml.line)})`, family: 'player', line: ml.line, exhaustive: true, alt: true,
    player: pl.name, playerSide: side, stat, projection: extra.mean != null ? Math.round(extra.mean * 10) / 10 : undefined,
    selections: [
      { key: 'over', label: `Több mint ${fmt(ml.line)}`, name: `${pl.name}: több mint ${fmt(ml.line)} ${S.unit} (${team.name})`, p: ml.p, side: 'over', player: pl.name },
      { key: 'under', label: `Kevesebb mint ${fmt(ml.line)}`, name: `${pl.name}: kevesebb mint ${fmt(ml.line)} ${S.unit} (${team.name})`, p: 1 - ml.p, side: 'under', player: pl.name }],
  };
}
function fixedOu(match, side, pl, stat, pmf, line, mean) {
  const p = over(pmf, line); if (p < 0.04 || p > 0.97) return null;
  const S = STAT_HU[stat]; const team = match[side];
  return {
    key: `pp:${side}:${slug(pl.name)}:${stat}${line > 0.5 ? String(line).replace('.', '') : ''}`, label: `${pl.name} – ${S.label} (${fmt(line)})`, family: 'player', line, exhaustive: true, alt: true,
    player: pl.name, playerSide: side, stat, projection: Math.round(mean * 100) / 100,
    selections: [
      { key: 'over', label: line === 0.5 ? 'Igen (1+)' : `Több mint ${fmt(line)}`, name: line === 0.5 ? `${pl.name}: legalább 1 ${S.unit} (${team.name})` : `${pl.name}: több mint ${fmt(line)} ${S.unit} (${team.name})`, p, side: 'over', player: pl.name },
      { key: 'under', label: line === 0.5 ? 'Nem (0)' : `Kevesebb mint ${fmt(line)}`, name: line === 0.5 ? `${pl.name}: 0 ${S.unit} (${team.name})` : `${pl.name}: kevesebb mint ${fmt(line)} ${S.unit} (${team.name})`, p: 1 - p, side: 'under', player: pl.name }],
  };
}
function yesNo(match, side, pl, stat, p) {
  if (!(p >= 0.03 && p <= 0.97)) return null;
  const S = STAT_HU[stat]; const team = match[side];
  return {
    key: `pp:${side}:${slug(pl.name)}:${stat}`, label: `${pl.name} – ${S.label}`, family: 'playerdd', line: null, exhaustive: true, alt: true,
    player: pl.name, playerSide: side, stat,
    selections: [
      { key: 'yes', label: 'Igen', name: `${pl.name}: ${S.label} – igen (${team.name})`, p, side: 'over', player: pl.name },
      { key: 'no', label: 'Nem', name: `${pl.name}: ${S.label} – nem (${team.name})`, p: 1 - p, side: 'under', player: pl.name }],
  };
}

// NegBin dispersions (calibrated so a 25-point scorer has sd ≈ 7–8 incl. the minutes factor).
const R = { pts: 30, reb: 14, ast: 10, tpm: 9, stl: 40, blk: 18 };

function nbaPlayerMarkets(match, side, pl, sigma) {
  const pr = pl.proj; const nodes = factorNodes(sigma);
  const pmf = (k, F) => nbPmf(pr[k] * F, R[k]);
  const ptsM = mixture(nodes, (F) => pmf('pts', F));
  const rebM = mixture(nodes, (F) => pmf('reb', F));
  const astM = mixture(nodes, (F) => pmf('ast', F));
  const out = [];
  out.push(ouMarket(match, side, pl, 'pts', ptsM, { mean: pr.pts, minLine: 2.5 }));
  if (pr.reb >= 2) out.push(ouMarket(match, side, pl, 'reb', rebM, { mean: pr.reb, minLine: 1.5 }));
  if (pr.ast >= 1.5) out.push(ouMarket(match, side, pl, 'ast', astM, { mean: pr.ast, minLine: 0.5 }));
  if (pr.tpm >= 0.6) out.push(ouMarket(match, side, pl, '3pm', mixture(nodes, (F) => pmf('tpm', F)), { mean: pr.tpm, minLine: 0.5 }));
  out.push(ouMarket(match, side, pl, 'pr', mixture(nodes, (F) => convolve(pmf('pts', F), pmf('reb', F))), { mean: pr.pts + pr.reb, minLine: 4.5 }));
  out.push(ouMarket(match, side, pl, 'pra', mixture(nodes, (F) => convolve(convolve(pmf('pts', F), pmf('reb', F)), pmf('ast', F))), { mean: pr.pts + pr.reb + pr.ast, minLine: 5.5 }));
  out.push(ouMarket(match, side, pl, 'ra', mixture(nodes, (F) => convolve(pmf('reb', F), pmf('ast', F))), { mean: pr.reb + pr.ast, minLine: 2.5 }));
  // Double-double / triple-double: per node P(stat ≥ 10) for the five categories.
  let dd = 0; let td = 0;
  for (const [F, w] of nodes) {
    const ps = ['pts', 'reb', 'ast', 'stl', 'blk'].map((k) => atLeast(pmf(k, F), 10));
    dd += w * atLeastOf(ps, 2); td += w * atLeastOf(ps, 3);
  }
  const gp = pl.gp || 0; const wEmp = gp / (gp + 12);
  if (Number.isFinite(pl.ddRate)) dd = wEmp * pl.ddRate + (1 - wEmp) * dd;
  if (Number.isFinite(pl.tdRate)) td = wEmp * pl.tdRate + (1 - wEmp) * td;
  out.push(yesNo(match, side, pl, 'dd', clamp(dd, 0.005, 0.99)));
  if (td >= 0.02) out.push(yesNo(match, side, pl, 'td', clamp(td, 0.005, 0.95)));
  return out.filter(Boolean);
}

function nhlPlayerMarkets(match, side, pl) {
  const pr = pl.proj; const nodes = factorNodes(0.1);
  const out = [];
  const pM = mixture(nodes, (F) => nbPmf((pr.g + pr.a) * F, 25));
  out.push(fixedOu(match, side, pl, 'p', pM, 0.5, pr.g + pr.a));
  if (over(pM, 1.5) >= 0.12) out.push(fixedOu(match, side, pl, 'p', pM, 1.5, pr.g + pr.a));
  out.push(fixedOu(match, side, pl, 'a', mixture(nodes, (F) => nbPmf(pr.a * F)), 0.5, pr.a));
  if (pr.sog >= 1) out.push(ouMarket(match, side, pl, 'sog', mixture(nodes, (F) => nbPmf(pr.sog * F, 12)), { mean: pr.sog, minLine: 0.5 }));
  return out.filter(Boolean);
}

/**
 * Player-prop markets for one match (pre-match only).
 * @param ctx analysis context: ctx.dist (NBA), ctx.expected.lh/la (NHL); ctx.players receives the projections.
 */
export function playerProps(match, ctx) {
  if (match.status !== 'pre' || !['nba', 'nhl'].includes(match.sport)) return [];
  const isNba = match.sport === 'nba';
  const out = []; const info = {};
  for (const side of ['home', 'away']) {
    const st = match.stats?.[side];
    if (!st?.roster?.length) continue;
    let teamMu = null; let margin = 0;
    if (isNba && ctx.dist) { teamMu = side === 'home' ? (ctx.dist.T + ctx.dist.M) / 2 : (ctx.dist.T - ctx.dist.M) / 2; margin = ctx.dist.M; }
    if (!isNba && ctx.expected) teamMu = side === 'home' ? ctx.expected.lh : ctx.expected.la;
    const proj = projectTeam(match.sport, st, { teamMu, margin });
    const sigma = 0.15 + 0.004 * Math.min(15, Math.abs(margin));
    const minGp = Math.min(3, Math.max(1, Math.max(...st.roster.map((p) => p.gp || 0)) - 1));
    const players = proj.active
      .filter((p) => (p.gp || 0) >= minGp && (p.fresh ?? 1) >= 0.25)
      .filter((p) => (isNba ? p.proj.min >= 20 && p.proj.pts >= 7 : p.proj.g + p.proj.a >= 0.3 || p.proj.sog >= 2))
      .sort((a, b) => (isNba ? b.proj.pts + b.proj.reb + b.proj.ast - (a.proj.pts + a.proj.reb + a.proj.ast) : b.proj.g + b.proj.a - (a.proj.g + a.proj.a)))
      .slice(0, 6);
    for (const pl of players) out.push(...(isNba ? nbaPlayerMarkets(match, side, pl, sigma) : nhlPlayerMarkets(match, side, pl)));
    info[side] = {
      players: players.map((p) => ({ name: p.name, gp: p.gp, playProb: p.playProb, injury: p.injury ? { status: p.injury.status, type: p.injury.type } : null,
        recent: p.recent || null,
        proj: Object.fromEntries(Object.entries(p.proj).filter(([k]) => k !== 'timeRatio').map(([k, v]) => [k, Math.round(v * 10) / 10])),
        avg: isNba ? { min: r1(p.min), pts: r1(p.pts), reb: r1(p.reb), ast: r1(p.ast), tpm: r1(p.tpm) } : { toi: r1(p.toi), g: r2(p.g), a: r2(p.a), sog: r1(p.sog) } })),
      out: proj.out, doubtful: proj.doubtful, missingShare: Math.round(proj.missingShare * 1000) / 1000, envRatio: Math.round(proj.envRatio * 1000) / 1000,
      src: st.rosterSrc || null,
    };
    if (proj.out.length) {
      const fresh = proj.out.filter((o) => o.fresh >= 0.35);
      if (fresh.length) ctx.notes.push(`${match[side].name}: friss hiányzó(k) – ${fresh.map((o) => o.name).join(', ')}; a kiesett szerepet a modell a többi játékos között osztja szét.`);
    }
  }
  if (Object.keys(info).length) {
    ctx.players = info;
    ctx.notes.push('Játékospiacok: ha a játékos nem lép pályára, a fogadás érvénytelen (void). Szorzójuk általában becsült.');
  }
  return out;
}

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
