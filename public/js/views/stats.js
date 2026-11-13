// Statistics: model accuracy over time, ROI, hit rates by sport / bet type /
// confidence band, and the tip log with outcomes.
import { api } from '../api.js';
import { esc, pct, signedPct, num, odds, date, time, evClass, dayKey, SPORT_HU, RESULT_HU, badge } from '../format.js';
import { lineChart, barChart } from '../charts.js';

export async function render(el, _a, { live }) {
  const today = dayKey(Date.now());
  const st = { from: dayKey(Date.now() - 60 * 864e5), to: today, sport: 'all', market: 'all', source: 'all', page: 0 };

  el.innerHTML = `<div class="page-head"><div><h1>Statisztika és eredmények</h1><p>A modell naplózott tippjeinek teljesítménye. A tippek a meccs végén automatikusan elszámolódnak.</p></div></div>
    <form class="card" id="filters" style="margin-bottom:18px"><div class="form-grid">
      <label class="field">Kezdő dátum<input type="date" name="from" value="${st.from}"></label>
      <label class="field">Záró dátum<input type="date" name="to" value="${st.to}"></label>
      <label class="field">Sportág<select name="sport"><option value="all">Mind</option>${Object.entries(SPORT_HU).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="field">Piac<select name="market" id="marketSel"><option value="all">Mind</option></select></label>
      <label class="field">Adatforrás<select name="source"><option value="all">Mind</option><option value="live">Élő adatok</option><option value="mock">Mintaadat</option></select></label>
    </div></form>
    <div id="body"></div>`;
  const body = el.querySelector('#body');

  async function load() {
    body.innerHTML = `<div class="kpis" aria-busy="true">${'<div class="kpi"><div class="skeleton" style="height:44px"></div></div>'.repeat(5)}</div><div class="skeleton" style="height:260px"></div>`;
    const q = new URLSearchParams({ from: st.from, to: st.to, sport: st.sport, market: st.market, source: st.source });
    try {
      const [s, tips] = await Promise.all([api('/api/stats?' + q), api('/api/tips?limit=500&' + q)]);
      const ms = el.querySelector('#marketSel');
      if (ms.options.length <= 1) ms.innerHTML = '<option value="all">Mind</option>' + s.markets.map((m) => `<option>${esc(m)}</option>`).join('');
      draw(s, tips);
    } catch (e) { body.innerHTML = `<div class="error-box" role="alert"><h3>Nem sikerült betölteni a statisztikát</h3><p>${esc(e.message)}</p></div>`; }
  }

  function draw(s, tips) {
    const T = s.total;
    if (!T.n) { body.innerHTML = `<div class="empty"><h3>Még nincs naplózott tipp ebben a szűrésben</h3><p>A modell minden közelgő meccsre naplóz egy ajánlást; az eredmények a meccsek végén automatikusan megjelennek itt.</p></div>`; return; }
    const mockOnly = s.sources.length === 1 && s.sources[0] === 'mock';
    const series = s.series;
    const bandItems = s.byConfidence.filter((b) => b.settled).map((b) => ({ label: `Bizalom ${b.label}`, value: b.hitRate, ref: b.expectedHitRate, sub: `${b.settled} tipp` }));
    body.innerHTML = `
      ${mockOnly || st.source === 'mock' ? '<div class="notice warn" role="note"><strong>Szimulált eredmények (MINTA).</strong> Ezek a számok a beépített szimulációból származnak, a modell valós teljesítményéről nem mondanak semmit. Valós adatforrással a napló a valódi meccsekből épül.</div>' : ''}
      <div class="kpis">
        <div class="kpi"><div class="v">${T.n}</div><div class="l">naplózott tipp (${T.pending} függőben)</div></div>
        <div class="kpi"><div class="v">${pct(T.hitRate)}</div><div class="l">találati arány (várt: ${pct(T.expectedHitRate)})</div></div>
        <div class="kpi"><div class="v ${evClass(T.roi)}">${signedPct(T.roi)}</div><div class="l">ROI egységnyi tétekkel</div></div>
        <div class="kpi"><div class="v ${evClass(T.profit)}">${num(T.profit, 1)}</div><div class="l">nyereség (egység)</div></div>
        <div class="kpi"><div class="v">${num(T.brier, 3)}</div><div class="l">Brier-pontszám (alacsonyabb a jobb)</div></div>
      </div>
      <div class="charts">
        <section class="card"><h2>Pontosság hetente</h2><p class="small muted">Tényleges találati arány a modell által várt arányhoz képest.</p>
          ${lineChart({ title: 'Heti találati arány', labels: series.map((x) => x.week.slice(5).replace('-', '.')), series: [{ name: 'Tényleges', color: 'var(--ink)', values: series.map((x) => x.hitRate) }, { name: 'Modell szerint várt', color: 'var(--amber)', values: series.map((x) => x.expected), dash: true }], yFmt: (v) => pct(v, 0), yMin: 0, yMax: 1 })}</section>
        <section class="card"><h2>Kumulált ROI</h2><p class="small muted">Egységnyi tétekkel, a szűrt időszakban.</p>
          ${lineChart({ title: 'Kumulált ROI', labels: series.map((x) => x.week.slice(5).replace('-', '.')), series: [{ name: 'ROI', color: 'var(--pos)', values: series.map((x) => x.cumRoi) }], yFmt: (v) => pct(v, 0), zeroLine: true })}</section>
        <section class="card"><h2>Találati arány sportáganként</h2>${barChart({ title: 'Találati arány sportáganként', items: s.bySport.filter((b) => b.settled).map((b) => ({ label: b.label, value: b.hitRate, ref: b.expectedHitRate, sub: `ROI ${signedPct(b.roi)}` })), fmt: (v) => pct(v, 0), max: 1, refLabel: 'Várt arány' })}</section>
        <section class="card"><h2>Találati arány fogadástípusonként</h2>${barChart({ title: 'Találati arány fogadástípusonként', items: s.byMarket.filter((b) => b.settled).map((b) => ({ label: b.label, value: b.hitRate, ref: b.expectedHitRate, sub: `${b.settled} db` })), fmt: (v) => pct(v, 0), max: 1, refLabel: 'Várt arány' })}</section>
        <section class="card"><h2>Bizalmi sávok szerint</h2><p class="small muted">Egy jól kalibrált modellnél a magasabb bizalmi sáv magasabb találati arányt hoz.</p>${barChart({ title: 'Találati arány bizalmi sávonként', items: bandItems, fmt: (v) => pct(v, 0), max: 1, refLabel: 'Várt arány' })}</section>
        <section class="card"><h2>Tipptípus szerint</h2>${barChart({ title: 'ROI tipptípusonként', items: s.byKind.filter((b) => b.settled).map((b) => ({ label: b.label, value: b.hitRate, sub: `ROI ${signedPct(b.roi)}, ${b.settled} db` })), fmt: (v) => pct(v, 0), max: 1 })}</section>
      </div>
      <h2 style="margin:24px 0 10px">Tippnapló</h2>
      ${tipTable(tips)}`;
  }

  function tipTable(tips) {
    const per = 50; const pages = Math.ceil(tips.tips.length / per);
    const rows = tips.tips.slice(st.page * per, st.page * per + per).map((t) => `<tr>
      <td>${date(t.startTime)} ${time(t.startTime)}</td><td>${SPORT_HU[t.sport]}<div class="small muted">${esc(t.leagueName)}</div></td>
      <td>${esc(t.matchName)}${t.live ? ' <span class="badge b-live">ÉLŐ TIPP</span>' : ''}</td><td>${esc(t.name)}<div class="small muted">${esc(t.betType)} · ${t.kind === 'value' ? 'értéktipp' : 'esélyes'}</div></td>
      <td class="r num">${odds(t.odds)}</td><td class="r num">${pct(t.p, 0)}</td><td class="r num">${t.confidence}</td>
      <td><span class="status ${t.status === 'won' ? 'risk risk-alacsony' : t.status === 'lost' ? 'risk risk-magas' : 'st-pre'}">${RESULT_HU[t.status]}</span><div class="small muted">${esc(t.result || '')}</div></td>
      <td>${badge(t.source === 'mock' ? 'mock' : 'live')}</td></tr>`).join('');
    const pager = pages > 1 ? `<div class="toolbar" style="margin-top:10px"><button class="btn btn-small" data-page="-1" ${st.page === 0 ? 'disabled' : ''}>Előző</button><span class="small muted">${st.page + 1} / ${pages} oldal (${tips.total} tipp${tips.total > 500 ? ', az 500 legutóbbi' : ''})</span><button class="btn btn-small" data-page="1" ${st.page >= pages - 1 ? 'disabled' : ''}>Következő</button></div>` : '';
    return `<div class="tbl-wrap"><table class="tbl"><caption class="sr-only">Tippnapló</caption><thead><tr><th scope="col">Időpont</th><th scope="col">Sportág</th><th scope="col">Meccs</th><th scope="col">Tipp</th><th scope="col" class="r">Szorzó</th><th scope="col" class="r">Esély</th><th scope="col" class="r">Bizalom</th><th scope="col">Eredmény</th><th scope="col">Forrás</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}`;
  }

  el.querySelector('#filters').addEventListener('change', (e) => { st[e.target.name] = e.target.value; st.page = 0; load(); });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-page]'); if (!b) return;
    st.page += Number(b.dataset.page); load();
  });
  // Re-load when results settle (live update), at most once a minute.
  let last = Date.now();
  const onLive = () => { if (Date.now() - last > 60e3) { last = Date.now(); load(); } };
  live.listeners.add(onLive);
  await load();
  return () => live.listeners.delete(onLive);
}
