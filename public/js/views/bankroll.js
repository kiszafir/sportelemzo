// Bankroll tracker: own bets (the app never places bets), running balance,
// limits usage (enforced), fractional-Kelly helper.
import { api } from '../api.js';
import { esc, huf, odds, pct, date, time, num, evClass, RESULT_HU, SPORT_HU } from '../format.js';
import { lineChart } from '../charts.js';

const prog = (label, used, limit) => {
  const r = limit > 0 ? used / limit : 1;
  return `<div class="prog"><div class="row"><span>${label}</span><span class="num">${huf(used)} / ${huf(limit)}</span></div>
    <div class="track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.round(used)}"><div class="fill ${r >= 1 ? 'over' : r >= 0.8 ? 'warn' : ''}" style="width:${Math.min(100, r * 100).toFixed(0)}%"></div></div></div>`;
};

export async function render(el, _a, { toast }) {
  let v = null; let limitsInfo = null;

  el.innerHTML = `<div class="page-head"><div><h1>Bankroll</h1><p>Saját fogadásaid nyilvántartása. Az alkalmazás nem köt fogadást és nem kapcsolódik fogadóirodához.</p></div></div><div id="b"></div>`;
  const b = el.querySelector('#b');

  async function load() {
    try { [v, limitsInfo] = await Promise.all([api('/api/bankroll'), api('/api/limits')]); draw(); }
    catch (e) { b.innerHTML = `<div class="error-box" role="alert"><h3>Nem sikerült betölteni</h3><p>${esc(e.message)}</p></div>`; }
  }

  function draw() {
    const u = v.usage; const s = v.settings; const L = s.limits;
    const paused = limitsInfo.selfPauseUntil && Date.now() < limitsInfo.selfPauseUntil;
    const blocked = paused || u.lossToday >= L.dailyLoss || u.lossWeek >= L.weeklyLoss || u.remaining.dailyStake <= 0 || u.remaining.weeklyStake <= 0;
    const maxStake = Math.max(0, Math.min(u.remaining.dailyStake, u.remaining.weeklyStake, u.available));
    b.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${huf(u.balance)}</div><div class="l">egyenleg (kezdő: ${huf(s.bankrollStart)})</div></div>
        <div class="kpi"><div class="v">${huf(u.available)}</div><div class="l">szabad egyenleg</div></div>
        <div class="kpi"><div class="v">${huf(u.openStakes)}</div><div class="l">nyitott tétek</div></div>
        <div class="kpi"><div class="v ${evClass(u.balance - s.bankrollStart)}">${huf(u.balance - s.bankrollStart)}</div><div class="l">összes nyereség/veszteség</div></div>
      </div>
      <div class="grid-2">
        <section class="card"><div class="panel-title"><h2>Korlátok felhasználása</h2><a class="small" href="#/felelos-jatek">Korlátok módosítása</a></div>
          <div style="display:grid;gap:12px">${prog('Napi tét', u.stakedToday, L.dailyStake)}${prog('Heti tét', u.stakedWeek, L.weeklyStake)}${prog('Napi veszteség', u.lossToday, L.dailyLoss)}${prog('Heti veszteség', u.lossWeek, L.weeklyLoss)}</div>
          ${limitsInfo.pending ? `<p class="small muted" style="margin-top:10px">Függő korlátemelés: ${new Date(limitsInfo.pending.effectiveAt).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}-tól érvényes.</p>` : ''}</section>
        <section class="card"><h2 style="margin-bottom:10px">Új fogadás rögzítése</h2>
          ${blocked ? `<div class="notice danger" role="alert">${paused ? 'Önkéntes szünet van érvényben – addig nem rögzíthetsz tétet.' : 'Elérted valamelyik tét- vagy veszteségkorlátodat. Új tét a korlát nullázódása után rögzíthető.'}</div>` : ''}
          <form id="betForm" class="form-grid" ${blocked ? 'aria-disabled="true"' : ''}>
            <label class="field" style="grid-column:1/-1">Leírás<input type="text" name="description" maxlength="200" placeholder="pl. Ferencváros – Paks, 1X" required ${blocked ? 'disabled' : ''}></label>
            <label class="field">Szorzó<input type="text" name="odds" inputmode="decimal" placeholder="1,85" required ${blocked ? 'disabled' : ''}></label>
            <label class="field">Tét (Ft)<input type="number" name="stake" min="1" step="1" max="${maxStake}" required ${blocked ? 'disabled' : ''}></label>
            <label class="field">Becsült esély % (Kellyhez)<input type="number" name="p" min="1" max="99" step="0.1" placeholder="pl. 58" ${blocked ? 'disabled' : ''}></label>
            <label class="field">Sportág<select name="sport" ${blocked ? 'disabled' : ''}><option value="">–</option>${Object.entries(SPORT_HU).map(([k, x]) => `<option value="${k}">${x}</option>`).join('')}</select></label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;grid-column:1/-1"><button class="btn" type="button" id="kellyBtn" ${blocked ? 'disabled' : ''}>Kelly-javaslat</button><button class="btn btn-primary" type="submit" ${blocked ? 'disabled' : ''}>Rögzítés</button></div>
            <p class="small muted" id="kellyOut" style="grid-column:1/-1;margin:0">Tétkeret most: legfeljebb ${huf(maxStake)}. Kelly: ${pct(s.kellyFraction, 0)}-os hányad, max. ${pct(s.kellyCap, 0)} a bankrollból.</p>
          </form></section>
      </div>
      <section class="card" style="margin-top:16px"><h2>Egyenleg alakulása</h2>
        ${v.series.length > 1 ? lineChart({ title: 'Egyenleg', labels: v.series.map((p) => date(p.t)), series: [{ name: 'Egyenleg', color: 'var(--ink)', values: v.series.map((p) => p.balance) }], yFmt: (x) => num(x, 0) }) : '<p class="muted">Az elszámolt fogadások után itt látod az egyenleg alakulását.</p>'}</section>
      <h2 style="margin:22px 0 10px">Fogadásaid</h2>
      ${v.bets.length ? betsTable(v.bets) : '<div class="empty"><h3>Még nincs rögzített fogadás</h3><p>Rögzítsd a saját fogadásaidat a fenti űrlappal, vagy egy meccs adatlapjáról a „Rögzítés a bankrollban” gombbal.</p></div>'}
      <details class="card" style="margin-top:16px"><summary><strong>Beállítások</strong> – kezdő bankroll és Kelly</summary>
        <form id="setForm" class="form-grid" style="margin-top:12px">
          <label class="field">Kezdő bankroll (Ft)<input type="number" name="bankrollStart" min="0" step="1000" value="${s.bankrollStart}"></label>
          <label class="field">Kelly-hányad<select name="kellyFraction">${[0.1, 0.2, 0.25, 0.33, 0.5].map((x) => `<option value="${x}" ${x === s.kellyFraction ? 'selected' : ''}>${pct(x, 0)}</option>`).join('')}</select></label>
          <label class="field">Tétplafon (bankroll %)<select name="kellyCap">${[0.01, 0.02, 0.03, 0.05, 0.1].map((x) => `<option value="${x}" ${x === s.kellyCap ? 'selected' : ''}>${pct(x, 0)}</option>`).join('')}</select></label>
          <button class="btn" type="submit">Mentés</button></form></details>`;
  }

  function betsTable(bets) {
    return `<div class="tbl-wrap"><table class="tbl stack"><caption class="sr-only">Fogadások</caption><thead><tr><th scope="col">Dátum</th><th scope="col">Leírás</th><th scope="col" class="r">Szorzó</th><th scope="col" class="r">Tét</th><th scope="col">Eredmény</th><th scope="col" class="r">Nyereség</th><th scope="col" class="r">Egyenleg</th><th scope="col">Műveletek</th></tr></thead><tbody>
      ${bets.map((x) => `<tr><td data-label="Dátum" class="span2">${date(x.createdAt)} ${time(x.createdAt)}</td><td class="full">${esc(x.description)}${x.tipId ? '<div class="small muted">modelltipphez kötve – automatikusan elszámolódik</div>' : ''}</td>
        <td class="r num" data-label="Szorzó">${odds(x.odds)}</td><td class="r num" data-label="Tét">${huf(x.stake)}</td><td data-label="Eredmény">${RESULT_HU[x.status]}</td>
        <td class="r num ${evClass(x.profit)}" data-label="Nyereség">${x.status === 'pending' ? '–' : huf(x.profit)}</td><td class="r num" data-label="Egyenleg">${huf(x.runningBalance)}</td>
        <td class="full"><div style="display:flex;gap:4px;flex-wrap:wrap">${x.status === 'pending' ? `<button class="btn btn-small" data-settle="won" data-id="${x.id}">Nyert</button><button class="btn btn-small" data-settle="lost" data-id="${x.id}">Veszített</button><button class="btn btn-small" data-settle="void" data-id="${x.id}">Érvénytelen</button>` : `<button class="btn btn-small" data-settle="pending" data-id="${x.id}">Visszanyitás</button>`}<button class="btn btn-small" data-del="${x.id}" aria-label="Törlés: ${esc(x.description)}">Törlés</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      if (e.target.id === 'betForm') {
        const stake = Number(f.get('stake'));
        const max = Number(e.target.querySelector('[name=stake]').max);
        if (stake > max) { toast(`A tét meghaladja a jelenlegi keretedet (${huf(max)}).`, 'err'); return; }
        v = await api('/api/bankroll/bets', { method: 'POST', body: { description: f.get('description'), odds: String(f.get('odds')).replace(',', '.'), stake, sport: f.get('sport'), p: f.get('p') ? Number(f.get('p')) / 100 : null } });
        limitsInfo = await api('/api/limits'); draw(); toast('Fogadás rögzítve.');
      } else if (e.target.id === 'setForm') {
        const r = await api('/api/settings', { method: 'PUT', body: { bankrollStart: Number(f.get('bankrollStart')), kellyFraction: Number(f.get('kellyFraction')), kellyCap: Number(f.get('kellyCap')) } });
        await load(); toast(r.notes?.[0] || 'Beállítások mentve.');
      }
    } catch (err) { toast(err.message, 'err'); }
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    try {
      if (t.dataset.settle) { v = await api(`/api/bankroll/bets/${t.dataset.id}/settle`, { method: 'POST', body: { status: t.dataset.settle } }); limitsInfo = await api('/api/limits'); draw(); }
      else if (t.dataset.del) { if (!confirm('Biztosan törlöd ezt a fogadást?')) return; v = await api(`/api/bankroll/bets/${t.dataset.del}`, { method: 'DELETE' }); draw(); }
      else if (t.id === 'kellyBtn') {
        const form = el.querySelector('#betForm');
        const o = Number(String(form.odds.value).replace(',', '.')); const p = Number(form.p.value) / 100;
        const out = el.querySelector('#kellyOut');
        if (!(o > 1) || !(p > 0 && p < 1)) { out.textContent = 'Add meg a szorzót és a becsült esélyt a Kelly-javaslathoz.'; return; }
        const k = await api(`/api/kelly?p=${p}&odds=${o}`);
        if (k.stake > 0) { form.stake.value = k.stake; out.textContent = `Javasolt tét: ${huf(k.stake)} (teljes Kelly ${pct(k.fullKelly)}, alkalmazott ${pct(k.share)} a bankrollból${k.capped ? ', plafon miatt csökkentve' : ''}${k.limited ? ', korlát miatt csökkentve' : ''}).`; }
        else out.textContent = `Ezen a szorzón nincs pozitív várható érték (EV ${num((p * o - 1) * 100, 1)}%), a Kelly-kritérium szerint ne tégy.`;
      }
    } catch (err) { toast(err.message, 'err'); }
  });

  await load();
}
