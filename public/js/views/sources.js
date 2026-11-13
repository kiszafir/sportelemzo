// Data sources: provider status, per-league freshness, scheduled jobs, backtest.
import { api } from '../api.js';
import { esc, badge, timeS, ago, pct, num, SPORT_HU } from '../format.js';

export async function render(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Adatforrások</h1><p>Mely szolgáltatók aktívak, milyen frissek az adatok, és hogyan teljesít a modell a visszatesztelésen.</p></div></div><div id="src"><div class="skeleton" style="height:240px"></div></div>`;
  const root = el.querySelector('#src');
  try {
    const meta = await api('/api/meta');
    root.innerHTML = `
      <section class="card"><h2 style="margin-bottom:10px">Szolgáltatók</h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Forrás</th><th scope="col">Állapot</th><th scope="col">Adat</th><th scope="col">Ingyenes keret</th><th scope="col">Utolsó siker / hiba</th><th scope="col">Feltételek</th></tr></thead><tbody>
      ${meta.providers.map((p) => `<tr><td><strong>${esc(p.name)}</strong>${p.homepage ? `<div class="small"><a href="${esc(p.homepage)}" target="_blank" rel="noopener noreferrer">${esc(p.homepage.replace('https://', ''))}</a></div>` : ''}</td>
        <td>${p.enabled ? (p.health?.circuitOpen ? '<span class="badge b-cached">SZÜNETEL (hibák)</span>' : '<span class="badge b-live">AKTÍV</span>') : `<span class="badge b-na">KIKAPCSOLVA</span><div class="small muted">${esc(p.reason || '')}</div>`}</td>
        <td class="small">${esc((p.kinds || []).join(', '))}</td><td class="small">${esc(p.freeTier || '')}${Number.isFinite(p.health?.quotaLeft) ? `<div class="muted">mai keret: ${p.health.quotaLeft}</div>` : ''}</td>
        <td class="small">${p.lastOk ? 'siker: ' + ago(p.lastOk) : '–'}${p.lastError ? `<div style="color:var(--neg)">hiba: ${esc(p.lastError.message)} (${ago(p.lastError.at)})</div>` : ''}</td>
        <td class="small muted">${esc(p.terms || '')}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted" style="margin-top:8px">Az opcionális kulcsokat a projekt gyökerében lévő <code>.env</code> fájlban adhatod meg (minta: <code>.env.example</code>), majd indítsd újra az alkalmazást.</p></section>

      <section class="card" style="margin-top:16px"><h2 style="margin-bottom:10px">Bajnokságok adatállapota</h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Bajnokság</th><th scope="col">Sportág</th><th scope="col">Forrás</th><th scope="col" class="r">Meccsek</th><th scope="col">Lekérve</th><th scope="col">Megjegyzés</th></tr></thead><tbody>
      ${meta.leagues.map((l) => { const s = meta.leagueStatus[l.id] || {}; return `<tr><td>${esc(l.name)}</td><td>${SPORT_HU[l.sport]}</td><td>${badge(s.source, s.fetchedAt)}</td><td class="r num">${s.count ?? '–'}</td><td>${s.fetchedAt ? timeS(s.fetchedAt) : '–'}</td><td class="small muted">${s.fallback ? 'Az élő forrás nem érhető el – mintaadat. ' : ''}${esc(s.error || '')}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${Object.keys(meta.playerData || {}).length ? `<p class="small muted" style="margin-top:8px">Játékosadatok (NBA/NHL játékospiacok): ${Object.entries(meta.playerData).map(([id, p]) => `${esc(id.toUpperCase())}: ${p.boxScores} box score${p.lastSync ? ', szinkron ' + timeS(p.lastSync) : ''}`).join(' · ')}. A sérüléslistát az ESPN 30 percenként frissített jelentéséből vesszük.</p>` : ''}</section>

      <div class="grid-2" style="margin-top:16px">
        <section class="card"><h2 style="margin-bottom:10px">Ütemezett feladatok</h2>
          <ul style="margin:0;padding-left:1.1em">${meta.jobs.map((j) => `<li><strong>${esc({ 'full-refresh': 'Teljes frissítés', 'live-refresh': 'Élő frissítés', settle: 'Tippek elszámolása' }[j.name] || j.name)}</strong> – ${j.everySeconds} mp-enként; utoljára: ${j.lastRun ? timeS(j.lastRun) : 'még nem futott'}${j.lastError ? ` <span style="color:var(--neg)">(${esc(j.lastError)})</span>` : ''}</li>`).join('')}</ul>
          <p class="small muted" style="margin-top:8px">Élő frissítés: Server-Sent Events, kiesés esetén 45 mp-es lekérdezés.</p></section>
        <section class="card"><div class="panel-title"><h2>Visszatesztelés</h2><button class="btn btn-small" id="bt" type="button">Futtatás</button></div><div id="btOut"><p class="muted small">60 nap szimulált előzményen méri a modell pontosságát, Brier-pontszámát és az értéktippek ROI-ját.</p></div></section>
      </div>`;
    root.querySelector('#bt').onclick = async (e) => {
      e.target.disabled = true; root.querySelector('#btOut').innerHTML = '<div class="skeleton" style="height:120px"></div>';
      try {
        const r = await api('/api/backtest');
        root.querySelector('#btOut').innerHTML = `<div class="notice warn small">Szimulált (MINTA) előzmény – a valós teljesítményt nem bizonyítja.</div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Sportág</th><th scope="col" class="r">n</th><th scope="col" class="r">Pontosság</th><th scope="col" class="r">Brier</th><th scope="col" class="r">Log loss</th><th scope="col" class="r">Értéktipp ROI</th></tr></thead><tbody>
          ${Object.entries({ ...r.bySport, összes: r.overall }).map(([k, m]) => `<tr><td>${esc(SPORT_HU[k] || k)}</td><td class="r num">${m.n}</td><td class="r num">${pct(m.accuracy)}</td><td class="r num">${num(m.brier, 3)}</td><td class="r num">${num(m.logLoss, 3)}</td><td class="r num">${pct(m.valueRoi)}</td></tr>`).join('')}
          </tbody></table></div>`;
      } catch (err) { root.querySelector('#btOut').innerHTML = `<p style="color:var(--neg)">${esc(err.message)}</p>`; }
      e.target.disabled = false;
    };
  } catch (e) { root.innerHTML = `<div class="error-box" role="alert"><h3>Nem sikerült betölteni</h3><p>${esc(e.message)}</p></div>`; }
}
