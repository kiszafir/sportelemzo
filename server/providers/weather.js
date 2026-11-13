// Open-Meteo (https://open-meteo.com) — keyless, free for non-commercial use.
// Geocodes the venue city (cached 30 days) and reads the hourly forecast near kick-off.
import { Provider } from './base.js';
import { getJson, registerLimit } from '../lib/http.js';
import { cache } from '../lib/cache.js';

registerLimit('weather', { minIntervalMs: 150, dailyQuota: 2000, concurrency: 3 });

const describe = (precip, wind) => (precip > 3 ? 'eső' : precip > 0.2 ? 'gyenge csapadék' : wind > 30 ? 'erős szél' : 'száraz');

class WeatherProvider extends Provider {
  constructor() {
    super({ id: 'weather', name: 'Open-Meteo (időjárás)', kinds: ['weather'], homepage: 'https://open-meteo.com',
      terms: 'Kulcs nélkül, nem kereskedelmi használatra ingyenes (CC BY 4.0).', freeTier: 'Kulcs nélkül' });
  }

  async weather(match) {
    const city = match.venue?.city; if (!city || match.venue?.indoor) return null;
    const start = Date.parse(match.startTime);
    if (start - Date.now() > 3 * 24 * 3600e3 || Date.now() - start > 3 * 3600e3) return null;
    try {
      const geo = await cache.wrap(`wx:geo:${city}`, 30 * 24 * 3600e3, () => getJson('weather', `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`, { retries: 1 }));
      const g = geo.value?.results?.[0]; if (!g) return null;
      const fc = await cache.wrap(`wx:fc:${g.latitude.toFixed(2)},${g.longitude.toFixed(2)}`, 3 * 3600e3, () => getJson('weather',
        `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&hourly=temperature_2m,precipitation,wind_speed_10m&timezone=UTC&forecast_days=4`, { retries: 1 }));
      const h = fc.value?.hourly; if (!h?.time) return null;
      let best = 0, bestD = Infinity;
      h.time.forEach((t, i) => { const d = Math.abs(Date.parse(t + 'Z') - start); if (d < bestD) { bestD = d; best = i; } });
      this.ok();
      return { tempC: h.temperature_2m[best], windKmh: h.wind_speed_10m[best], precipMm: h.precipitation[best], desc: describe(h.precipitation[best], h.wind_speed_10m[best]),
        altitude: g.elevation, status: fc.status, fetchedAt: fc.fetchedAt, src: 'Open-Meteo' };
    } catch (err) { this.fail(err); return null; }
  }
}

export const weather = new WeatherProvider();
