// Two-level cache: in-memory Map backed by data/cache.json so cached data
// survives a restart (and can be shown as CACHED with its age when a provider is down).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');
const FILE = path.join(config.dataDir, 'cache.json');
const MAX_FILE_AGE_MS = 3 * 24 * 3600 * 1000;
export const LIVE_WINDOW_MS = 120 * 1000;

const mem = new Map();
const inflight = new Map();
let timer = null;

(function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) if (now - v.fetchedAt < MAX_FILE_AGE_MS) mem.set(k, v);
  } catch (err) {
    log.warn('cache file unreadable, ignoring', { err });
  }
})();

function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(Object.fromEntries(mem)));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (err) { log.warn('cache persist failed', { err }); }
  }, 1000);
}

export const cache = {
  get(key) { return mem.get(key) || null; },
  set(key, value, meta = {}) {
    const entry = { value, fetchedAt: Date.now(), ...meta };
    mem.set(key, entry);
    persist();
    return entry;
  },
  age(key) { const e = mem.get(key); return e ? Date.now() - e.fetchedAt : Infinity; },

  /**
   * Return a fresh value if younger than ttl, otherwise call fn().
   * On failure, return the stale value marked as cached.
   * @returns {{value:any, status:'live'|'cached', fetchedAt:number}|null}
   */
  async wrap(key, ttlMs, fn) {
    const hit = mem.get(key);
    if (hit && Date.now() - hit.fetchedAt < ttlMs) {
      // Data younger than LIVE_WINDOW counts as live; older (but within TTL) is shown as cached with its age.
      const age = Date.now() - hit.fetchedAt;
      return { value: hit.value, status: age < LIVE_WINDOW_MS ? 'live' : 'cached', fetchedAt: hit.fetchedAt };
    }
    try {
      // De-duplicate concurrent fetches of the same key (e.g. several leagues
      // sharing one daily handball request).
      let p = inflight.get(key);
      if (!p) { p = Promise.resolve().then(fn).finally(() => inflight.delete(key)); inflight.set(key, p); }
      const value = await p;
      const e = mem.get(key)?.value === value ? mem.get(key) : this.set(key, value);
      return { value, status: 'live', fetchedAt: e.fetchedAt };
    } catch (err) {
      if (hit) {
        log.warn('provider failed, serving stale cache', { key, ageS: Math.round((Date.now() - hit.fetchedAt) / 1000), err });
        return { value: hit.value, status: 'cached', fetchedAt: hit.fetchedAt, error: err.message };
      }
      throw err;
    }
  },
};
