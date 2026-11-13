// JSON-file persistence. The whole DB lives in data/db.json and is written
// atomically (write to temp file, then rename) with a short debounce.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('store');

const DEFAULTS = () => ({
  version: 1,
  settings: {
    bankrollStart: 100000, // HUF
    currency: 'HUF',
    kellyFraction: config.staking.kellyFraction,
    kellyCap: config.staking.kellyCap,
    limits: {
      dailyStake: 10000,
      weeklyStake: 40000,
      dailyLoss: 8000,
      weeklyLoss: 25000,
      sessionReminderMin: 30,
    },
  },
  tips: [],        // model tips (auto-logged, auto-settled)
  bets: [],        // user's own bankroll entries
  manualOdds: {},  // matchId -> { selectionKey: odds }
  oddsHistory: {}, // matchId -> { selectionKey: [{t, odds, src}] }
  quotas: {},      // provider -> { day, used }
  seededHistory: false,
});

class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.data = DEFAULTS();
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        const d = DEFAULTS();
        this.data = { ...d, ...parsed, settings: { ...d.settings, ...parsed.settings, limits: { ...d.settings.limits, ...(parsed.settings?.limits || {}) } } };
      }
    } catch (err) {
      // A corrupt file must not stop the app: keep a backup and start fresh.
      log.error('db load failed, starting with empty store', { err });
      try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
      this.data = DEFAULTS();
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error('db write failed', { err });
    }
  }
}

export const store = new Store(path.join(config.dataDir, 'db.json'));
export const db = () => store.data;
