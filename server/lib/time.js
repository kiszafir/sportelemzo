// Time helpers bound to the display time zone (Europe/Budapest by default).
import { config } from '../config.js';

const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const wdFmt = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short' });
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** 'YYYY-MM-DD' of a timestamp in the display time zone. */
export const localDay = (t = Date.now()) => dayFmt.format(new Date(t));

/** 'YYYY-MM-DD' of the Monday that starts the local week. */
export function localWeekStart(t = Date.now()) {
  const wd = WD[wdFmt.format(new Date(t))];
  return localDay(t - wd * 24 * 3600e3);
}

export function dayOffset(t, base = Date.now()) {
  const d = (s) => Date.UTC(...s.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  return Math.round((d(localDay(t)) - d(localDay(base))) / (24 * 3600e3));
}
