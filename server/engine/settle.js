// Settles a selection against a finished match.
// Returns 'won' | 'lost' | 'void' | null (not final yet).
// Markets whose result data is missing (e.g. no goalscorer list from the
// provider) are settled as 'void', never guessed.
import { parseSetScores } from './extras.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
/** Same player? Full-name match, or same surname + same first initial ("K. Mbappé" vs "Kylian Mbappé"). */
export function samePlayer(a, b) {
  const x = norm(a).split(' ').filter(Boolean); const y = norm(b).split(' ').filter(Boolean);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}

const overUnder = (value, line, selKey) => {
  if (!Number.isFinite(value)) return 'void';
  if (value === line) return 'void';
  return (selKey === 'over' ? value > line : value < line) ? 'won' : 'lost';
};

export function settleSelection(match, marketKey, selKey, line) {
  if (!match || match.status !== 'post') return null;
  if (match.void) return 'void';
  const hs = Number(match.home.score); const as = Number(match.away.score);
  const ok = (b) => (b ? 'won' : 'lost');

  if (match.sport === 'tennis') {
    if (match.retired) return 'void'; // retirements are void here (bookmaker rules vary)
    const sets = parseSetScores(match.setScores);
    const sh = match.home.sets ?? (hs > as ? 2 : 0); const sa = match.away.sets ?? (as > hs ? 2 : 0);
    const g1 = sets.reduce((s, x) => s + x[0], 0); const g2 = sets.reduce((s, x) => s + x[1], 0);
    switch (marketKey) {
      case 'ml': return ok(selKey === 'home' ? sh > sa : sa > sh);
      case 'straight': return ok(selKey === 'home' ? sh > sa && sa === 0 : sa > sh && sh === 0);
      case 'oneset': return ok(selKey === 'home' ? sh > 0 : sa > 0);
      case 'bothsets': return ok(selKey === 'yes' ? sh > 0 && sa > 0 : !(sh > 0 && sa > 0));
      case 'gspread': { if (!sets.length) return 'void'; const v = selKey === 'home' ? g1 - g2 + line : g2 - g1 - line; return v === 0 ? 'void' : ok(v > 0); }
      default:
        if (marketKey.startsWith('gtotal')) return sets.length ? overUnder(g1 + g2, line, selKey) : 'void';
        return null;
    }
  }
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  const total = hs + as;
  switch (marketKey) {
    case 'ml': return ok(selKey === 'home' ? hs > as : as > hs);
    case '1x2': return ok(selKey === 'home' ? hs > as : selKey === 'away' ? as > hs : hs === as);
    case 'dc': return ok(selKey === '1x' ? hs >= as : selKey === 'x2' ? as >= hs : hs !== as);
    case 'btts': return ok(selKey === 'yes' ? hs > 0 && as > 0 : !(hs > 0 && as > 0));
    case 'spread': case 'ah': {
      // `line` is the HOME handicap; the away side carries the opposite line.
      const v = selKey === 'home' ? hs - as + line : as - hs - line;
      return v === 0 ? 'void' : ok(v > 0);
    }
    case 'scorer': {
      // selKey = "<side>:<player-slug>"; needs the provider's scorer list.
      const sc = match.scorers; if (!sc) return 'void';
      const [side, ...rest] = selKey.split(':'); const want = rest.join(':');
      const list = Array.isArray(sc) ? sc : (sc[side] || []);
      const slugOf = (n) => norm(n).replace(/ /g, '-');
      return ok(list.some((n) => slugOf(n) === want || samePlayer(n, want.replace(/-/g, ' '))));
    }
    default:
      if (marketKey.startsWith('tth')) return overUnder(hs, line, selKey);
      if (marketKey.startsWith('tta')) return overUnder(as, line, selKey);
      if (marketKey.startsWith('yc')) {
        const c = match.cards; if (!c || !Number.isFinite(c.home) || !Number.isFinite(c.away)) return 'void';
        return overUnder(c.home + c.away, line, selKey);
      }
      if (marketKey.startsWith('pl:')) {
        // player points (NBA) / goals (handball): void when the player has no stat line
        const [, , pslug] = marketKey.split(':');
        const stats = match.playerPoints || match.playerGoals; if (!stats) return 'void';
        const name = Object.keys(stats).find((n) => norm(n).replace(/ /g, '-') === pslug || samePlayer(n, pslug.replace(/-/g, ' ')));
        return name ? overUnder(Number(stats[name]), line, selKey) : 'void';
      }
      if (marketKey === 'total' || marketKey.startsWith('ou') || marketKey.startsWith('total')) return overUnder(total, line, selKey);
      return null;
  }
}
