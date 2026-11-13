// Provider adapter interface. Each data source implements a subset of:
//   fixtures(league)  -> Match[]           (normalised match objects)
//   standings(league) -> { teamKey: stats } (season stats per team)
//   odds(league)      -> OddsEvent[]       (bookmaker prices)
//   injuries(league)  -> { teamKey: Injury[] }
//   weather(match)    -> { tempC, windKmh, precipMm, desc } | null
// Providers can be disabled independently (env PROVIDER_<ID>=off) and are
// automatically disabled when their (optional) key is missing.
import { config } from '../config.js';
import { providerHealth } from '../lib/http.js';

export class Provider {
  constructor({ id, name, kinds, requiresKey = false, keyName = null, homepage, terms, freeTier }) {
    Object.assign(this, { id, name, kinds, requiresKey, keyName, homepage, terms, freeTier });
    this.lastOk = null; this.lastError = null;
  }

  get key() { return this.keyName ? config.keys[this.keyName] : ''; }

  enabled() {
    if (config.dataMode === 'mock') return false;
    if (config.providers[this.id] === false) return false;
    if (this.requiresKey && !this.key) return false;
    return true;
  }

  disabledReason() {
    if (config.dataMode === 'mock') return 'Mintaadat-mód: hálózat kikapcsolva';
    if (config.providers[this.id] === false) return 'Kikapcsolva a beállításokban';
    if (this.requiresKey && !this.key) return 'Nincs megadva API-kulcs';
    return null;
  }

  ok() { this.lastOk = Date.now(); this.lastError = null; }
  fail(err) { this.lastError = { at: Date.now(), message: err.message }; }

  status() {
    return {
      id: this.id, name: this.name, kinds: this.kinds, requiresKey: this.requiresKey,
      enabled: this.enabled(), reason: this.disabledReason(), homepage: this.homepage, terms: this.terms, freeTier: this.freeTier,
      lastOk: this.lastOk, lastError: this.lastError, health: providerHealth(this.id),
    };
  }
}

/** Normalise a team/player name for cross-provider matching. */
export function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(fc|cf|afc|sc|ac|as|ssc|cd|rc|ud|sd|fk|sk|bk|club|calcio|de|the|1\.)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Token-overlap similarity 0..1 between two names. */
export function nameSimilarity(a, b) {
  const A = new Set(normName(a).split(' ').filter(Boolean)); const B = new Set(normName(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((x) => B.has(x)).length;
  if (normName(a) === normName(b)) return 1;
  return inter / Math.min(A.size, B.size) * 0.9;
}
