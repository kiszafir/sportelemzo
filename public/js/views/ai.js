// AI-motor: what the local learning layer has learned, whether it is active,
// how much it improved on held-out matches, and plain-Hungarian observations.
import { api } from '../api.js';
import { ICON } from '../icons.js';
import { esc, pct, num, timeS, date, SPORT_HU, ago } from '../format.js';
import { lineChart, barChart } from '../charts.js';

const FAMILY_HU = { result: 'Győztes / végeredmény', totals: 'Gólszám / összpontszám', spread: 'Hendikep', btts: 'Mindkét csapat gól', teamtotals: 'Csapat gól-/pontszáma', cards: 'Sárga lapok', player: 'Játékos pontjai / góljai' };
const SRC_HU = { live: 'Élő adatok', mock: 'Mintaadat' };

export async function render(el, _a, { toast }) {
  const st = { data: null, src: null, sel: null };
  el.innerHTML = `<div class="page-head"><div><h1>AI-motor</h1><p>Helyi gépi tanulás a saját lezárt meccseidből. Nem chatbot, és nem küld adatot sehova.</p></div>
    <div class="toolbar" style="margin:0"><button class="btn" id="train" type="button">${ICON.refresh} Újratanítás most</button></div></div>
    <details class="card" style="margin-bottom:16px"><summary><strong>Hogyan működik?</strong></summary>
      <ol style="margin:10px 0 0;padding-left:1.2em;max-width:76ch">
        <li>Minden meccs előtt elmenti a modell nyers becslését, a piac árrés nélküli valószínűségét és a tényezők értékét.</li>
        <li>A meccs végén rögzíti az eredményt.</li>
        <li>Sportáganként és piaconként megtanulja, hol téved a modell (túl magabiztos-e, túlbecsüli-e a hazait vagy a favoritot), és mennyire bízzon a modellben a piachoz képest.</li>
        <li><strong>Védőkorlát:</strong> csak akkor kapcsol be, ha legalább 80 lezárt eset van, és a régebbi 75%-on tanítva a legújabb 25%-on bizonyíthatóan jobb (alacsonyabb log loss), mint a nyers modell. Különben semmit nem változtat.</li>
        <li>A mintaadaton tanult beállítások csak mintaadatra vonatkoznak, élő meccsekre soha.</li>
      </ol>
      <p class="small muted" style="margin-top:8px">A javulás statisztikai: jobb valószínűségbecslést jelent, nem garantált nyereséget.</p></details>
    <div id="aiBody"><div class="skeleton" style="height:240px"></div></div>`;
  const body = el.querySelector('#aiBody');

  async function load() {
    try { st.data = await api('/api/ai'); draw(); }
    catch (e) { body.innerHTML = `<div class="error-box" role="alert"><h3>Nem sikerült betölteni</h3><p>${esc(e.message)}</p></div>`; }
  }

  function draw() {
    const d = st.data;
    const srcs = Object.keys(d.models || {});
    if (!st.src) st.src = srcs.includes(d.dataMode === 'mock' ? 'mock' : 'live') ? (d.dataMode === 'mock' ? 'mock' : 'live') : srcs.includes('live') ? 'live' : srcs[0];
    const S = d.sources[st.src || 'live'] || { snapshots: 0, labelled: 0 };
    const models = d.models?.[st.src] || {};
    const rows = Object.entries(models).flatMap(([sport, fams]) => Object.entries(fams).map(([fam, m]) => ({ sport, fam, ...m })));
    const active = rows.filter((r) => r.active);
    const avgGain = active.length ? active.reduce((s, r) => s + r.metrics.gain, 0) / active.length : null;
    if (!st.sel || !rows.some((r) => `${r.sport}:${r.fam}` === st.sel)) {
      // default: the active correction with the largest held-out sample (most readable chart)
      const best = [...(active.length ? active : rows)].sort((a, b) => (b.metrics.test || 0) - (a.metrics.test || 0))[0];
      st.sel = best ? `${best.sport}:${best.fam}` : null;
    }
    const insights = (d.insights || []).filter((i) => i.src === st.src);

    body.innerHTML = `
      ${srcs.length > 1 ? `<div class="toolbar"><div class="seg" role="group" aria-label="Adatforrás">${srcs.map((s) => `<button type="button" data-src="${s}" aria-pressed="${s === st.src}">${SRC_HU[s]}</button>`).join('')}</div></div>` : ''}
      ${st.src === 'mock' ? '<div class="notice warn" role="note"><strong>Mintaadaton tanult (MINTA).</strong> Ezek a beállítások csak a szimulált meccsekre vonatkoznak. Élő adatokkal az AI a valódi eredményekből kezd tanulni.</div>' : ''}
      ${!srcs.length || (st.src === 'live' && !S.labelled) ? `<div class="notice">Az AI még gyűjti az adatot: ${S.snapshots} meccs előtti állapot elmentve, ${S.labelled} lezárt. Sportáganként és piaconként ${d.minRows} lezárt eset után próbál először tanulni – élő adatokkal ez néhány nap.</div>` : ''}
      <div class="kpis">
        <div class="kpi"><div class="v">${S.labelled}</div><div class="l">lezárt, tanulható meccs</div></div>
        <div class="kpi"><div class="v">${S.snapshots - S.labelled}</div><div class="l">függőben (még nem ért véget)</div></div>
        <div class="kpi"><div class="v">${active.length} / ${rows.length}</div><div class="l">aktív korrekció (sportág × piac)</div></div>
        <div class="kpi"><div class="v">${avgGain != null ? num(avgGain, 3) : '–'}</div><div class="l">átlagos log loss javulás (félretett meccseken)</div></div>
        <div class="kpi"><div class="v">${d.trainedAt ? timeS(d.trainedAt) : '–'}</div><div class="l">utolsó tanítás${d.trainedAt ? ' · ' + ago(d.trainedAt) : ''}</div></div>
      </div>
      <section class="card" style="margin-bottom:16px"><h2 style="margin-bottom:8px">Megfigyelések</h2>
        ${insights.length ? `<ul style="margin:0;padding-left:1.1em;max-width:90ch">${insights.slice(0, 12).map((i) => `<li style="margin:6px 0">${esc(i.text)}</li>`).join('')}</ul>` : '<p class="muted">Még nincs elég lezárt meccs érdemi megfigyeléshez.</p>'}
      </section>
      ${rows.length ? `<h2 style="margin:0 0 10px">Tanult korrekciók</h2>
      <div class="tbl-wrap"><table class="tbl"><caption class="sr-only">Tanult korrekciók</caption><thead><tr>
        <th scope="col">Sportág</th><th scope="col">Piac</th><th scope="col" class="r">Minta</th><th scope="col">Állapot</th>
        <th scope="col" class="r" title="Log loss a legújabb 25%-on: nyers modell → AI">Log loss nyers → AI</th><th scope="col" class="r">Brier nyers → AI</th><th scope="col">Bizalom: modell / piac</th><th scope="col"></th></tr></thead><tbody>
        ${rows.map((r) => {
          const M = r.metrics;
          const state = r.active ? '<span class="badge b-live">AKTÍV</span>' : r.reason === 'collecting' ? `<span class="badge b-na">GYŰJT (${M.n}/${M.need})</span>` : '<span class="badge b-cached">NEM JAVÍTOTT – KI</span>';
          const share = r.metrics.marketShare > 0.2 ? `${pct(r.interp.modelShare, 0)} / ${pct(r.interp.marketShare, 0)}` : `${pct(1, 0)} / – <span class="small muted">(kevés piaci szorzó)</span>`;
          return `<tr><td>${SPORT_HU[r.sport]}</td><td>${r.sport === 'tennis' && r.fam === 'btts' ? 'Mindkét játékos nyer szettet' : r.sport === 'tennis' && r.fam === 'totals' ? 'Összes játék' : FAMILY_HU[r.fam]}</td><td class="r num">${M.n}</td><td>${state}</td>
            <td class="r num">${M.llRaw != null ? `${num(M.llRaw, 3)} → <strong class="${M.gain > 0 ? 'ev-pos' : ''}">${num(M.llAi, 3)}</strong>` : '–'}</td>
            <td class="r num">${M.brierRaw != null ? `${num(M.brierRaw, 3)} → ${num(M.brierAi, 3)}` : '–'}</td>
            <td>${r.reason === 'collecting' ? '–' : share}${r.reason !== 'collecting' && r.interp.sharpness < 0.9 ? ' <span class="small muted">· óvatosabbá teszi</span>' : r.reason !== 'collecting' && r.interp.sharpness > 1.1 ? ' <span class="small muted">· határozottabbá teszi</span>' : ''}</td>
            <td>${M.calRaw ? `<button class="btn btn-small" data-sel="${r.sport}:${r.fam}" aria-pressed="${st.sel === `${r.sport}:${r.fam}`}">Kalibráció</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : ''}
      <div class="charts" style="margin-top:16px">
        ${calibrationCard(rows)}
        ${factorCard(d.factors?.[st.src] || {})}
      </div>
      ${(d.history || []).length ? `<details class="card" style="margin-top:16px"><summary><strong>Tanítási napló</strong></summary><ul style="margin:8px 0 0;padding-left:1.1em">${d.history.slice(0, 15).map((h) => `<li>${date(h.t)} ${timeS(h.t)} – ${esc({ first: 'első tanítás', 'new-results': 'új eredmények', schedule: 'ütemezett', manual: 'kézi' }[h.reason] || h.reason)}: ${h.active} aktív korrekció, ${h.labelled} lezárt meccs</li>`).join('')}</ul></details>` : ''}`;
  }

  function calibrationCard(rows) {
    const r = rows.find((x) => `${x.sport}:${x.fam}` === st.sel);
    if (!r?.metrics?.calRaw) return '<section class="card"><h2>Kalibráció</h2><p class="muted">Válassz egy sort a táblázatból, ha már van elég adat.</p></section>';
    const idx = r.metrics.calRaw.map((b, i) => i).filter((i) => r.metrics.calRaw[i].n >= 3 || r.metrics.calAi[i].n >= 3);
    const labels = idx.map((i) => `${Math.round(r.metrics.calRaw[i].lo * 100)}–${Math.round(r.metrics.calRaw[i].hi * 100)}%`);
    return `<section class="card"><h2>Kalibráció – ${SPORT_HU[r.sport]}, ${esc(FAMILY_HU[r.fam].toLowerCase())}</h2>
      <p class="small muted">A becsült valószínűség sávjai (vízszintes) és a tényleges bejövési arány (függőleges) a legújabb ${r.metrics.test} félretett eseten. Minél közelebb a vonal az ideálishoz, annál pontosabb a becslés.</p>
      ${lineChart({ title: 'Kalibráció', labels, yFmt: (v) => pct(v, 0), yMin: 0, yMax: 1, series: [
        { name: 'Ideális', color: 'var(--muted)', values: idx.map((i) => (r.metrics.calRaw[i].lo + r.metrics.calRaw[i].hi) / 2), dash: true },
        { name: 'Nyers modell', color: 'var(--away)', values: idx.map((i) => (r.metrics.calRaw[i].n >= 3 ? r.metrics.calRaw[i].actual : null)) },
        { name: 'AI-korrigált', color: 'var(--pos)', values: idx.map((i) => (r.metrics.calAi[i].n >= 3 ? r.metrics.calAi[i].actual : null)) },
      ] })}</section>`;
  }

  function factorCard(factors) {
    const sports = Object.keys(factors);
    if (!sports.length) return '<section class="card"><h2>Mi jelzett előre valójában?</h2><p class="muted">Sportáganként legalább 60 lezárt meccs kell hozzá.</p></section>';
    const sp = sports.includes(st.factorSport) ? st.factorSport : sports[0];
    const f = factors[sp];
    const items = f.importance.slice(0, 8).map((x) => ({ label: x.label, value: Math.abs(x.importance), sub: x.importance >= 0 ? 'a vártnak megfelelően hat' : 'ellentétesen hatott' }));
    return `<section class="card"><h2>Mi jelzett előre valójában?</h2>
      <div class="chips" role="group" aria-label="Sportág" style="margin:8px 0">${sports.map((s) => `<button class="chip" type="button" data-fsport="${s}" aria-pressed="${s === sp}">${SPORT_HU[s]}</button>`).join('')}</div>
      <p class="small muted">Tényezők fontossága a hazai győzelem előrejelzésében (${f.n} lezárt meccs alapján, regularizált logisztikus regresszió). Csak tájékoztató: a modell súlyait nem írja át automatikusan.</p>
      ${barChart({ title: 'Tényezők fontossága', items, fmt: (v) => num(v, 2), color: 'var(--info)' })}</section>`;
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.src) { st.src = b.dataset.src; st.sel = null; draw(); }
    else if (b.dataset.sel) { st.sel = b.dataset.sel; draw(); }
    else if (b.dataset.fsport) { st.factorSport = b.dataset.fsport; draw(); }
    else if (b.id === 'train') {
      b.disabled = true; b.classList.add('spin');
      try { st.data = await api('/api/ai/train', { method: 'POST' }); draw(); toast('Az AI-motor újratanítva, az elemzések frissültek.'); }
      catch (err) { toast(err.message, 'err'); }
      b.disabled = false; b.classList.remove('spin');
    }
  });
  await load();
}
