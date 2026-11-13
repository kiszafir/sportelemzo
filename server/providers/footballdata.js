// football-data.org — optional, needs FOOTBALL_DATA_KEY.
// Free tier: 10 requests/minute, major competitions (PL, PD, SA, BL1, FL1, CL).
// Used for standings: position, points per game, goals for/against, recent form.
import { Provider } from './base.js';
import { getJson, registerLimit } from '../lib/http.js';
import { cache } from '../lib/cache.js';

registerLimit('footballdata', { minIntervalMs: 6500 });

class FootballDataProvider extends Provider {
  constructor() {
    super({ id: 'footballdata', name: 'football-data.org', kinds: ['standings'], requiresKey: true, keyName: 'footballData', homepage: 'https://www.football-data.org',
      terms: 'Ingyenes csomag: 10 kérés/perc, a fő bajnokságok. Nem kereskedelmi célra.', freeTier: '10 kérés/perc' });
  }

  async standings(league) {
    if (!league.fd) return null;
    try {
      const res = await cache.wrap(`fd:st:${league.id}`, 6 * 3600e3, () => getJson('footballdata', `https://api.football-data.org/v4/competitions/${league.fd}/standings`, { headers: { 'X-Auth-Token': this.key }, retries: 1 }));
      this.ok();
      const table = (res.value?.standings || []).find((s) => s.type === 'TOTAL')?.table || res.value?.standings?.[0]?.table || [];
      const teams = {};
      for (const r of table) {
        const gp = r.playedGames; if (!gp) continue;
        // football-data form: "W,D,L,W,W" (most recent first)
        const form = typeof r.form === 'string' ? r.form.split(',').filter(Boolean).reverse() : undefined;
        teams[r.team?.name] = { gamesPlayed: gp, position: r.position, ppg: r.points / gp, gfPg: r.goalsFor / gp, gaPg: r.goalsAgainst / gp, winPct: r.won / gp, form, aliases: [r.team?.shortName, r.team?.tla] };
      }
      return { teams, status: res.status, fetchedAt: res.fetchedAt, leagueSize: table.length };
    } catch (err) { this.fail(err); throw err; }
  }
}

export const footballData = new FootballDataProvider();
