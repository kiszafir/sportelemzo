// The Odds API (https://the-odds-api.com) — optional, needs THE_ODDS_API_KEY.
// Free tier: 500 credits / month; a request costs (#markets × #regions) credits.
// Defaults are frugal: h2h only, EU region, each league refreshed at most every
// ODDS_API_TTL_HOURS (12 h), hard daily credit cap ODDS_API_DAILY_CREDITS (15).
import { Provider } from './base.js';
import { getJson, registerLimit } from '../lib/http.js';
import { cache } from '../lib/cache.js';

const BASE = 'https://api.the-odds-api.com/v4';
const MARKETS = (process.env.ODDS_API_MARKETS || 'h2h').split(',').map((s) => s.trim()).filter(Boolean);
const TTL = Number(process.env.ODDS_API_TTL_HOURS || 12) * 3600e3;
registerLimit('oddsapi', { minIntervalMs: 1100, dailyQuota: Number(process.env.ODDS_API_DAILY_CREDITS || 15) });

class OddsApiProvider extends Provider {
  constructor() {
    super({ id: 'oddsapi', name: 'The Odds API', kinds: ['odds'], requiresKey: true, keyName: 'theOddsApi', homepage: 'https://the-odds-api.com',
      terms: 'Ingyenes csomag: havi 500 kredit. Az adatok a felhasználási feltételek szerint használhatók.', freeTier: '500 kredit/hó' });
  }

  /** Active sports list. The /sports endpoint costs no credits; cached 24 h. */
  async activeSports() {
    const res = await cache.wrap('oddsapi:sports', 24 * 3600e3, () => getJson('oddsapi', `${BASE}/sports?apiKey=${this.key}`, { retries: 1 }));
    return (res.value || []).filter((s) => s.active);
  }

  /**
   * Sport keys for a league: tennis = every active tournament of the tour;
   * leagues with a known key = that key if active; handball = discovered by
   * matching words of the title/description (keys are not hard-coded).
   */
  async keysFor(league) {
    let active = null;
    try { active = await this.activeSports(); } catch { active = null; }
    if (league.sport === 'tennis') return (active || []).filter((s) => s.key.startsWith(`tennis_${league.id}`)).map((s) => s.key);
    if (league.odds) return !active || active.some((s) => s.key === league.odds) ? [league.odds] : [];
    if (league.oddsMatch && active) {
      const prefix = league.sport === 'handball' ? 'handball_' : 'soccer_';
      const hit = active.filter((s) => s.key.startsWith(prefix)).find((s) => {
        const text = `${s.key} ${s.title} ${s.description}`.toLowerCase().replace(/_/g, ' ');
        return league.oddsMatch.every((w) => text.includes(w)) && /women/.test(text) === !!league.hb?.women;
      });
      return hit ? [hit.key] : [];
    }
    return [];
  }

  /** Returns OddsEvent[]: { home, away, commence, books: [{book, markets:{h2h:{name:price}, totals:{point, over, under}}}] } */
  async odds(league) {
    const keys = await this.keysFor(league);
    if (!keys.length) return null;
    const out = []; let fetchedAt = Date.now(); let status = 'live';
    for (const key of keys.slice(0, 3)) {
      const url = `${BASE}/sports/${key}/odds?apiKey=${this.key}&regions=eu&markets=${MARKETS.join(',')}&oddsFormat=decimal&dateFormat=iso`;
      try {
        const res = await cache.wrap(`oddsapi:${key}`, TTL, () => getJson('oddsapi', url, { retries: 1 }));
        fetchedAt = res.fetchedAt; if (res.status === 'cached') status = 'cached';
        for (const ev of res.value || []) {
          out.push({
            home: ev.home_team, away: ev.away_team, commence: ev.commence_time,
            books: (ev.bookmakers || []).map((b) => ({
              book: b.title, t: Date.parse(b.last_update) || fetchedAt,
              h2h: Object.fromEntries((b.markets.find((m) => m.key === 'h2h')?.outcomes || []).map((o) => [o.name, o.price])),
              totals: (b.markets.find((m) => m.key === 'totals')?.outcomes || []).reduce((acc, o) => { acc.point = o.point; acc[o.name.toLowerCase()] = o.price; return acc; }, {}),
            })),
          });
        }
        this.ok();
      } catch (err) { this.fail(err); if (!out.length) throw err; }
    }
    return { events: out, status, fetchedAt };
  }
}

export const oddsApi = new OddsApiProvider();
