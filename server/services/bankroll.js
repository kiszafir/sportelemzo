// Simple bankroll tracker with self-set stake/loss limits that are ENFORCED here
// (the UI also checks them, but the server is the source of truth).
// Raising a limit only takes effect after a 24-hour cooling-off period;
// lowering it is immediate (standard responsible-gambling practice).
import crypto from 'node:crypto';
import { db, store } from '../store.js';
import { localDay, localWeekStart } from '../lib/time.js';
import { kellyStake } from '../engine/odds.js';
import { httpError } from '../lib/router.js';

const COOLING_MS = 24 * 3600e3;
const LIMIT_KEYS = ['dailyStake', 'weeklyStake', 'dailyLoss', 'weeklyLoss'];

const profitOf = (b) => (b.status === 'won' ? b.stake * (b.odds - 1) : b.status === 'lost' ? -b.stake : 0);

function applyPendingLimits() {
  const s = db().settings;
  if (s.pendingLimits && Date.now() >= s.pendingLimits.effectiveAt) {
    Object.assign(s.limits, s.pendingLimits.values); delete s.pendingLimits; store.save();
  }
}

export function usage(now = Date.now()) {
  applyPendingLimits();
  const bets = db().bets; const today = localDay(now); const week = localWeekStart(now);
  const isToday = (t) => localDay(t) === today; const isWeek = (t) => localDay(t) >= week;
  const stakedToday = bets.filter((b) => isToday(b.createdAt)).reduce((s, b) => s + b.stake, 0);
  const stakedWeek = bets.filter((b) => isWeek(b.createdAt)).reduce((s, b) => s + b.stake, 0);
  const pnlToday = bets.filter((b) => b.settledAt && isToday(b.settledAt)).reduce((s, b) => s + profitOf(b), 0);
  const pnlWeek = bets.filter((b) => b.settledAt && isWeek(b.settledAt)).reduce((s, b) => s + profitOf(b), 0);
  const L = db().settings.limits;
  const balance = db().settings.bankrollStart + bets.reduce((s, b) => s + profitOf(b), 0);
  const openStakes = bets.filter((b) => b.status === 'pending').reduce((s, b) => s + b.stake, 0);
  return {
    balance, available: balance - openStakes, openStakes,
    stakedToday, stakedWeek, lossToday: Math.max(0, -pnlToday), lossWeek: Math.max(0, -pnlWeek),
    remaining: {
      dailyStake: Math.max(0, L.dailyStake - stakedToday), weeklyStake: Math.max(0, L.weeklyStake - stakedWeek),
      dailyLoss: Math.max(0, L.dailyLoss + Math.min(0, pnlToday)), weeklyLoss: Math.max(0, L.weeklyLoss + Math.min(0, pnlWeek)),
    },
  };
}

/** Returns a list of Hungarian messages; empty list = allowed. */
export function checkLimits(stake) {
  const u = usage(); const L = db().settings.limits; const msgs = [];
  const ft = (x) => Math.round(x).toLocaleString('hu-HU') + ' Ft';
  const pause = db().settings.selfPauseUntil;
  if (pause && Date.now() < pause) msgs.push(`Önkéntes szünetet állítottál be ${new Date(pause).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}-ig. Addig nem rögzíthetsz új tétet.`);
  if (u.lossToday >= L.dailyLoss) msgs.push(`Elérted a napi veszteségkorlátot (${ft(L.dailyLoss)}). Holnap újra rögzíthetsz tétet.`);
  if (u.lossWeek >= L.weeklyLoss) msgs.push(`Elérted a heti veszteségkorlátot (${ft(L.weeklyLoss)}). A korlát hétfőn nullázódik.`);
  if (u.stakedToday + stake > L.dailyStake) msgs.push(`A tét túllépné a napi tétkorlátot: ma még ${ft(u.remaining.dailyStake)} tehető.`);
  if (u.stakedWeek + stake > L.weeklyStake) msgs.push(`A tét túllépné a heti tétkorlátot: ezen a héten még ${ft(u.remaining.weeklyStake)} tehető.`);
  if (stake > u.available) msgs.push(`A tét nagyobb, mint a szabad egyenleg (${ft(u.available)}).`);
  return msgs;
}

export function addBet({ description, odds, stake, sport, market, p, tipId }) {
  odds = Number(odds); stake = Math.round(Number(stake));
  if (!(odds > 1 && odds < 10000)) throw httpError(400, 'A szorzónak 1,00-nál nagyobbnak kell lennie.');
  if (!(stake > 0)) throw httpError(400, 'A tétnek pozitív egész számnak kell lennie.');
  const msgs = checkLimits(stake);
  if (msgs.length) { const e = httpError(422, msgs.join(' ')); e.publicMessage = msgs.join(' '); throw e; }
  const bet = { id: crypto.randomUUID(), createdAt: Date.now(), description: String(description || 'Saját fogadás').slice(0, 200), sport: sport || null, market: market || null,
    odds, stake, p: Number.isFinite(Number(p)) ? Number(p) : null, tipId: tipId || null, status: 'pending', settledAt: null };
  db().bets.push(bet); store.save();
  return bet;
}

export function settleBet(id, status) {
  if (!['won', 'lost', 'void', 'pending'].includes(status)) throw httpError(400, 'Érvénytelen eredmény.');
  const b = db().bets.find((x) => x.id === id); if (!b) throw httpError(404, 'Nincs ilyen fogadás.');
  b.status = status; b.settledAt = status === 'pending' ? null : Date.now(); store.save();
  return b;
}

export function deleteBet(id) {
  const i = db().bets.findIndex((x) => x.id === id); if (i < 0) throw httpError(404, 'Nincs ilyen fogadás.');
  db().bets.splice(i, 1); store.save();
}

export function updateSettings(body = {}) {
  const s = db().settings; const notes = [];
  if (body.bankrollStart != null) {
    const v = Math.round(Number(body.bankrollStart)); if (!(v >= 0 && v < 1e10)) throw httpError(400, 'Érvénytelen kezdő bankroll.');
    s.bankrollStart = v;
  }
  if (body.kellyFraction != null) {
    const v = Number(body.kellyFraction); if (!(v > 0 && v <= 1)) throw httpError(400, 'A Kelly-hányad 0 és 1 közé essen.'); s.kellyFraction = v;
  }
  if (body.kellyCap != null) {
    const v = Number(body.kellyCap); if (!(v > 0 && v <= 0.1)) throw httpError(400, 'A tétplafon legfeljebb a bankroll 10%-a lehet.'); s.kellyCap = v;
  }
  if (body.limits) {
    const inc = {};
    for (const k of LIMIT_KEYS) {
      if (body.limits[k] == null) continue;
      const v = Math.round(Number(body.limits[k])); if (!(v >= 0)) throw httpError(400, 'A korlát nem lehet negatív.');
      if (v <= s.limits[k]) s.limits[k] = v; else inc[k] = v;
    }
    if (body.limits.sessionReminderMin != null) {
      const v = Math.round(Number(body.limits.sessionReminderMin)); if (!(v >= 5 && v <= 240)) throw httpError(400, 'Az emlékeztető 5 és 240 perc között legyen.');
      s.limits.sessionReminderMin = v;
    }
    if (Object.keys(inc).length) {
      s.pendingLimits = { values: { ...(s.pendingLimits?.values || {}), ...inc }, effectiveAt: Date.now() + COOLING_MS };
      notes.push('A korlátok emelése 24 óra türelmi idő után lép életbe. A csökkentés azonnal érvényes.');
    }
  }
  store.save();
  return { settings: s, notes };
}

export function kellySuggestion(p, odds) {
  const s = db().settings; const u = usage();
  const remaining = Math.min(u.remaining.dailyStake, u.remaining.weeklyStake, u.remaining.dailyLoss, u.remaining.weeklyLoss, Math.max(0, u.available));
  return { ...kellyStake({ p, odds, bankroll: Math.max(0, u.balance), fraction: s.kellyFraction, cap: s.kellyCap, remainingLimit: remaining }), fraction: s.kellyFraction, cap: s.kellyCap, remainingLimit: remaining };
}

export function bankrollView() {
  const s = db().settings; const bets = [...db().bets].sort((a, b) => a.createdAt - b.createdAt);
  let bal = s.bankrollStart;
  const series = [{ t: bets[0]?.createdAt ?? Date.now(), balance: bal }];
  const rows = bets.map((b) => {
    const pnl = profitOf(b); bal += pnl;
    if (b.status !== 'pending') series.push({ t: b.settledAt || b.createdAt, balance: bal });
    return { ...b, profit: pnl, runningBalance: bal };
  });
  return { settings: s, usage: usage(), bets: rows.reverse(), series };
}

/** Voluntary in-app break (1, 7 or 30 days). Cannot be shortened once set. */
export function selfPause(days) {
  if (![1, 7, 30].includes(Number(days))) throw httpError(400, 'A szünet 1, 7 vagy 30 nap lehet.');
  const until = Date.now() + Number(days) * 24 * 3600e3;
  const s = db().settings;
  s.selfPauseUntil = Math.max(s.selfPauseUntil || 0, until);
  store.save();
  return { selfPauseUntil: s.selfPauseUntil };
}
