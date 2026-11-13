// Match analysis hub: category switcher, day filter, match rows, and the
// side-by-side "statisztika nézet".
import { api } from '../api.js';
import { ICON } from '../icons.js';
import { esc, time, timeS, relDay, odds, pct, signedPct, evClass, badge, statusPill, conf, pbar, SPORT_HU, num } from '../format.js';

const S = {
  get(k, d) { try { return JSON.parse(sessionStorage.getItem('hub:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem('hub:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const SPORTS = [['all', 'Összes'], ['nba', 'NBA'], ['nhl', 'NHL'], ['tennis', 'Tenisz'], ['football', 'Labdarúgás'], ['handball', 'Kézilabda']];
const DAYS = [['live', 'Élő'], ['today', 'Ma'], ['tomorrow', 'Holnap'], ['later', 'Később'], ['yesterday', 'Tegnap']];

export async function render(el, _args, { live, toast }) {
  const st = { sport: S.get('sport', 'all'), league: S.get('league', 'all'), day: S.get('day', 'today'), compare: S.get('compare', false), meta: null, data: null, loading: true, error: null };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Meccselemzés</h1><p>Modellvalószínűség, méltányos szorzó, érték és bizalom meccsenként.</p></div>
      <div class="toolbar" style="margin:0">
        <label class="switch"><input type="checkbox" id="cmp" ${st.compare ? 'checked' : ''}> Statisztika nézet</label>
        <button class="btn" id="refresh" type="button">${ICON.refresh} Frissítés</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Sportág" id="sportChips"></div>
    </div>
    <div class="toolbar" id="leagueBar"></div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Időszak" id="daySeg"></div>
      <span class="grow"></span>
      <span class="updated" id="updated" aria-live="off"></span>
    </div>
    <div id="list"></div>`;

  const $ = (s) => el.querySelector(s);

  async function load({ silent = false } = {}) {
    if (!silent) { st.loading = true; draw(); }
    try {
      const q = new URLSearchParams({ sport: st.sport, league: st.league, day: st.day === 'live' ? 'all' : st.day, status: st.day === 'live' ? 'live' : 'all' });
      const [data, meta] = await Promise.all([api('/api/matches?' + q), st.meta ? Promise.resolve(st.meta) : api('/api/meta')]);
      st.data = data; st.meta = meta; st.error = null;
    } catch (e) { st.error = e.message; }
    st.loading = false; draw();
  }

  function drawControls() {
    $('#sportChips').innerHTML = SPORTS.map(([id, label]) => `<button class="chip" type="button" data-sport="${id}" aria-pressed="${st.sport === id}">${label}</button>`).join('');
    const leagues = (st.meta?.leagues || []).filter((l) => l.sport === st.sport);
    $('#leagueBar').innerHTML = leagues.length > 1
      ? `<div class="chips" role="group" aria-label="Bajnokság"><button class="chip" type="button" data-league="all" aria-pressed="${st.league === 'all'}">Mind</button>${leagues.map((l) => `<button class="chip" type="button" data-league="${l.id}" aria-pressed="${st.league === l.id}">${esc(l.name)}</button>`).join('')}</div>`
      : '';
    $('#daySeg').innerHTML = DAYS.map(([id, label]) => `<button type="button" data-day="${id}" aria-pressed="${st.day === id}">${label}</button>`).join('');
    $('#updated').innerHTML = st.data?.lastUpdate ? `Utolsó frissítés: <strong class="num">${timeS(st.data.lastUpdate)}</strong> · ${esc(live.transport)}` : 'Adatok betöltése…';
  }

  function draw() {
    drawControls();
    const list = $('#list');
    if (st.loading && !st.data) { list.innerHTML = `<div class="match-list" aria-busy="true" aria-label="Betöltés">${'<div class="skeleton sk-row"></div>'.repeat(7)}</div>`; return; }
    if (st.error) { list.innerHTML = `<div class="error-box" role="alert"><h3>Nem sikerült betölteni a meccseket</h3><p>${esc(st.error)}</p><button class="btn" id="retry">Újrapróbálás</button></div>`; $('#retry').onclick = () => load(); return; }
    const ms = st.data.matches;
    if (!st.data.lastUpdate) { list.innerHTML = `<div class="match-list" aria-busy="true">${'<div class="skeleton sk-row"></div>'.repeat(5)}</div><p class="muted small">Az első adatgyűjtés folyamatban…</p>`; return; }
    if (!ms.length) {
      const msg = st.day === 'live' ? 'Most nincs élő meccs a kiválasztott kategóriában.' : 'Ebben az időszakban nincs meccs a kiválasztott kategóriában.';
      list.innerHTML = `<div class="empty"><h3>Nincs megjeleníthető meccs</h3><p>${msg}</p><button class="btn" data-day-jump="${st.day === 'today' ? 'tomorrow' : 'today'}">${st.day === 'today' ? 'Holnapi meccsek' : 'Mai meccsek'}</button></div>`;
      return;
    }
    list.innerHTML = st.compare ? compareView(ms) : listView(ms);
  }

  function listView(ms) {
    const groups = new Map();
    for (const m of ms) { const k = m.league; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    return [...groups.entries()].map(([lid, arr]) => {
      const ls = st.data.leagueStatus?.[lid];
      return `<section class="league-group" aria-labelledby="lg-${lid}">
        <div class="league-head"><h2 id="lg-${lid}">${esc(arr[0].leagueName)}</h2><span class="muted small">${SPORT_HU[arr[0].sport]} · ${arr.length} meccs</span> ${badge(ls?.source, ls?.fetchedAt)}</div>
        <div class="match-list">${arr.map(row).join('')}</div></section>`;
    }).join('');
  }

  function row(m) {
    const t = m.tip;
    const hs = m.home.score; const as = m.away.score;
    const lead = (side) => (hs != null && as != null && ((side === 'home' && hs > as) || (side === 'away' && as > hs)) ? 'lead' : '');
    const clock = m.status === 'live' ? esc(m.live?.clock || m.statusText) : m.status === 'post' ? esc(m.statusText) : relDay(m.startTime);
    const tipHtml = t ? `<div class="tipcell">
        <span class="kind ${t.kind}">${esc(t.kindLabel)} · ${esc(t.betType)}</span>
        <span class="tipname" title="${esc(t.name)}">${esc(t.name)}</span>
        <span class="tipnums"><span class="odds">${odds(t.odds)}</span> ${badge(t.oddsSource)} <span class="${evClass(t.ev)}" title="Várható érték 1 egység tétre">EV ${signedPct(t.ev)}</span> <span class="muted">p ${pct(t.p, 0)}</span></span></div>`
      : `<div class="tipcell"><span class="muted small">${m.status === 'post' ? `Végeredmény: ${hs ?? '–'}–${as ?? '–'}` : 'Nincs ajánlás'}</span></div>`;
    const setInfo = m.sport === 'tennis' && m.setScores ? ` · ${esc(m.setScores)}` : '';
    return `<a class="match-row" href="#/meccs/${encodeURIComponent(m.id)}" aria-label="${esc(m.home.name)} – ${esc(m.away.name)}, ${esc(clock)}">
      <div class="when">${statusPill(m)}<span class="time">${m.status === 'live' ? `${hs ?? 0}–${as ?? 0}` : time(m.startTime)}</span><span class="small muted">${clock}</span></div>
      <div class="teams">
        <div class="team ${lead('home')}"><span class="nm">${esc(m.home.name)}</span><span class="sc">${hs ?? ''}</span></div>
        <div class="team ${lead('away')}"><span class="nm">${esc(m.away.name)}</span><span class="sc">${as ?? ''}</span></div>
        <div class="meta-line">${badge(m.dataStatus, m.fetchedAt)}${m.venue?.name ? `<span>${esc(m.venue.name)}</span>` : ''}${setInfo}${m.manualOddsCount ? '<span class="badge b-manual">KÉZI SZORZÓ</span>' : ''}</div>
      </div>
      ${pbar(m.main, m)}
      ${tipHtml}
      ${conf(m.confidence)}
    </a>`;
  }

  function compareView(ms) {
    // Columns = sports (or leagues when a sport is selected).
    const bySport = st.sport === 'all';
    const keyOf = (m) => (bySport ? m.sport : m.league);
    const cols = new Map();
    for (const m of ms) { const k = keyOf(m); if (!cols.has(k)) cols.set(k, []); cols.get(k).push(m); }
    return `<div class="compare">${[...cols.entries()].map(([k, arr]) => {
      const tips = arr.map((m) => m.tip).filter(Boolean);
      const value = tips.filter((t) => t.kind === 'value');
      const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const top = [...arr].filter((m) => m.tip).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 6);
      return `<section class="compare-col" aria-label="${esc(bySport ? SPORT_HU[k] : arr[0].leagueName)}">
        <header><h2>${esc(bySport ? SPORT_HU[k] : arr[0].leagueName)}</h2></header>
        <div class="compare-stats">
          <div><div class="v">${arr.length}</div><div class="l">meccs</div></div>
          <div><div class="v">${arr.filter((m) => m.status === 'live').length}</div><div class="l">élő</div></div>
          <div><div class="v">${value.length}</div><div class="l">értéktipp</div></div>
          <div><div class="v">${num(avg(tips.map((t) => t.confidence)), 0)}</div><div class="l">átlagos bizalom</div></div>
          <div><div class="v ${evClass(avg(value.map((t) => t.ev)))}">${signedPct(avg(value.map((t) => t.ev)))}</div><div class="l">átlagos EV (értéktippek)</div></div>
          <div><div class="v">${pct(avg(arr.map((m) => m.coverage).filter((x) => x != null)), 0)}</div><div class="l">adatlefedettség</div></div>
        </div>
        ${top.map((m) => `<a class="compact-row" href="#/meccs/${encodeURIComponent(m.id)}"><span>${esc(m.home.name)} – ${esc(m.away.name)}<br><span class="muted small">${esc(m.tip.name)} @ <span class="num">${odds(m.tip.odds)}</span></span></span><span class="num">${m.confidence}</span></a>`).join('')}
      </section>`;
    }).join('')}</div>`;
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sport) { st.sport = b.dataset.sport; st.league = 'all'; S.set('sport', st.sport); S.set('league', 'all'); load(); }
    else if (b.dataset.league) { st.league = b.dataset.league; S.set('league', st.league); load(); }
    else if (b.dataset.day || b.dataset.dayJump) { st.day = b.dataset.day || b.dataset.dayJump; S.set('day', st.day); load(); }
    else if (b.id === 'refresh') {
      b.disabled = true; b.classList.add('spin');
      try { await api('/api/refresh', { method: 'POST' }); await load({ silent: true }); toast('Adatok frissítve.'); }
      catch (err) { toast(err.message, 'err'); }
      b.disabled = false; b.classList.remove('spin');
    }
  });
  $('#cmp').addEventListener('change', (e) => { st.compare = e.target.checked; S.set('compare', st.compare); draw(); });

  const onLive = () => load({ silent: true });
  live.listeners.add(onLive);
  // Client-side safety net: refresh every 45 s while live matches are shown.
  const timer = setInterval(() => { if (st.data?.matches?.some((m) => m.status === 'live')) load({ silent: true }); }, 45000);
  await load();
  return () => { live.listeners.delete(onLive); clearInterval(timer); };
}
