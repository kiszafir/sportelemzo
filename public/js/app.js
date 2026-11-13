// App shell: navigation, hash router, theme, age gate, session reminder,
// live updates (Server-Sent Events with polling fallback), toasts and modals.
import { api } from './api.js';
import { ICON } from './icons.js';
import { esc } from './format.js';
import * as hub from './views/hub.js';
import * as match from './views/match.js';
import * as mixes from './views/mixes.js';
import * as stats from './views/stats.js';
import * as bankroll from './views/bankroll.js';
import * as rg from './views/rg.js';
import * as method from './views/method.js';
import * as sources from './views/sources.js';
import * as aiView from './views/ai.js';

const NAV = [
  { href: '#/', label: 'Elemzés', icon: 'hub', view: hub, mobile: true },
  { href: '#/konnyu', label: 'Könnyű mix', icon: 'easy', view: mixes, args: { mode: 'easy' }, cls: 'nav-easy', mobile: true, short: 'Könnyű' },
  { href: '#/brutalis', label: 'Brutális mix', icon: 'brutal', view: mixes, args: { mode: 'brutal' }, cls: 'nav-brutal', mobile: true, short: 'Brutális' },
  { href: '#/statisztika', label: 'Statisztika', icon: 'stats', view: stats, mobile: true },
  { href: '#/ai-motor', label: 'AI-motor', icon: 'ai', view: aiView },
  { sep: true },
  { href: '#/bankroll', label: 'Bankroll', icon: 'bank', view: bankroll },
  { href: '#/felelos-jatek', label: 'Felelős játék', icon: 'shield', view: rg },
  { href: '#/modszertan', label: 'Módszertan', icon: 'book', view: method },
  { href: '#/adatforrasok', label: 'Adatforrások', icon: 'plug', view: sources },
];

// ---------------------------------------------------------------------------
// Toasts & modal
// ---------------------------------------------------------------------------
export function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

export function modal(html, { onMount, dismissable = true, label = 'Párbeszédablak' } = {}) {
  const root = document.getElementById('modal-root');
  const prev = document.activeElement;
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div></div>`;
  const dlg = root.querySelector('.modal');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) close();
    if (e.key === 'Tab') { // focus trap
      const f = [...dlg.querySelectorAll('button, a[href], input, select, textarea')].filter((x) => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  onMount?.(dlg, close);
  (dlg.querySelector('[autofocus]') || dlg.querySelector('button'))?.focus();
  return close;
}

// ---------------------------------------------------------------------------
// Live updates: SSE, with polling fallback
// ---------------------------------------------------------------------------
export const live = { lastUpdate: null, version: 0, transport: 'SSE', listeners: new Set() };
const notify = () => { for (const fn of live.listeners) fn(live); };
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  live.transport = 'lekérdezés (45 mp)';
  pollTimer = setInterval(async () => {
    try {
      const h = await api('/api/health');
      if (h.lastUpdate !== live.lastUpdate) { live.lastUpdate = h.lastUpdate; live.version++; notify(); }
    } catch { /* server down: views show their own error state on next load */ }
  }, 45000);
  notify();
}

function startSSE() {
  if (!('EventSource' in window)) return startPolling();
  let errors = 0;
  const es = new EventSource('/api/stream');
  const onEvt = (e) => { errors = 0; try { const d = JSON.parse(e.data); if (d.lastUpdate) live.lastUpdate = d.lastUpdate; live.version++; notify(); } catch { /* ignore */ } };
  es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); live.lastUpdate = d.lastUpdate; live.transport = 'SSE'; notify(); });
  es.addEventListener('update', onEvt);
  es.addEventListener('match', onEvt);
  es.onerror = () => { errors++; if (errors >= 3) { es.close(); startPolling(); } };
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function renderThemeBtn() {
  const dark = currentTheme() === 'dark';
  document.getElementById('themeBtn').innerHTML = `${dark ? ICON.sun : ICON.moon} ${dark ? 'Világos mód' : 'Sötét mód'}`;
  const m = document.getElementById('themeBtnM');
  if (m) { m.innerHTML = dark ? ICON.sun : ICON.moon; m.setAttribute('aria-label', dark ? 'Világos mód' : 'Sötét mód'); }
}
const toggleTheme = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  renderThemeBtn();
};
document.getElementById('themeBtn').addEventListener('click', toggleTheme);
document.getElementById('themeBtnM')?.addEventListener('click', toggleTheme);

// ---------------------------------------------------------------------------
// Navigation & router
// ---------------------------------------------------------------------------
function routeFor(hash) {
  const h = hash || '#/';
  const m = h.match(/^#\/meccs\/(.+)$/);
  if (m) return { view: match, args: { id: decodeURIComponent(m[1]) }, href: '#/' };
  return NAV.find((n) => !n.sep && n.href === h) || NAV[0];
}

function renderNav(active) {
  document.getElementById('nav').innerHTML = NAV.map((n) => (n.sep ? '<div class="nav-sep" role="separator"></div>'
    : `<a href="${n.href}" class="${n.cls || ''}" ${n.href === active ? 'aria-current="page"' : ''}>${ICON[n.icon]}<span>${n.label}</span></a>`)).join('');
  const mob = NAV.filter((n) => n.mobile);
  const inMore = !mob.some((n) => n.href === active);
  document.getElementById('bottomnav').innerHTML = mob.map((n) => `<a href="${n.href}" ${n.href === active ? 'aria-current="page"' : ''}>${ICON[n.icon]}<span>${n.short || n.label}</span></a>`).join('')
    + `<button type="button" id="moreBtn" aria-haspopup="true" aria-expanded="false" ${inMore ? 'aria-current="page"' : ''}>${ICON.more}<span>Több</span></button>`;
  document.getElementById('moreBtn').onclick = (e) => {
    const open = document.querySelector('.more-sheet');
    if (open) { open.remove(); e.currentTarget.setAttribute('aria-expanded', 'false'); return; }
    const sheet = document.createElement('div');
    sheet.className = 'more-sheet';
    sheet.innerHTML = NAV.filter((n) => !n.sep && !n.mobile).map((n) => `<a href="${n.href}">${n.label}</a>`).join('') + '<a href="#" id="sheetTheme">Téma váltása</a>';
    document.body.append(sheet);
    e.currentTarget.setAttribute('aria-expanded', 'true');
    sheet.querySelector('#sheetTheme').onclick = (ev) => { ev.preventDefault(); toggleTheme(); sheet.remove(); };
    sheet.addEventListener('click', (ev) => { if (ev.target.tagName === 'A') sheet.remove(); });
  };
}

let cleanup = null;
async function router() {
  document.querySelector('.more-sheet')?.remove();
  const r = routeFor(location.hash);
  renderNav(r.href);
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  const el = document.getElementById('content');
  el.innerHTML = '';
  window.scrollTo(0, 0);
  cleanup = await r.view.render(el, r.args || {}, { toast, modal, live });
  const h1 = el.querySelector('h1');
  document.title = h1 ? `${h1.textContent} – Sportelemző` : 'Sportelemző';
  if (location.hash && location.hash !== '#/') el.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Meta: data mode banner
// ---------------------------------------------------------------------------
async function refreshMeta() {
  try {
    const meta = await api('/api/meta');
    const st = Object.values(meta.leagueStatus || {});
    const mockN = st.filter((s) => s.source === 'mock').length;
    const bar = document.getElementById('mockbar');
    if (meta.dataMode === 'mock') bar.innerHTML = '<div class="mockbar" role="status"><strong>Mintaadat-mód.</strong> Minden meccs, szorzó és eredmény szimulált (MINTA jelölés) – a hálózat ki van kapcsolva.</div>';
    else if (mockN) bar.innerHTML = `<div class="mockbar" role="status"><strong>${mockN} bajnokság mintaadatot mutat</strong>, mert az élő forrás nem érhető el. Ezek MINTA jelölést kapnak. <a href="#/adatforrasok">Részletek</a></div>`;
    else bar.innerHTML = '';
    document.getElementById('modeInfo').textContent = `Adatmód: ${meta.dataMode === 'mock' ? 'minta' : meta.dataMode === 'live' ? 'élő' : 'automatikus'}`;
  } catch { /* the view shows connection errors */ }
}

// ---------------------------------------------------------------------------
// Age gate (18+) and session reminder
// ---------------------------------------------------------------------------
function ageGate() {
  let ok = false;
  try { ok = localStorage.getItem('ageGate') === 'ok'; } catch { /* ignore */ }
  if (ok) return Promise.resolve();
  return new Promise((resolve) => {
    modal(`<div class="agegate-mark">18+</div>
      <h2>Elmúltál 18 éves?</h2>
      <p>Az alkalmazás sportfogadással kapcsolatos elemzéseket mutat, ezért csak nagykorúak használhatják. Az adatok tájékoztató jellegűek; a szerencsejáték pénzügyi kockázattal jár.</p>
      <div class="actions"><button class="btn btn-primary" id="ageYes" autofocus>Igen, elmúltam 18 éves</button><button class="btn" id="ageNo">Nem</button></div>`,
    { dismissable: false, label: 'Életkor-ellenőrzés', onMount: (dlg, close) => {
      dlg.querySelector('#ageYes').onclick = () => { try { localStorage.setItem('ageGate', 'ok'); } catch { /* ignore */ } close(); resolve(); };
      dlg.querySelector('#ageNo').onclick = () => {
        close();
        document.querySelector('.shell').innerHTML = `<main class="content" style="grid-column:1/-1;max-width:640px;margin:10vh auto"><h1>Az alkalmazás csak 18 év felett használható</h1>
          <p>Ha szerencsejátékkal kapcsolatban segítségre van szükséged, hívd a Szerencsejátékos Segélytelefont: (06-80) 980-025, vagy a Lelki Elsősegély Telefonszolgálatot: 116-123.</p></main>`;
        document.getElementById('bottomnav').remove();
      };
    } });
  });
}

function sessionReminder() {
  let start = Number(sessionStorage.getItem('sessionStart')) || Date.now();
  sessionStorage.setItem('sessionStart', String(start));
  let mins = 30;
  api('/api/limits').then((l) => { mins = l.limits.sessionReminderMin || 30; }).catch(() => {});
  let lastShown = start;
  setInterval(() => {
    if (Date.now() - lastShown < mins * 60e3 || document.getElementById('modal-root').children.length) return;
    lastShown = Date.now();
    const used = Math.round((Date.now() - start) / 60e3);
    modal(`<h2>Már ${used} perce használod az alkalmazást</h2>
      <p>Jó alkalom egy kis szünetre. Ellenőrizd, hogy a napi tét- és veszteségkorlátodon belül maradsz-e.</p>
      <div class="actions"><button class="btn btn-primary" id="srOk" autofocus>Folytatom</button><a class="btn" href="#/felelos-jatek" id="srRg">Korlátok és segítség</a></div>`,
    { label: 'Munkamenet-emlékeztető', onMount: (dlg, close) => { dlg.querySelector('#srOk').onclick = close; dlg.querySelector('#srRg').onclick = close; } });
  }, 30e3);
}

// ---------------------------------------------------------------------------
renderThemeBtn();
window.addEventListener('hashchange', router);
await ageGate();
router();
refreshMeta();
live.listeners.add(() => refreshMeta());
startSSE();
sessionReminder();
