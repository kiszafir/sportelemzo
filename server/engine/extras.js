// Additional markets for every sport: goalscorer / player props, handicaps,
// alternative and team totals, both-teams-to-score and yellow cards.
// Builders read the distributions the main models left in `ctx`.
import { normCdf, clamp } from './mathutil.js';
import { playerProps } from './props.js';

export const YELLOW_BASE = { epl: 1.9, laliga: 2.5, seriea: 2.3, bundesliga: 2.0, ligue1: 1.9, ucl: 1.8, uel: 1.9, uecl: 2.0, eredivisie: 1.7, primeira: 2.4, championship: 2.0, superlig: 2.4, belgium: 2.0, scotland: 1.8, mls: 2.0, nbi: 2.3, unl: 1.9, facup: 1.8, eflcup: 1.8, copadelrey: 2.4, coppaitalia: 2.2, dfbpokal: 2.0, cdf: 1.9, libertadores: 2.6, mkupa: 2.2 };

const fmt = (x) => String(x).replace('.', ',');
const half = (x) => Math.floor(x) + 0.5;
const keyOf = (prefix, line) => `${prefix}${String(line).replace('.', '').replace('-', 'm')}`;
export const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Two-way over/under market. */
function ou({ key, label, line, pOver, unit, who = '', family = 'totals', alt = true }) {
  const nm = (word) => (who ? `${who}: ${word.toLowerCase()}` : word) + ` ${fmt(line)} ${unit}`;
  return { key, label: `${label} (${fmt(line)})`, family, line, exhaustive: true, alt, selections: [
    { key: 'over', label: `Több mint ${fmt(line)}`, name: nm('Több mint'), p: pOver, side: 'over' },
    { key: 'under', label: `Kevesebb mint ${fmt(line)}`, name: nm('Kevesebb mint'), p: 1 - pOver, side: 'under' }] };
}

/** Two-way handicap market; line = handicap of the home side (player 1). */
function hcp({ key, label, line, pHome, home, away, unit = '', family = 'spread' }) {
  const sg = (x) => `${x > 0 ? '+' : ''}${fmt(x)}${unit}`;
  return { key, label: `${label} (${sg(line)})`, family, line, exhaustive: true, alt: true, selections: [
    { key: 'home', label: `1 (${sg(line)})`, name: `${home} ${sg(line)}`, p: pHome, side: 'home' },
    { key: 'away', label: `2 (${sg(-line)})`, name: `${away} ${sg(-line)}`, p: 1 - pHome, side: 'away' }] };
}

// ---------------------------------------------------------------------------
// Score-matrix helpers (football, NHL)
// ---------------------------------------------------------------------------
function joint({ M, offsetH = 0, offsetA = 0 }, ot = null) {
  // Returns [{h, a, p}] of FINAL scores. NHL: a regulation draw goes to OT
  // (+1 goal to the OT winner, home with probability ot).
  const out = [];
  for (let i = 0; i < M.length; i++) for (let j = 0; j < M.length; j++) {
    const p = M[i][j]; if (p < 1e-12) continue;
    const h = i + offsetH; const a = j + offsetA;
    if (ot != null && h === a) { out.push({ h: h + 1, a, p: p * ot }); out.push({ h, a: a + 1, p: p * (1 - ot) }); }
    else out.push({ h, a, p });
  }
  return out;
}
const prob = (J, f) => J.reduce((s, x) => s + (f(x) ? x.p : 0), 0);
/** NHL: P(final total > line) including the overtime goal. */
export const overWithOT = (mat, ot, line) => prob(joint(mat, ot), (x) => x.h + x.a > line);

/** P(N > line) for N ~ NegBin(mean, dispersion r) (Poisson when r = ∞). */
function negBinOver(mean, line, r = 10) {
  if (mean <= 0) return line < 0 ? 1 : 0;
  const pr = r / (r + mean); let pk = pr ** r; let cdf = 0;
  for (let k = 0; k <= Math.floor(line); k++) { cdf += pk; pk *= ((k + r) / (k + 1)) * (1 - pr); }
  return clamp(1 - cdf, 0, 1);
}

/** Anytime goalscorer market (football, NHL). */
function scorerMarket(match, lamH, lamA, notes) {
  const sels = [];
  const scored = match.live?.scorers || {};
  for (const [side, lam] of [['home', lamH], ['away', lamA]]) {
    const team = match[side];
    const players = (match.stats?.[side]?.players || []).filter((p) => p.share >= 0.06).sort((a, b) => b.share - a.share).slice(0, 3);
    for (const pl of players) {
      const already = (scored[side] || []).includes(pl.name);
      const p = already ? 0.999 : 1 - Math.exp(-lam * pl.share * (pl.starter ?? 0.9));
      sels.push({ key: `${side}:${slug(pl.name)}`, label: `${pl.name} (${team.short || team.name})`, name: `${pl.name} gólt szerez (${team.name})`, p, side, player: pl.name });
    }
  }
  if (!sels.length) return [];
  if (match.stats?.home?.playersSrc === 'estimated') notes.push('Gólszerző: a játékosok gólarányai becsültek.');
  return [{ key: 'scorer', label: 'Gólszerző (bármikor)', family: 'scorer', exhaustive: false, alt: true, selections: sels }];
}

function footballExtras(match, ctx) {
  const out = []; const J = joint(ctx.mat);
  const { home, away } = match; const lh = ctx.lam.lh; const la = ctx.lam.la;
  const live = match.status === 'live' && match.live;
  const r = live ? Math.max(0.02, (93 - Math.min(95, match.live.minute ?? 0)) / 93) : 1;
  for (const line of [0.5, 4.5]) out.push(ou({ key: keyOf('ou', line), label: 'Gólszám', line, unit: 'gól', pOver: prob(J, (x) => x.h + x.a > line) }));
  for (const [side, prefix, lines] of [['home', 'tth', [0.5, 1.5, 2.5]], ['away', 'tta', [0.5, 1.5]]]) {
    for (const line of lines) {
      const pOver = prob(J, (x) => (side === 'home' ? x.h : x.a) > line);
      if (pOver > 0.03 && pOver < 0.985) out.push(ou({ key: keyOf(prefix, line), label: `${match[side].name} gólszáma`, line, unit: 'gól', who: match[side].name, family: 'teamtotals', pOver }));
    }
  }
  // Asian handicap: the half-line closest to 50 %.
  let best = null;
  for (const L of [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]) { const p = prob(J, (x) => x.h - x.a + L > 0); if (!best || Math.abs(p - 0.5) < Math.abs(best.p - 0.5)) best = { L, p }; }
  out.push(hcp({ key: 'ah', label: 'Ázsiai hendikep', line: best.L, pHome: best.p, home: home.name, away: away.name }));
  // Yellow cards: total ~ NegBin(mean = team averages, r = 10); live = cards so far + remaining share.
  const st = match.stats || {}; const prior = YELLOW_BASE[match.league] ?? 2.0;
  const yh = Number.isFinite(st.home?.yellowPg) ? st.home.yellowPg : prior; const ya = Number.isFinite(st.away?.yellowPg) ? st.away.yellowPg : prior;
  if (!Number.isFinite(st.home?.yellowPg) || !Number.isFinite(st.away?.yellowPg)) ctx.notes.push(`Sárga lapok: csapatadat hiányában bajnoki átlaggal becsülve (${fmt(prior.toFixed(1))}/csapat).`);
  const tense = (st.home?.motivation >= 0.4 && st.away?.motivation >= 0.4) ? 1.06 : 1;
  const now = live ? (match.live.cards?.home?.y ?? 0) + (match.live.cards?.away?.y ?? 0) : 0;
  const rem = (yh + ya) * tense * r;
  const mu = now + rem;
  ctx.expected.cards = mu;
  for (const line of [half(mu) - 1, half(mu), half(mu) + 1].filter((l) => l > now)) {
    out.push(ou({ key: keyOf('yc', line), label: 'Sárga lapok', line, unit: 'sárga lap', family: 'cards', pOver: negBinOver(rem, line - now) }));
  }
  out.push(...scorerMarket(match, lh * r, la * r, ctx.notes));
  return out;
}

function nhlExtras(match, ctx) {
  const out = []; const J = joint(ctx.mat, ctx.otHome);
  const { home, away } = match;
  const fav = ctx.pHome >= 0.5;
  const L = fav ? -1.5 : 1.5;
  out.push(hcp({ key: 'spread', label: 'Puck line', line: L, pHome: prob(J, (x) => x.h - x.a + L > 0), home: home.name, away: away.name }));
  const main = ctx.totalLine;
  for (const line of [main - 1, main + 1]) out.push(ou({ key: keyOf('ou', line), label: 'Gólszám', line, unit: 'gól', pOver: prob(J, (x) => x.h + x.a > line) }));
  out.push(ou({ key: 'tth25', label: `${home.name} gólszáma`, line: 2.5, unit: 'gól', who: home.name, family: 'teamtotals', pOver: prob(J, (x) => x.h > 2.5) }));
  out.push(ou({ key: 'tta25', label: `${away.name} gólszáma`, line: 2.5, unit: 'gól', who: away.name, family: 'teamtotals', pOver: prob(J, (x) => x.a > 2.5) }));
  const pB = prob(J, (x) => x.h > 0 && x.a > 0);
  out.push({ key: 'btts', label: 'Mindkét csapat szerez gólt', family: 'btts', exhaustive: true, alt: true, selections: [
    { key: 'yes', label: 'Igen', name: 'Mindkét csapat szerez gólt', p: pB, side: 'over' },
    { key: 'no', label: 'Nem', name: 'Nem szerez mindkét csapat gólt', p: 1 - pB, side: 'under' }] });
  out.push(...scorerMarket(match, ctx.lamRem.lh, ctx.lamRem.la, ctx.notes));
  return out;
}

/** NBA / handball: normal approximations of margin M and total T. */
function normalExtras(match, ctx, { unit, alt, playerKey, playerLabel }) {
  const out = []; const d = ctx.dist; const { home, away } = match;
  for (const [key, line] of [['total_lo', d.totalLine - alt], ['total_hi', d.totalLine + alt]]) {
    out.push(ou({ key, label: unit === 'pont' ? 'Összpontszám' : 'Gólszám', line, unit, pOver: 1 - normCdf((line - d.T) / d.sT) }));
  }
  const sdTeam = Math.sqrt(d.sT ** 2 + d.sM ** 2) / 2;
  const muH = (d.T + d.M) / 2; const muA = (d.T - d.M) / 2;
  for (const [side, key, mu] of [['home', 'tth', muH], ['away', 'tta', muA]]) {
    const line = half(mu - 0.5);
    out.push(ou({ key, label: `${match[side].name} ${unit === 'pont' ? 'pontjai' : 'góljai'}`, line, unit, who: match[side].name, family: 'teamtotals', pOver: 1 - normCdf((line - mu) / sdTeam) }));
  }
  if (match.status !== 'pre') return out; // player props: pre-match only
  for (const side of ['home', 'away']) {
    const st = match.stats?.[side] || {};
    if (st.roster?.length) continue; // NBA with box-score profiles: the full player-prop set (props.js) replaces this
    const teamMu = side === 'home' ? muH : muA;
    const scale = Number.isFinite(st.ppg) && unit === 'pont' ? clamp(teamMu / st.ppg, 0.85, 1.15) : Number.isFinite(st.gfPg) && unit === 'gól' ? clamp(teamMu / st.gfPg, 0.85, 1.15) : 1;
    for (const pl of (st.players || []).filter((p) => Number.isFinite(p[playerKey])).slice(0, 2)) {
      const mean = pl[playerKey] * scale; const line = half(pl[playerKey] - 0.5);
      // points: Normal(sd = 27 % of the mean); handball goals: Poisson
      const pOver = unit === 'pont' ? 1 - normCdf((line - mean) / (0.27 * mean)) : negBinOver(mean, line, 1e6);
      out.push({ key: `pl:${side}:${slug(pl.name)}`, label: `${pl.name} ${playerLabel} (${fmt(line)})`, family: 'player', line, exhaustive: true, alt: true, player: pl.name, playerSide: side, selections: [
        { key: 'over', label: `Több mint ${fmt(line)}`, name: `${pl.name}: több mint ${fmt(line)} ${unit} (${match[side].name})`, p: pOver, side: 'over' },
        { key: 'under', label: `Kevesebb mint ${fmt(line)}`, name: `${pl.name}: kevesebb mint ${fmt(line)} ${unit} (${match[side].name})`, p: 1 - pOver, side: 'under' }] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tennis: game-level model (set score distribution from hold probabilities)
// ---------------------------------------------------------------------------
/** Distribution of set scores {g1, g2, p}; player 1 serves first. tb = P(p1 wins tie-break). */
export function setDistribution(h1, h2, start = [0, 0]) {
  const tb = clamp(0.5 + (h1 - h2) * 0.9, 0.05, 0.95);
  const out = new Map(); const add = (k, p) => out.set(k, (out.get(k) || 0) + p);
  const go = (a, b, p) => {
    if (p < 1e-10) return;
    if ((a >= 6 || b >= 6) && Math.abs(a - b) >= 2) return add(`${a}-${b}`, p);
    if (a === 7 || b === 7) return add(`${a}-${b}`, p);
    if (a === 6 && b === 6) { add('7-6', p * tb); add('6-7', p * (1 - tb)); return; }
    const p1serves = (a + b) % 2 === 0;
    const w = p1serves ? h1 : 1 - h2; // P(p1 wins this game)
    go(a + 1, b, p * w); go(a, b + 1, p * (1 - w));
  };
  go(start[0], start[1], 1);
  return [...out.entries()].map(([k, p]) => { const [g1, g2] = k.split('-').map(Number); return { g1, g2, p }; });
}
const setWin = (h1, h2) => setDistribution(h1, h2).reduce((s, x) => s + (x.g1 > x.g2 ? x.p : 0), 0);

/** Find holds (base ± δ) whose set-win probability equals s. */
export function holdsFor(s, base1, base2) {
  let lo = -0.4, hi = 0.4;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (setWin(clamp(base1 + mid, 0.3, 0.97), clamp(base2 - mid, 0.3, 0.97)) < s) lo = mid; else hi = mid;
  }
  const d = (lo + hi) / 2;
  return [clamp(base1 + d, 0.3, 0.97), clamp(base2 - d, 0.3, 0.97)];
}

/** Final-match distribution over {games1, games2, sets1, sets2}. */
export function matchGames(h1, h2, bestOf = 3, state = { sets: [0, 0], games: [0, 0], current: null }) {
  const need = Math.ceil(bestOf / 2);
  const fresh = setDistribution(h1, h2);
  const out = [];
  const go = (s1, s2, g1, g2, p, cur) => {
    if (s1 >= need || s2 >= need) { out.push({ g1, g2, s1, s2, p }); return; }
    const dist = cur ? setDistribution(h1, h2, cur) : fresh;
    for (const x of dist) go(s1 + (x.g1 > x.g2 ? 1 : 0), s2 + (x.g2 > x.g1 ? 1 : 0), g1 + x.g1, g2 + x.g2, p * x.p, null);
  };
  go(state.sets[0], state.sets[1], state.games[0], state.games[1], 1, state.current);
  return out;
}

export function parseSetScores(str) {
  return String(str || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('-').map((n) => parseInt(n, 10))).filter((x) => x.length === 2 && x.every(Number.isFinite));
}

function tennisExtras(match, ctx) {
  const t = ctx.tennis; if (!t) return [];
  const st = match.stats || {};
  const base = /wta/.test(match.league) ? 0.66 : 0.79;
  const b1 = Number.isFinite(st.home?.holdPct) ? st.home.holdPct : base;
  const b2 = Number.isFinite(st.away?.holdPct) ? st.away.holdPct : base;
  const [h1, h2] = holdsFor(t.s, b1, b2);
  // live state: completed sets fixed, last set (if unfinished) as starting point
  let state = { sets: [0, 0], games: [0, 0], current: null };
  if (match.status === 'live') {
    const sets = parseSetScores(match.live?.setScores || match.setScores);
    const done = (x) => (Math.max(x[0], x[1]) >= 6 && Math.abs(x[0] - x[1]) >= 2) || Math.max(x[0], x[1]) === 7;
    for (const x of sets) {
      if (done(x)) { state.sets[x[0] > x[1] ? 0 : 1]++; state.games[0] += x[0]; state.games[1] += x[1]; }
      else state.current = x;
    }
  }
  const D = matchGames(h1, h2, t.bestOf, state);
  const E = D.reduce((s, x) => s + x.p * (x.g1 + x.g2), 0);
  const Em = D.reduce((s, x) => s + x.p * (x.g1 - x.g2), 0);
  ctx.expected.games = E;
  const out = [];
  const main = half(E - 0.5);
  out.push(ou({ key: 'gtotal', label: 'Összes játék', line: main, unit: 'játék', alt: false, pOver: prob(D, (x) => x.g1 + x.g2 > main) }));
  for (const [key, line] of [['gtotal_lo', main - 2], ['gtotal_hi', main + 2]]) out.push(ou({ key, label: 'Összes játék', line, unit: 'játék', pOver: prob(D, (x) => x.g1 + x.g2 > line) }));
  let best = null;
  for (let L = -7.5; L <= 7.5; L += 1) { const p = prob(D, (x) => x.g1 - x.g2 + L > 0); if (!best || Math.abs(p - 0.5) < Math.abs(best.p - 0.5)) best = { L, p }; }
  void Em;
  out.push(hcp({ key: 'gspread', label: 'Játékhendikep', line: best.L, pHome: best.p, home: match.home.name, away: match.away.name, unit: ' játék' }));
  const pBoth = prob(D, (x) => x.s1 > 0 && x.s2 > 0);
  out.push({ key: 'bothsets', label: 'Mindkét játékos nyer szettet', family: 'btts', exhaustive: true, alt: true, selections: [
    { key: 'yes', label: 'Igen', name: 'Mindkét játékos nyer szettet', p: pBoth, side: 'over' },
    { key: 'no', label: 'Nem', name: 'Nem nyer mindkét játékos szettet', p: 1 - pBoth, side: 'under' }] });
  return out;
}

function safeProps(match, ctx) {
  try { return playerProps(match, ctx); } catch (err) { ctx.notes.push('Játékospiacok nem számolhatók: ' + err.message); return []; }
}

export function extraMarkets(match, ctx) {
  try {
    switch (match.sport) {
      case 'football': return ctx.mat ? footballExtras(match, ctx) : [];
      case 'nhl': return ctx.mat ? [...nhlExtras(match, ctx), ...safeProps(match, ctx)] : [];
      case 'nba': return ctx.dist ? [...normalExtras(match, ctx, { unit: 'pont', alt: 6, playerKey: 'ppg', playerLabel: 'pontjai' }), ...safeProps(match, ctx)] : [];
      case 'handball': return ctx.dist ? normalExtras(match, ctx, { unit: 'gól', alt: 3, playerKey: 'gpg', playerLabel: 'góljai' }) : [];
      case 'tennis': return tennisExtras(match, ctx);
      default: return [];
    }
  } catch (err) {
    ctx.notes.push('Kiegészítő piacok nem számolhatók: ' + err.message);
    return [];
  }
}
