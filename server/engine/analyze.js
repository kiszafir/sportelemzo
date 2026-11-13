// Match analysis: factors -> models -> markets -> value, confidence and a
// Hungarian explanation for the recommended bet.
import { buildFactors, coverage, publicFactors } from './features.js';
import { getModel, ENSEMBLE } from './models/index.js';
import { scoreMatrix, marketsFromMatrix, footballLambdas, liveFootball, hockeyLambdas } from './models/poisson.js';
import { tennisProbs, setFromMatch, matchFromState, matchFromSet } from './models/elo.js';
import { normCdf, normInv, poissonPmf, clamp, sigmoid, logit } from './mathutil.js';
import { devig, fairOdds, expectedValue, kelly, round } from './odds.js';
import { extraMarkets, overWithOT } from './extras.js';
import { STAT_HU } from './props.js';

const ESTIMATED_MARGIN = 0.06; // used only when no bookmaker or manual odds exist
const fmtNum = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : '–');
const pctHu = (p, d = 0) => fmtNum(p * 100, d) + '%';
const half = (x) => Math.floor(x) + 0.5; // lines always at .5 to avoid pushes

// ---------------------------------------------------------------------------
// Probability models per sport. Return a list of markets with model probabilities.
// ---------------------------------------------------------------------------
function ensembleTwoWay(match, factors) {
  const w = getModel('weighted').predict(match, factors);
  const cfg = ENSEMBLE[match.sport];
  let spec = null;
  if (cfg.specific === 'logistic') spec = getModel('logistic').predict(match, factors);
  return { w, spec, cfg };
}

function nbaMarkets(match, factors, ctx) {
  const { w, spec, cfg } = ensembleTwoWay(match, factors);
  const pPre = cfg.wSpecific * spec.pHome + (1 - cfg.wSpecific) * w.pHome;
  ctx.models = { weighted: w.pHome, specific: spec.pHome, specificName: 'Logisztikus regresszió', trained: spec.trained };
  ctx.contrib = w.contributions;
  const h = match.stats?.home || {}; const a = match.stats?.away || {};
  // Expected total: pace × average of (offence vs opposing defence) ratings.
  let muT = 226; let estimatedTotal = true;
  if ([h.pace, a.pace, h.netRtg, a.netRtg, h.drtg, a.drtg].every(Number.isFinite)) {
    const ortgH = h.drtg + h.netRtg; const ortgA = a.drtg + a.netRtg;
    const pace = (h.pace + a.pace) / 2;
    muT = pace * (((ortgH + a.drtg) / 2) + ((ortgA + h.drtg) / 2)) / 100;
    estimatedTotal = false;
  } else if ([h.ppg, h.oppPpg, a.ppg, a.oppPpg].every(Number.isFinite)) {
    muT = (h.ppg + a.oppPpg) / 2 + (a.ppg + h.oppPpg) / 2; estimatedTotal = false;
  }
  const SIG_M = 13, SIG_T = 18;
  let muM = SIG_M * normInv(pPre); let sM = SIG_M; let sT = SIG_T; let curM = 0; let curT = 0; let r = 1;
  if (match.status === 'live' && match.live) {
    r = clamp(1 - (match.live.elapsedMin ?? 0) / 48, 0.01, 1);
    curM = (match.home.score || 0) - (match.away.score || 0); curT = (match.home.score || 0) + (match.away.score || 0);
    muM *= r; sM = SIG_M * Math.sqrt(r) + 0.5; muT *= r; sT = SIG_T * Math.sqrt(r) + 0.5;
  }
  const pHome = normCdf((curM + muM) / sM);
  ctx.expected = { margin: curM + muM, total: curT + muT, estimatedTotal };
  ctx.dist = { M: curM + muM, sM, T: curT + muT, sT };
  const spreadLine = match.lines?.spread ?? -(Math.floor(curM + muM) + 0.5); // home handicap, always .5
  const pCover = normCdf((curM + muM + spreadLine) / sM);
  const totalLine = match.lines?.total ?? half(curT + muT);
  const pOver = 1 - normCdf((totalLine - (curT + muT)) / sT);
  return [
    { key: 'ml', label: 'Győztes (hosszabbítással)', family: 'result', exhaustive: true, selections: [
      { key: 'home', label: '1', name: `${match.home.name} győz`, p: pHome, side: 'home' },
      { key: 'away', label: '2', name: `${match.away.name} győz`, p: 1 - pHome, side: 'away' }] },
    { key: 'spread', label: `Hendikep (${spreadLine > 0 ? '+' : ''}${fmtNum(spreadLine)})`, family: 'spread', line: spreadLine, exhaustive: true, selections: [
      { key: 'home', label: `1 (${spreadLine > 0 ? '+' : ''}${fmtNum(spreadLine)})`, name: `${match.home.name} ${spreadLine > 0 ? '+' : ''}${fmtNum(spreadLine)}`, p: pCover, side: 'home' },
      { key: 'away', label: `2 (${-spreadLine > 0 ? '+' : ''}${fmtNum(-spreadLine)})`, name: `${match.away.name} ${-spreadLine > 0 ? '+' : ''}${fmtNum(-spreadLine)}`, p: 1 - pCover, side: 'away' }] },
    { key: 'total', label: `Összpontszám (${fmtNum(totalLine)})`, family: 'totals', line: totalLine, exhaustive: true, selections: [
      { key: 'over', label: `Több mint ${fmtNum(totalLine)}`, name: `Több mint ${fmtNum(totalLine)} pont`, p: pOver, side: 'over' },
      { key: 'under', label: `Kevesebb mint ${fmtNum(totalLine)}`, name: `Kevesebb mint ${fmtNum(totalLine)} pont`, p: 1 - pOver, side: 'under' }] },
  ];
}

function nhlMarkets(match, factors, ctx) {
  const { w, spec, cfg } = ensembleTwoWay(match, factors);
  let pHome = cfg.wSpecific * spec.pHome + (1 - cfg.wSpecific) * w.pHome;
  ctx.models = { weighted: w.pHome, specific: spec.pHome, specificName: 'Logisztikus regresszió', trained: spec.trained };
  ctx.contrib = w.contributions;
  let { lh, la, estimated } = hockeyLambdas(match);
  // Tilt goal expectations towards the ensemble winner probability.
  // (total expected goals is preserved, only the split moves)
  const tilt = (pHome - 0.5) * 0.8; const tot0 = lh + la;
  lh *= Math.exp(tilt); la *= Math.exp(-tilt);
  const k = tot0 / (lh + la); lh *= k; la *= k;
  let offH = 0, offA = 0;
  const pPre = pHome;
  if (match.status === 'live' && match.live) {
    const r = clamp(1 - (match.live.elapsedMin ?? 0) / 60, 0.01, 1);
    lh *= r; la *= r; offH = match.home.score || 0; offA = match.away.score || 0;
    // Live winner: regulation Poisson + overtime split by pre-game probability.
    const mat = scoreMatrix(lh, la, { offsetH: offH, offsetA: offA, maxGoals: 8, rho: 0 });
    const m = marketsFromMatrix(mat, []);
    pHome = m.home + m.draw * clamp(pHome, 0.3, 0.7);
  }
  const line = match.lines?.total ?? 5.5;
  const mat = scoreMatrix(lh, la, { offsetH: offH, offsetA: offA, maxGoals: 10, rho: 0 });
  const otHome = clamp(pPre, 0.3, 0.7);
  const pOverMain = overWithOT(mat, otHome, line); // totals include the overtime goal
  Object.assign(ctx, { mat, otHome, pHome, totalLine: line, lamRem: { lh, la } });
  ctx.expected = { lh: lh + offH, la: la + offA, total: lh + la + offH + offA, estimatedTotal: estimated };
  return [
    { key: 'ml', label: 'Győztes (hosszabbítással)', family: 'result', exhaustive: true, selections: [
      { key: 'home', label: '1', name: `${match.home.name} győz`, p: pHome, side: 'home' },
      { key: 'away', label: '2', name: `${match.away.name} győz`, p: 1 - pHome, side: 'away' }] },
    { key: 'total', label: `Gólszám (${fmtNum(line)})`, family: 'totals', line, exhaustive: true, selections: [
      { key: 'over', label: `Több mint ${fmtNum(line)}`, name: `Több mint ${fmtNum(line)} gól`, p: pOverMain, side: 'over' },
      { key: 'under', label: `Kevesebb mint ${fmtNum(line)}`, name: `Kevesebb mint ${fmtNum(line)} gól`, p: 1 - pOverMain, side: 'under' }] },
  ];
}

function footballMarkets(match, factors, ctx) {
  const w = getModel('weighted').predict(match, factors);
  const { lh, la, notes } = footballLambdas(match, factors, w.score);
  ctx.notes.push(...notes);
  const mat = match.status === 'live' && match.live ? liveFootball(lh, la, { ...match.live, scoreHome: match.home.score, scoreAway: match.away.score }) : scoreMatrix(lh, la);
  const m = marketsFromMatrix(mat, [1.5, 2.5, 3.5]);
  ctx.mat = mat; ctx.lam = { lh, la };
  // Ensemble: keep the Poisson draw probability, split the rest using a blend of
  // the Poisson home/away ratio and the weighted model's two-way probability.
  const cfg = ENSEMBLE.football;
  const pDraw = m.draw;
  const pPoisHome2 = m.home / (m.home + m.away);
  const live = match.status === 'live';
  const wS = live ? 0.9 : cfg.wSpecific; // in-play the score state dominates
  const pHome2 = wS * pPoisHome2 + (1 - wS) * w.pHome;
  const pHome = (1 - pDraw) * pHome2; const pAway = (1 - pDraw) * (1 - pHome2);
  ctx.models = { weighted: w.pHome, specific: pPoisHome2, specificName: 'Poisson (Dixon–Coles)' };
  ctx.contrib = w.contributions;
  ctx.expected = { lh, la, total: lh + la, live: live ? { score: `${match.home.score}-${match.away.score}` } : null };
  const n = (s) => s;
  const ou = (line) => ({ key: `ou${String(line).replace('.', '')}`, label: `Gólszám (${fmtNum(line)})`, family: 'totals', line, exhaustive: true, selections: [
    { key: 'over', label: `Több mint ${fmtNum(line)}`, name: `Több mint ${fmtNum(line)} gól`, p: m.over[line], side: 'over' },
    { key: 'under', label: `Kevesebb mint ${fmtNum(line)}`, name: `Kevesebb mint ${fmtNum(line)} gól`, p: 1 - m.over[line], side: 'under' }] });
  return [
    { key: '1x2', label: 'Végeredmény (1X2)', family: 'result', exhaustive: true, selections: [
      { key: 'home', label: '1', name: n(`${match.home.name} győz`), p: pHome, side: 'home' },
      { key: 'draw', label: 'X', name: 'Döntetlen', p: pDraw, side: 'draw' },
      { key: 'away', label: '2', name: n(`${match.away.name} győz`), p: pAway, side: 'away' }] },
    { key: 'dc', label: 'Kettős esély', family: 'result', exhaustive: false, selections: [
      { key: '1x', label: '1X', name: `${match.home.name} nem kap ki`, p: pHome + pDraw, side: 'home' },
      { key: '12', label: '12', name: 'Nem lesz döntetlen', p: pHome + pAway, side: 'none' },
      { key: 'x2', label: 'X2', name: `${match.away.name} nem kap ki`, p: pAway + pDraw, side: 'away' }] },
    ou(1.5), ou(2.5), ou(3.5),
    { key: 'btts', label: 'Mindkét csapat szerez gólt', family: 'btts', exhaustive: true, selections: [
      { key: 'yes', label: 'Igen', name: 'Mindkét csapat szerez gólt', p: m.btts, side: 'over' },
      { key: 'no', label: 'Nem', name: 'Nem szerez mindkét csapat gólt', p: 1 - m.btts, side: 'under' }] },
  ];
}

function tennisMarkets(match, factors, ctx) {
  const w = getModel('weighted').predict(match, factors);
  const elo = tennisProbs(match);
  const cfg = ENSEMBLE.tennis;
  let pPre = elo ? cfg.wSpecific * elo.p + (1 - cfg.wSpecific) * w.pHome : w.pHome;
  ctx.models = { weighted: w.pHome, specific: elo?.p ?? null, specificName: 'Borításfüggő Elo' };
  ctx.contrib = w.contributions;
  if (!elo) ctx.notes.push('Elo-adat nélkül csak a súlyozott modell fut.');
  const bestOf = match.bestOf || 3;
  const s = setFromMatch(pPre, bestOf);
  const need = Math.ceil(bestOf / 2);
  let pHome = pPre;
  const setsH = match.home.sets ?? 0, setsA = match.away.sets ?? 0;
  if (match.status === 'live') pHome = matchFromState(s, setsH, setsA, bestOf);
  // Straight-sets probabilities (from current state when live).
  const straightH = setsA > 0 ? 0 : s ** (need - setsH);
  const straightA = setsH > 0 ? 0 : (1 - s) ** (need - setsA);
  ctx.expected = { setProb: s, bestOf, elo: elo ? { e1: Math.round(elo.e1), e2: Math.round(elo.e2) } : null };
  ctx.tennis = { s, bestOf };
  void matchFromSet;
  return [
    { key: 'ml', label: 'Győztes', family: 'result', exhaustive: true, selections: [
      { key: 'home', label: '1', name: `${match.home.name} nyer`, p: pHome, side: 'home' },
      { key: 'away', label: '2', name: `${match.away.name} nyer`, p: 1 - pHome, side: 'away' }] },
    { key: 'straight', label: 'Nyer szettveszteség nélkül', family: 'sets', exhaustive: false, selections: [
      { key: 'home', label: `1 (${need}:0)`, name: `${match.home.name} ${need}:0`, p: straightH, side: 'home' },
      { key: 'away', label: `2 (0:${need})`, name: `${match.away.name} ${need}:0`, p: straightA, side: 'away' }] },
    { key: 'oneset', label: 'Legalább egy szettet nyer', family: 'sets', exhaustive: false, selections: [
      { key: 'home', label: '1 nyer szettet', name: `${match.home.name} legalább 1 szettet nyer`, p: 1 - straightA, side: 'home' },
      { key: 'away', label: '2 nyer szettet', name: `${match.away.name} legalább 1 szettet nyer`, p: 1 - straightH, side: 'away' }] },
  ];
}

// Handball: goal margin and total ~ Normal (sd 6.2 / 6.0 goals). Draw = P(|margin| < 0.5).
const HB_SD_M = 6.2; const HB_SD_T = 6.0;
function handballMarkets(match, factors, ctx) {
  const w = getModel('weighted').predict(match, factors);
  const h = match.stats?.home || {}; const a = match.stats?.away || {};
  const women = /w$/.test(match.league);
  const mu = women ? 27.5 : 29.5; // goals per team per match
  let goalMargin = null; let muT = 2 * mu; let estimatedTotal = true;
  if ([h.gfPg, h.gaPg, a.gfPg, a.gaPg].every(Number.isFinite)) {
    const k = (gp) => (gp || 10) / ((gp || 10) + 5); // small-sample shrinkage towards the league mean
    const eh = mu + k(h.gamesPlayed) * ((h.gfPg + a.gaPg) / 2 - mu) + 0.9;
    const ea = mu + k(a.gamesPlayed) * ((a.gfPg + h.gaPg) / 2 - mu) - 0.9;
    goalMargin = eh - ea; muT = eh + ea; estimatedTotal = false;
  }
  const mW = HB_SD_M * normInv(clamp(w.pHome, 0.02, 0.98));
  let muM = goalMargin == null ? mW : 0.6 * goalMargin + 0.4 * mW;
  let sM = HB_SD_M; let sT = HB_SD_T; let curM = 0; let curT = 0;
  if (match.status === 'live' && match.live) {
    const r = clamp(1 - (match.live.elapsedMin ?? 0) / 60, 0.01, 1);
    curM = (match.home.score || 0) - (match.away.score || 0); curT = (match.home.score || 0) + (match.away.score || 0);
    muM *= r; muT *= r; sM = HB_SD_M * Math.sqrt(r) + 0.35; sT = HB_SD_T * Math.sqrt(r) + 0.35;
  }
  const M = curM + muM; const T = curT + muT;
  const pHome = 1 - normCdf((0.5 - M) / sM); const pAway = normCdf((-0.5 - M) / sM); const pDraw = Math.max(0.001, 1 - pHome - pAway);
  ctx.models = { weighted: w.pHome, specific: goalMargin == null ? null : normCdf(goalMargin / HB_SD_M), specificName: 'Gólkülönbség-modell' };
  ctx.contrib = w.contributions;
  ctx.expected = { margin: M, total: T, estimatedTotal };
  ctx.dist = { M, sM, T, sT };
  if (goalMargin == null) ctx.notes.push('Gólstatisztika hiányában a különbség az erősségi pontszámból becsülve.');
  const spreadLine = match.lines?.spread ?? -(Math.floor(M) + 0.5);
  const pCover = normCdf((M + spreadLine) / sM);
  const totalLine = match.lines?.total ?? half(T);
  const pOver = 1 - normCdf((totalLine - T) / sT);
  const sg = (x) => `${x > 0 ? '+' : ''}${fmtNum(x)}`;
  return [
    { key: '1x2', label: 'Végeredmény (1X2)', family: 'result', exhaustive: true, selections: [
      { key: 'home', label: '1', name: `${match.home.name} győz`, p: pHome, side: 'home' },
      { key: 'draw', label: 'X', name: 'Döntetlen', p: pDraw, side: 'draw' },
      { key: 'away', label: '2', name: `${match.away.name} győz`, p: pAway, side: 'away' }] },
    { key: 'dc', label: 'Kettős esély', family: 'result', exhaustive: false, selections: [
      { key: '1x', label: '1X', name: `${match.home.name} nem kap ki`, p: pHome + pDraw, side: 'home' },
      { key: '12', label: '12', name: 'Nem lesz döntetlen', p: pHome + pAway, side: 'none' },
      { key: 'x2', label: 'X2', name: `${match.away.name} nem kap ki`, p: pAway + pDraw, side: 'away' }] },
    { key: 'spread', label: `Hendikep (${sg(spreadLine)})`, family: 'spread', line: spreadLine, exhaustive: true, selections: [
      { key: 'home', label: `1 (${sg(spreadLine)})`, name: `${match.home.name} ${sg(spreadLine)}`, p: pCover, side: 'home' },
      { key: 'away', label: `2 (${sg(-spreadLine)})`, name: `${match.away.name} ${sg(-spreadLine)}`, p: 1 - pCover, side: 'away' }] },
    { key: 'total', label: `Gólszám (${fmtNum(totalLine)})`, family: 'totals', line: totalLine, exhaustive: true, selections: [
      { key: 'over', label: `Több mint ${fmtNum(totalLine)}`, name: `Több mint ${fmtNum(totalLine)} gól`, p: pOver, side: 'over' },
      { key: 'under', label: `Kevesebb mint ${fmtNum(totalLine)}`, name: `Kevesebb mint ${fmtNum(totalLine)} gól`, p: 1 - pOver, side: 'under' }] },
  ];
}

const SPORT_MARKETS = { nba: nbaMarkets, nhl: nhlMarkets, football: footballMarkets, tennis: tennisMarkets, handball: handballMarkets };

// ---------------------------------------------------------------------------
// Odds attachment, value and confidence
// ---------------------------------------------------------------------------
export const selectionId = (matchId, market, sel) => `${matchId}|${market}|${sel}`;

function attachOdds(match, markets, manual = {}) {
  for (const mk of markets) {
    const book = match.odds?.[mk.key] || {};
    for (const s of mk.selections) {
      s.p = clamp(s.p, 0.001, 0.999);
      s.fair = fairOdds(s.p);
      const quotes = (book[s.key] || []).filter((q) => q.odds > 1.001);
      const best = quotes.reduce((b, q) => (!b || q.odds > b.odds ? q : b), null);
      const man = manual[`${mk.key}:${s.key}`];
      s.market = best ? { best: best.odds, book: best.book, src: best.src, quotes: quotes.map((q) => ({ book: q.book, odds: q.odds })) } : null;
      if (man > 1) { s.odds = man; s.oddsSource = 'manual'; }
      else if (best) { s.odds = best.odds; s.oddsSource = best.src || 'live'; }
      else { s.odds = round(Math.max(1.01, s.fair / (1 + ESTIMATED_MARGIN)), 2); s.oddsSource = 'estimated'; }
    }
    // Vig removal on the best available prices (needs a complete, exhaustive market).
    const priced = mk.selections.every((s) => s.oddsSource !== 'estimated');
    if (mk.exhaustive && priced) {
      const nv = devig(mk.selections.map((s) => s.odds), 'shin');
      const nvp = devig(mk.selections.map((s) => s.odds), 'proportional');
      mk.overround = mk.selections.reduce((t, s) => t + 1 / s.odds, 0) - 1;
      mk.selections.forEach((s, i) => { s.novig = nv[i]; s.novigProp = nvp[i]; });
    }
    if (mk.key === 'dc') {
      const x = markets.find((m) => m.key === '1x2');
      const nv = Object.fromEntries((x?.selections || []).map((s) => [s.key, s.novig]));
      if (nv.home != null && mk.selections.every((s) => s.oddsSource !== 'estimated')) {
        const map = { '1x': nv.home + nv.draw, '12': nv.home + nv.away, x2: nv.away + nv.draw };
        mk.selections.forEach((s) => { s.novig = map[s.key]; });
      }
    }
    for (const s of mk.selections) {
      s.ev = expectedValue(s.p, s.odds);
      s.edge = s.novig != null ? s.p - s.novig : null;
      // In-play outcomes that are already (practically) settled: no stake suggestion.
      s.decided = match.status === 'live' && (s.p >= 0.985 || s.p <= 0.015);
      s.kelly = s.oddsSource === 'estimated' || s.decided ? 0 : kelly(s.p, s.odds);
      s.id = selectionId(match.id, mk.key, s.key);
    }
  }
}

/**
 * AI-motor hook: replace pre-match probabilities of exhaustive markets by the
 * learned, validated calibrator (see engine/ai.js). The raw value is kept in
 * s.pRaw. Double chance is rebuilt from the adjusted 1X2.
 */
const AI_FAMILIES = new Set(['result', 'totals', 'spread', 'btts', 'teamtotals', 'cards', 'player', 'playerdd']);
function applyAdjust(match, markets, adjust) {
  if (!adjust || match.status !== 'pre') return false;
  let any = false;
  const setP = (s, p, pRaw) => {
    s.pRaw = pRaw; s.p = clamp(p, 0.001, 0.999); s.fair = fairOdds(s.p);
    if (s.oddsSource === 'estimated') s.odds = round(Math.max(1.01, s.fair / (1 + ESTIMATED_MARGIN)), 2);
  };
  for (const mk of markets) {
    if (mk.key === 'dc' || !mk.exhaustive || !AI_FAMILIES.has(mk.family)) continue;
    const res = adjust(mk.family, mk.selections.map((x) => ({ p: x.p, pk: x.novig ?? null })));
    if (!res) continue;
    mk.selections.forEach((x, i) => setP(x, res[i], x.p));
    mk.aiAdjusted = true; any = true;
  }
  const x12 = markets.find((m) => m.key === '1x2' && m.aiAdjusted); const dc = markets.find((m) => m.key === 'dc');
  if (x12 && dc) {
    const P = Object.fromEntries(x12.selections.map((x) => [x.key, x.p])); const R = Object.fromEntries(x12.selections.map((x) => [x.key, x.pRaw]));
    const pair = { '1x': ['home', 'draw'], 12: ['home', 'away'], x2: ['away', 'draw'] };
    dc.selections.forEach((x) => { const [a, b] = pair[x.key]; setP(x, P[a] + P[b], R[a] + R[b]); });
    dc.aiAdjusted = true;
  }
  for (const mk of markets) {
    if (!mk.aiAdjusted) continue;
    for (const x of mk.selections) {
      x.ev = expectedValue(x.p, x.odds);
      x.edge = x.novig != null ? x.p - x.novig : null;
      x.kelly = x.oddsSource === 'estimated' ? 0 : kelly(x.p, x.odds);
    }
  }
  return any;
}

/**
 * Confidence 1–100 = 100 · (0.40·coverage + 0.30·agreement + 0.30·decisiveness) · liveFactor
 *   coverage     = share of factor weight backed by data
 *   agreement    = 1 − min(1, |p_specific − p_weighted| / 0.25)
 *   decisiveness = (p_pick − 1/n) / (1 − 1/n)
 */
export function confidenceScore({ cov, pSpec, pW, pPick, nOutcomes = 2, live = false, sampleOk = true }) {
  const agreement = pSpec == null ? 0.5 : 1 - Math.min(1, Math.abs(pSpec - pW) / 0.25);
  const base = 1 / nOutcomes;
  const decisive = clamp((pPick - base) / (1 - base), 0, 1);
  let c = 100 * (0.4 * cov + 0.3 * agreement + 0.3 * decisive);
  if (live) c *= 0.9;
  if (!sampleOk) c *= 0.85;
  return Math.round(clamp(c, 1, 100));
}

const SIDE_HU = { home: 'hazai', away: 'vendég' };

function explain(match, pick, ctx, factors) {
  const parts = [];
  const sideName = pick.side === 'home' ? match.home.name : pick.side === 'away' ? match.away.name : null;
  // Top contributing factors in the direction of the pick.
  const dir = pick.side === 'away' ? -1 : 1;
  const top = (ctx.contrib || [])
    .filter((c) => c.key !== 'homeAdv' && dir * c.c > 0.02)
    .sort((a, b) => dir * b.c - dir * a.c)
    .slice(0, 3);
  const fx = Object.fromEntries(factors.map((f) => [f.key, f]));
  const desc = top.map((t) => {
    const f = fx[t.key];
    if (!f) return t.label;
    const hv = f.fmt ? f.fmt(f.home) : f.home; const av = f.fmt ? f.fmt(f.away) : f.away;
    // Show the picked side's value first.
    return dir > 0 ? `${f.label.toLowerCase()} (${hv} vs. ${av})` : `${f.label.toLowerCase()} (${av} vs. ${hv})`;
  });
  if (sideName && desc.length) parts.push(`${sideName} előnye: ${desc.join(', ')}.`);
  if (pick.side === 'over' || pick.side === 'under') {
    const e = ctx.expected || {};
    if (match.sport === 'football') parts.push(`Várható gólok: ${fmtNum(e.lh, 2)} + ${fmtNum(e.la, 2)} = ${fmtNum(e.total, 2)}.`);
    if (match.sport === 'nhl') parts.push(`Várható gólszám: ${fmtNum(e.total, 2)}${e.estimatedTotal ? ' (becsült)' : ''}.`);
    if (match.sport === 'handball') parts.push(`Várható gólszám: ${fmtNum(e.total, 1)}${e.estimatedTotal ? ' (becsült)' : ''}.`);
    if (match.sport === 'nba') parts.push(`Várható összpontszám: ${fmtNum(e.total, 1)}${e.estimatedTotal ? ' (becsült)' : ''}.`);
  }
  if (match.sport === 'tennis' && ctx.expected?.setProb) parts.push(`Becsült szettnyerési esély: ${pctHu(pick.side === 'away' ? 1 - ctx.expected.setProb : ctx.expected.setProb)}.`);
  parts.push(`A modell szerint ${pctHu(pick.p, 1)} az esély (méltányos szorzó: ${fmtNum(pick.fair, 2)}).`);
  if (pick.pRaw != null && Math.abs(pick.p - pick.pRaw) >= 0.005) parts.push(`Ebben benne van az AI-motor korrekciója: a nyers modellbecslés ${pctHu(pick.pRaw, 1)} volt, a lezárt meccsekből tanult kalibráció alapján lett ${pctHu(pick.p, 1)}.`);
  if (pick.oddsSource === 'estimated') parts.push('Nincs piaci szorzó – adj meg sajátot az érték számításához.');
  else if (pick.novig != null) parts.push(`A piac árrés nélkül ${pctHu(pick.novig, 1)}-ot ad, a ${fmtNum(pick.odds, 2)}-es szorzón a várható érték ${pick.ev >= 0 ? '+' : ''}${fmtNum(pick.ev * 100, 1)}%.`);
  else parts.push(`A ${fmtNum(pick.odds, 2)}-es szorzón a várható érték ${pick.ev >= 0 ? '+' : ''}${fmtNum(pick.ev * 100, 1)}%.`);
  if (match.status === 'live') parts.push(`Élő meccs (${match.home.score ?? 0}–${match.away.score ?? 0}, ${match.live?.clock || match.statusText || ''}): az állás és a hátralévő idő már be van számítva.`);
  return { text: parts.join(' '), top: top.map((t) => ({ key: t.key, label: fx[t.key]?.label || t.label, impact: round(t.c * dir, 3) })) };
}

const BET_TYPE_HU = { ml: 'Győztes', '1x2': 'Végeredmény', dc: 'Kettős esély', spread: 'Hendikep', total: 'Összesített', ou15: 'Gólszám', ou25: 'Gólszám', ou35: 'Gólszám', btts: 'Mindkét csapat gól', straight: 'Szettveszteség nélküli győzelem', oneset: 'Legalább egy szett' };

/** Hungarian bet-type label for a market key (used in the tip log and statistics). */
export function betTypeHu(key) {
  if (BET_TYPE_HU[key]) return BET_TYPE_HU[key];
  if (/^ou/.test(key) || /^total/.test(key)) return 'Gólszám / összpontszám';
  if (/^tt[ha]/.test(key)) return 'Csapat gól-/pontszáma';
  if (/^yc/.test(key)) return 'Sárga lapok';
  if (/^gtotal/.test(key)) return 'Összes játék';
  if (/^pl:/.test(key)) return 'Játékos pontjai / góljai';
  if (/^pp:/.test(key)) { const st = key.split(':')[3]?.replace(/\d+$/, ''); return `Játékos: ${STAT_HU[st]?.short || 'statisztika'}`; }
  return { ah: 'Ázsiai hendikep', scorer: 'Gólszerző', gspread: 'Játékhendikep', bothsets: 'Mindkét játékos nyer szettet' }[key] || null;
}

function chooseTip(match, markets, ctx, factors, cov) {
  // Prices below 1.10 are not worth recommending (nothing left to win).
  // Tips come from the main markets only (extra markets are for the detail page and the mixes).
  const all = markets.filter((mk) => !mk.alt).flatMap((mk) => mk.selections.map((s) => ({ ...s, market: mk.key, marketLabel: mk.label, n: mk.key === '1x2' ? 3 : 2 }))).filter((s) => s.odds >= 1.1);
  const priced = all.filter((s) => s.oddsSource !== 'estimated');
  // 1) Value tip: positive EV ≥ 3% with a not-too-long shot.
  const value = priced.filter((s) => s.ev >= 0.03 && s.p >= 0.22 && s.odds <= 6).sort((a, b) => b.ev * Math.sqrt(b.p) - a.ev * Math.sqrt(a.p))[0];
  // 2) Otherwise the most likely outcome among sensible markets.
  const safe = all.filter((s) => s.p >= 0.55 && s.p <= 0.97).sort((a, b) => b.p - a.p)[0];
  const pick = value || safe; // otherwise: no sensible recommendation
  if (!pick) return null;
  const sampleOk = (match.stats?.home?.gamesPlayed ?? 10) >= 5 && (match.stats?.away?.gamesPlayed ?? 10) >= 5;
  const pSpec = ctx.models?.specific; const pW = ctx.models?.weighted;
  // Compare the models on the pick's side for the winner market.
  const resultPick = pick.side === 'home' || pick.side === 'away';
  const agreeSpec = !resultPick || pSpec == null ? null : pick.side === 'away' ? 1 - pSpec : pSpec;
  const agreeW = pick.side === 'away' ? 1 - pW : pW;
  const confidence = confidenceScore({ cov, pSpec: agreeSpec, pW: agreeW, pPick: pick.p, nOutcomes: pick.n, live: match.status === 'live', sampleOk });
  const ex = explain(match, pick, ctx, factors);
  return {
    id: pick.id, market: pick.market, marketLabel: pick.marketLabel, selection: pick.key, label: pick.label, name: pick.name,
    betType: betTypeHu(pick.market) || pick.marketLabel,
    kind: value ? 'value' : 'safe', kindLabel: value ? 'Értéktipp' : 'Esélyes kimenetel',
    p: pick.p, pRaw: pick.pRaw ?? null, odds: pick.odds, oddsSource: pick.oddsSource, fair: pick.fair, ev: pick.ev, edge: pick.edge, novig: pick.novig,
    kelly: pick.kelly, confidence, reasoning: ex.text, topFactors: ex.top,
  };
}

/** Full analysis for one match. */
export function analyzeMatch(match, { manualOdds = {}, adjust = null } = {}) {
  const factors = buildFactors(match);
  const cov = coverage(factors);
  const ctx = { notes: [] };
  const fn = SPORT_MARKETS[match.sport];
  const markets = fn(match, factors, ctx);
  if (ctx.dist) ctx.dist.totalLine = markets.find((mk) => mk.key === 'total')?.line;
  markets.push(...extraMarkets(match, ctx));
  attachOdds(match, markets, manualOdds);
  const aiApplied = applyAdjust(match, markets, adjust);
  const tip = match.status === 'post' ? null : chooseTip(match, markets, ctx, factors, cov);
  return {
    matchId: match.id,
    coverage: round(cov, 3),
    models: ctx.models,
    expected: ctx.expected,
    notes: ctx.notes,
    players: ctx.players || null,
    ai: { applied: aiApplied },
    markets: markets.map((mk) => ({
      key: mk.key, label: mk.label, family: mk.family, line: mk.line, overround: mk.overround != null ? round(mk.overround, 4) : null, aiAdjusted: mk.aiAdjusted || undefined,
      exhaustive: !!mk.exhaustive, alt: mk.alt || undefined, betType: betTypeHu(mk.key) || mk.label,
      player: mk.player || undefined, playerSide: mk.playerSide || undefined, stat: mk.stat || undefined, projection: mk.projection,
      selections: mk.selections.map((s) => ({
        id: s.id, key: s.key, label: s.label, name: s.name, side: s.side, player: s.player,
        p: round(s.p, 4), pRaw: s.pRaw != null ? round(s.pRaw, 4) : undefined, fair: round(s.fair, 2), odds: round(s.odds, 2), oddsSource: s.oddsSource,
        market: s.market, novig: s.novig != null ? round(s.novig, 4) : null,
        edge: s.edge != null ? round(s.edge, 4) : null, ev: round(s.ev, 4), kelly: round(s.kelly, 4), decided: s.decided || undefined,
      })),
    })),
    tip,
    confidence: tip?.confidence ?? null,
    factors: publicFactors(factors),
  };
}

export { sigmoid, logit, poissonPmf, SIDE_HU };
