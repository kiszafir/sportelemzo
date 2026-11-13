// Provider registry: one place to list, enable/disable and inspect data sources.
import { espn } from './espn.js';
import { oddsApi } from './oddsapi.js';
import { apiSports } from './apisports.js';
import { footballData } from './footballdata.js';
import { weather } from './weather.js';
import { mockProvider } from './mock.js';

export const providers = { espn, oddsapi: oddsApi, apisports: apiSports, footballdata: footballData, weather };

export function providerStatuses() {
  return [
    ...Object.values(providers).map((p) => p.status()),
    { id: 'mock', name: mockProvider.name, kinds: mockProvider.kind, enabled: true, requiresKey: false, reason: null, terms: 'Beépített szimuláció, valós eseményekkel nem egyezik.', freeTier: '—' },
  ];
}
