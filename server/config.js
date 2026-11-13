// Central configuration. Values come from environment variables or an optional
// .env file in the project root. Keys are NEVER hardcoded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency). Existing env vars win over the file.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on|igen)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const argv = process.argv.slice(2);

// DATA_MODE: auto = try live providers, fall back to mock per league
//            mock = never touch the network
//            live = live only (still degrades to cached/mock if everything fails)
let dataMode = (env.DATA_MODE || 'auto').toLowerCase();
if (argv.includes('--mock') || bool(env.MOCK_MODE, false)) dataMode = 'mock';

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  dataMode,
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  timezone: env.TZ_DISPLAY || 'Europe/Budapest',
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),

  keys: {
    theOddsApi: env.THE_ODDS_API_KEY || '',
    apiSports: env.API_SPORTS_KEY || '',
    footballData: env.FOOTBALL_DATA_KEY || '',
  },

  // Individual providers can be switched off without touching code.
  providers: {
    espn: bool(env.PROVIDER_ESPN, true),
    oddsapi: bool(env.PROVIDER_ODDSAPI, true),
    apisports: bool(env.PROVIDER_APISPORTS, true),
    footballdata: bool(env.PROVIDER_FOOTBALLDATA, true),
    weather: bool(env.PROVIDER_WEATHER, true),
  },

  // Refresh cadence (seconds).
  refresh: {
    live: num(env.REFRESH_LIVE_SECONDS, 45),       // live matches
    fixtures: num(env.REFRESH_FIXTURES_SECONDS, 600), // schedules/standings
    odds: num(env.REFRESH_ODDS_SECONDS, 1800),     // odds (protects free quotas)
  },

  // Staking defaults (user can change in UI; server enforces caps too).
  staking: {
    kellyFraction: num(env.KELLY_FRACTION, 0.25),
    kellyCap: num(env.KELLY_CAP, 0.05), // max 5% of bankroll per bet
  },

  httpTimeoutMs: num(env.HTTP_TIMEOUT_MS, 8000),
};

export const LEAGUES = [
  { id: 'nba', sport: 'nba', name: 'NBA', short: 'NBA', espn: 'basketball/nba', odds: 'basketball_nba' },
  { id: 'nhl', sport: 'nhl', name: 'NHL', short: 'NHL', espn: 'hockey/nhl', odds: 'icehockey_nhl' },
  { id: 'atp', sport: 'tennis', name: 'ATP', short: 'ATP', espn: 'tennis/atp', odds: 'tennis_atp' },
  { id: 'wta', sport: 'tennis', name: 'WTA', short: 'WTA', espn: 'tennis/wta', odds: 'tennis_wta' },
  { id: 'epl', sport: 'football', name: 'Premier League', short: 'PL', espn: 'soccer/eng.1', odds: 'soccer_epl', fd: 'PL', as: 39 },
  { id: 'laliga', sport: 'football', name: 'La Liga', short: 'LaLiga', espn: 'soccer/esp.1', odds: 'soccer_spain_la_liga', fd: 'PD', as: 140 },
  { id: 'seriea', sport: 'football', name: 'Serie A', short: 'Serie A', espn: 'soccer/ita.1', odds: 'soccer_italy_serie_a', fd: 'SA', as: 135 },
  { id: 'bundesliga', sport: 'football', name: 'Bundesliga', short: 'BL', espn: 'soccer/ger.1', odds: 'soccer_germany_bundesliga', fd: 'BL1', as: 78 },
  { id: 'ligue1', sport: 'football', name: 'Ligue 1', short: 'L1', espn: 'soccer/fra.1', odds: 'soccer_france_ligue_one', fd: 'FL1', as: 61 },
  { id: 'ucl', sport: 'football', name: 'Bajnokok Ligája', short: 'BL', espn: 'soccer/uefa.champions', odds: 'soccer_uefa_champs_league', fd: 'CL', as: 2 },
  { id: 'uel', sport: 'football', name: 'Európa-liga', short: 'EL', espn: 'soccer/uefa.europa', odds: 'soccer_uefa_europa_league', as: 3 },
  { id: 'uecl', sport: 'football', name: 'Konferencia-liga', short: 'KL', espn: 'soccer/uefa.europa.conf', odds: 'soccer_uefa_europa_conference_league', as: 848 },
  { id: 'eredivisie', sport: 'football', name: 'Eredivisie', short: 'ERE', espn: 'soccer/ned.1', odds: 'soccer_netherlands_eredivisie', fd: 'DED', as: 88 },
  { id: 'primeira', sport: 'football', name: 'Primeira Liga', short: 'POR', espn: 'soccer/por.1', odds: 'soccer_portugal_primeira_liga', fd: 'PPL', as: 94 },
  { id: 'championship', sport: 'football', name: 'Championship', short: 'ELC', espn: 'soccer/eng.2', odds: 'soccer_efl_champ', fd: 'ELC', as: 40 },
  { id: 'superlig', sport: 'football', name: 'Süper Lig', short: 'TUR', espn: 'soccer/tur.1', odds: 'soccer_turkey_super_league', as: 203 },
  { id: 'belgium', sport: 'football', name: 'Jupiler Pro League', short: 'BEL', espn: 'soccer/bel.1', odds: 'soccer_belgium_first_div', as: 144 },
  { id: 'scotland', sport: 'football', name: 'Skót Premiership', short: 'SCO', espn: 'soccer/sco.1', odds: 'soccer_spl', as: 179 },
  { id: 'mls', sport: 'football', name: 'MLS', short: 'MLS', espn: 'soccer/usa.1', odds: 'soccer_usa_mls', as: 253 },
  // ESPN does not cover NB I: fixtures come from API-Football (API_SPORTS_KEY), otherwise mock data.
  { id: 'nbi', sport: 'football', name: 'NB I', short: 'NB I', espn: null, odds: null, as: 271 },
  // Handball: ESPN has none. API-Handball (same API_SPORTS_KEY, separate daily quota);
  // leagues are resolved by country + name at runtime. Odds keys are discovered from The Odds API.
  { id: 'ehfcl', sport: 'handball', name: 'EHF Bajnokok Ligája', short: 'EHF BL', espn: null, hb: { country: 'Europe', name: 'EHF Champions League', women: false }, oddsMatch: ['champions league'] },
  { id: 'ehfclw', sport: 'handball', name: 'Női EHF Bajnokok Ligája', short: 'Női BL', espn: null, hb: { country: 'Europe', name: 'EHF Champions League', women: true }, oddsMatch: ['champions league women'] },
  { id: 'hbnbi', sport: 'handball', name: 'Férfi NB I', short: 'NB I', espn: null, hb: { country: 'Hungary', name: 'NB I', women: false }, oddsMatch: ['hungary', 'nb i'] },
  { id: 'hbnbiw', sport: 'handball', name: 'Női NB I', short: 'Női NB I', espn: null, hb: { country: 'Hungary', name: 'NB I', women: true }, oddsMatch: ['hungary', 'women'] },
  { id: 'hbl', sport: 'handball', name: 'Handball-Bundesliga', short: 'HBL', espn: null, hb: { country: 'Germany', name: 'Bundesliga', women: false }, oddsMatch: ['germany', 'bundesliga'] },
];

export const SPORTS = {
  nba: { id: 'nba', name: 'NBA', label: 'Kosárlabda' },
  nhl: { id: 'nhl', name: 'NHL', label: 'Jégkorong' },
  tennis: { id: 'tennis', name: 'Tenisz', label: 'Tenisz' },
  football: { id: 'football', name: 'Labdarúgás', label: 'Labdarúgás' },
  handball: { id: 'handball', name: 'Kézilabda', label: 'Kézilabda' },
};

export const leagueById = (id) => LEAGUES.find((l) => l.id === id);
