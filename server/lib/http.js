// HTTP client with per-provider rate limiting, daily quotas, exponential backoff
// and a circuit breaker, so a dead or throttled provider never blocks the app.
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { db, store } from '../store.js';

const log = createLogger('http');

const limits = new Map(); // provider -> { minIntervalMs, dailyQuota, concurrency }
const state = new Map();  // provider -> { last, failures, openUntil, queue }

export function registerLimit(provider, { minIntervalMs = 500, dailyQuota = Infinity, concurrency = 1 } = {}) {
  limits.set(provider, { minIntervalMs, dailyQuota, concurrency });
}

function st(provider) {
  if (!state.has(provider)) state.set(provider, { nextStart: 0, failures: 0, openUntil: 0, active: 0, waiters: [] });
  return state.get(provider);
}

const today = () => new Date().toISOString().slice(0, 10);

function quotaLeft(provider) {
  const lim = limits.get(provider);
  if (!lim || lim.dailyQuota === Infinity) return Infinity;
  const q = db().quotas[provider];
  if (!q || q.day !== today()) return lim.dailyQuota;
  return lim.dailyQuota - q.used;
}

function useQuota(provider) {
  const q = db().quotas[provider];
  if (!q || q.day !== today()) db().quotas[provider] = { day: today(), used: 1 };
  else q.used += 1;
  store.save();
}

export function providerHealth(provider) {
  const s = st(provider);
  return {
    failures: s.failures,
    circuitOpen: Date.now() < s.openUntil,
    openUntil: s.openUntil || null,
    quotaLeft: quotaLeft(provider),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * GET JSON with rate limiting, retries (429/5xx/network) and a circuit breaker.
 */
export async function getJson(provider, url, { headers = {}, retries = 2, timeoutMs = config.httpTimeoutMs } = {}) {
  if (config.dataMode === 'mock') throw new HttpError('mock mode: network disabled', 0);
  const s = st(provider);
  if (Date.now() < s.openUntil) throw new HttpError(`${provider}: circuit open`, 0);
  if (quotaLeft(provider) <= 0) throw new HttpError(`${provider}: daily quota exhausted`, 429);

  // Per-provider limiter: at most `concurrency` requests in flight, and request
  // starts spaced at least `minIntervalMs` apart (reservation based).
  const lim = limits.get(provider) || { minIntervalMs: 300, concurrency: 1 };
  while (s.active >= (lim.concurrency || 1)) await new Promise((r) => s.waiters.push(r));
  s.active++;
  try {
    if (Date.now() < s.openUntil) throw new HttpError(`${provider}: circuit open`, 0);
    const startAt = Math.max(Date.now(), s.nextStart);
    s.nextStart = startAt + lim.minIntervalMs;
    if (startAt > Date.now()) await sleep(startAt - Date.now());
    return await attemptLoop();
  } finally {
    s.active--;
    s.waiters.shift()?.();
  }

  async function attemptLoop() {
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        useQuota(provider);
        const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'sportelemzo/1.0 (local)', ...headers }, signal: ctrl.signal });
        clearTimeout(to);
        if (res.status === 429 || res.status >= 500) throw new HttpError(`HTTP ${res.status}`, res.status);
        if (!res.ok) { const e = new HttpError(`HTTP ${res.status}`, res.status); e.fatal = true; throw e; }
        const json = await res.json();
        s.failures = 0;
        return json;
      } catch (err) {
        clearTimeout(to);
        attempt += 1;
        // DNS / connection refused: the host is unreachable, retrying will not help.
        const code = err.cause?.code || err.code;
        if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(code) || err.message === 'fetch failed') err.fatal = true;
        if (err.fatal || attempt > retries) {
          // A 4xx (except 429) means this particular request is wrong, not that the
          // provider is down, so it must not switch the whole provider off.
          const clientError = err.status >= 400 && err.status < 500 && err.status !== 429;
          if (!clientError) s.failures += 1;
          if (s.failures >= 3) {
            s.openUntil = Date.now() + 5 * 60 * 1000;
            log.warn('circuit opened', { provider, minutes: 5 });
          }
          log.warn('request failed', { provider, url: redact(url), status: err.status, err });
          throw err;
        }
        const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        log.debug('retrying', { provider, attempt, backoff });
        await sleep(backoff);
      }
    }
  }
}

// Never log API keys.
export const redact = (url) => String(url).replace(/(apiKey|api_key|key|token)=[^&]+/gi, '$1=***');
