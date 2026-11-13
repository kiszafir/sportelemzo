// Hungarian formatting helpers, HTML escaping and shared UI fragments.
export const TZ = 'Europe/Budapest';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fTime = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fTimeS = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fDate = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, month: 'short', day: 'numeric', weekday: 'short' });
const fDateFull = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fDay = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ });

export const time = (t) => fTime.format(new Date(t));
export const timeS = (t) => fTimeS.format(new Date(t));
export const date = (t) => fDate.format(new Date(t));
export const dateFull = (t) => fDateFull.format(new Date(t));
export const dayKey = (t) => fDay.format(new Date(t));
export const todayKey = () => dayKey(Date.now());

export function relDay(t) {
  const d = (k) => Date.UTC(...k.split('-').map((x, i) => (i === 1 ? x - 1 : +x)));
  const off = Math.round((d(dayKey(t)) - d(todayKey())) / 864e5);
  return off === 0 ? 'ma' : off === 1 ? 'holnap' : off === -1 ? 'tegnap' : date(t);
}

const nf = (d) => new Intl.NumberFormat('hu-HU', { minimumFractionDigits: d, maximumFractionDigits: d });
export const num = (x, d = 2) => (Number.isFinite(+x) && x !== null ? nf(d).format(+x) : '–');
export const odds = (x) => num(x, 2);
export const pct = (x, d = 1) => (Number.isFinite(+x) && x !== null ? nf(d).format(x * 100) + '%' : '–');
export const signedPct = (x, d = 1) => (Number.isFinite(+x) && x !== null ? (x > 0 ? '+' : '') + nf(d).format(x * 100) + '%' : '–');
export const huf = (x) => (Number.isFinite(+x) ? new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(x) + ' Ft' : '–');
export const evClass = (x) => (x > 0.005 ? 'ev-pos' : x < -0.005 ? 'ev-neg' : '');

export function ago(t) {
  if (!t) return '–';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} mp`;
  const m = Math.round(s / 60); if (m < 60) return `${m} perce`;
  const h = Math.round(m / 60); if (h < 48) return `${h} órája`;
  return `${Math.round(h / 24)} napja`;
}

/** Data freshness badge: LIVE / CACHED (age) / MOCK, plus estimated & manual odds. */
export function badge(status, fetchedAt) {
  switch (status) {
    case 'live': return `<span class="badge b-live" title="Élő adat a szolgáltatótól${fetchedAt ? ', ' + timeS(fetchedAt) : ''}">ÉLŐ</span>`;
    case 'cached': return `<span class="badge b-cached" title="Gyorsítótárból (a szolgáltató most nem frissült)">GYORSÍTÓTÁR · ${esc(ago(fetchedAt))}</span>`;
    case 'mock': return '<span class="badge b-mock" title="Szimulált mintaadat – nem valós esemény vagy szorzó">MINTA</span>';
    case 'estimated': return '<span class="badge b-est" title="Nincs piaci szorzó: a modell méltányos szorzójából 6% árréssel becsülve">BECSÜLT</span>';
    case 'manual': return '<span class="badge b-manual" title="Általad megadott szorzó">KÉZI</span>';
    default: return '<span class="badge b-na" title="Nincs adat">N/A</span>';
  }
}

export function statusPill(m) {
  if (m.status === 'live') return `<span class="status st-live">ÉLŐ</span>`;
  if (m.status === 'post') return `<span class="status st-post">Befejezett</span>`;
  return `<span class="status st-pre">Közelgő</span>`;
}

export const SPORT_HU = { nba: 'NBA', nhl: 'NHL', tennis: 'Tenisz', football: 'Labdarúgás', handball: 'Kézilabda' };
export const SPORT_LONG = { nba: 'Kosárlabda – NBA', nhl: 'Jégkorong – NHL', tennis: 'Tenisz – ATP/WTA', football: 'Labdarúgás', handball: 'Kézilabda' };
export const RESULT_HU = { won: 'nyert', lost: 'veszített', void: 'érvénytelen', pending: 'függőben' };
export const RISK_HU = { alacsony: 'Alacsony kockázat', közepes: 'Közepes kockázat', magas: 'Magas kockázat' };

export function conf(v) {
  if (v == null) return '<div class="conf" style="--v:0" aria-label="Nincs bizalmi pontszám"><span>–</span></div>';
  return `<div class="conf" style="--v:${v}" role="img" aria-label="Bizalmi pontszám: ${v} / 100" title="Bizalmi pontszám (1–100)"><span>${v}</span></div>`;
}

/** Model probability split bar for a market; the tick marks the vig-free market view of the first outcome. */
export function pbar(main, m) {
  if (!main) return '<div class="pbar"></div>';
  const sel = main.selections;
  const cls = sel.length === 3 ? ['s-home', 's-draw', 's-away'] : ['s-home', 's-away'];
  const segs = sel.map((s, i) => `<div class="pbar-seg ${cls[i]}" style="flex-basis:${(s.p * 100).toFixed(2)}%"></div>`).join('');
  const nv = sel[0].novig;
  const tick = nv != null ? `<div class="pbar-tick" style="left:calc(${(nv * 100).toFixed(2)}% - 1px)" title="Piac (árrés nélkül): ${pct(nv)}"></div>` : '';
  const legend = sel.map((s) => `<span><span class="lbl">${esc(s.label)}</span> <span class="num">${pct(s.p, 0)}</span></span>`).join('');
  const aria = sel.map((s) => `${s.label}: ${pct(s.p, 0)}`).join(', ');
  return `<div class="pbar" role="img" aria-label="Modellvalószínűség – ${esc(main.label)}: ${esc(aria)}${nv != null ? '; piaci vonás: ' + pct(nv, 0) : ''}">
    <div class="pbar-track">${segs}${tick}</div>
    <div class="pbar-legend">${legend}</div></div>`;
}
