// Responsible gambling: self-set limits (enforced), session reminders, voluntary
// break, self-exclusion information and Hungarian help resources.
import { api } from '../api.js';
import { esc, huf } from '../format.js';

export async function render(el, _a, { toast, modal }) {
  el.innerHTML = `<div class="page-head"><div><h1>Felelős játék</h1><p>Korlátok, szünet és segítség. A korlátokat az alkalmazás be is tartatja: a bankrollban nem rögzíthetsz a korlát feletti tétet.</p></div></div><div id="rg"></div>`;
  const root = el.querySelector('#rg');
  let info = null;

  async function load() {
    try { info = await api('/api/limits'); draw(); }
    catch (e) { root.innerHTML = `<div class="error-box" role="alert"><h3>Nem sikerült betölteni</h3><p>${esc(e.message)}</p></div>`; }
  }

  function draw() {
    const L = info.limits; const paused = info.selfPauseUntil && Date.now() < info.selfPauseUntil;
    root.innerHTML = `
      <div class="grid-2">
        <section class="card"><h2 style="margin-bottom:6px">Tét- és veszteségkorlátok</h2>
          <p class="small muted">A csökkentés azonnal érvényes. Az emelés 24 óra türelmi idő után lép életbe, hogy egy rossz pillanatban hozott döntést átgondolhass.</p>
          <form id="limForm" class="form-grid">
            <label class="field">Napi tétkorlát (Ft)<input type="number" min="0" step="500" name="dailyStake" value="${L.dailyStake}"></label>
            <label class="field">Heti tétkorlát (Ft)<input type="number" min="0" step="500" name="weeklyStake" value="${L.weeklyStake}"></label>
            <label class="field">Napi veszteségkorlát (Ft)<input type="number" min="0" step="500" name="dailyLoss" value="${L.dailyLoss}"></label>
            <label class="field">Heti veszteségkorlát (Ft)<input type="number" min="0" step="500" name="weeklyLoss" value="${L.weeklyLoss}"></label>
            <label class="field">Munkamenet-emlékeztető (perc)<input type="number" min="5" max="240" step="5" name="sessionReminderMin" value="${L.sessionReminderMin}"></label>
            <button class="btn btn-primary" type="submit">Korlátok mentése</button>
          </form>
          ${info.pending ? `<p class="notice warn" style="margin-top:12px">Függő emelés: ${Object.entries(info.pending.values).map(([k, x]) => `${{ dailyStake: 'napi tét', weeklyStake: 'heti tét', dailyLoss: 'napi veszteség', weeklyLoss: 'heti veszteség' }[k]} → ${huf(x)}`).join(', ')}; érvényes ${new Date(info.pending.effectiveAt).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}-tól.</p>` : ''}
          <p class="small muted" style="margin-top:10px">Mai felhasználás: tét ${huf(info.usage.stakedToday)}, veszteség ${huf(info.usage.lossToday)}. Heti: tét ${huf(info.usage.stakedWeek)}, veszteség ${huf(info.usage.lossWeek)}.</p>
        </section>
        <section class="card"><h2 style="margin-bottom:6px">Szünet az alkalmazásban</h2>
          ${paused ? `<div class="notice danger" role="status">Önkéntes szünet érvényes eddig: <strong>${new Date(info.selfPauseUntil).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}</strong>. Addig nem rögzíthetsz tétet. A szünet nem rövidíthető le.</div>` : '<p>Ha úgy érzed, túl sok időt vagy pénzt fordítasz fogadásra, tarts szünetet. A szünet alatt a bankrollban nem rögzíthető új tét, és a szünet nem rövidíthető le.</p>'}
          <div class="toolbar"><button class="btn" data-pause="1">Szünet 24 órára</button><button class="btn" data-pause="7">Szünet 7 napra</button><button class="btn" data-pause="30">Szünet 30 napra</button></div>
          <h3 style="margin-top:14px">Önkizárás a szolgáltatóknál</h3>
          <p class="small">Ez az alkalmazás nem fogadóiroda, ezért valódi önkizárást itt nem lehet kérni. Magyarországon a szerencsejáték-szervezőknél <strong>jelentős önkorlátozó nyilatkozattal</strong> zárhatod ki magad a játékból vagy korlátozhatod a játékot; a Szerencsejáték Zrt.-nél ehhez a Játékoskártya és a játékosvédelmi eszközök is rendelkezésre állnak. Bírósági korlátozás esetén a játékosvédelmi nyilvántartás fokozott védelmet ad. A részletes tájékoztatót és a nyomtatványokat a szolgáltató felelős játékszervezési oldalán találod.</p>
        </section>
      </div>
      <h2 style="margin:24px 0 10px">Segítség – magyar források</h2>
      <div class="resources">
        <div class="resource"><h3>Szerencsejátékos Segélytelefon</h3><div class="phone">(06-80) 980-025</div><div class="small">vagy (06-1) 411-677 · hétköznap 15–19 óra · ingyenes, névtelen</div><p class="small muted">Az ELTE PPK és a Pro Psychologia Alapítvány közreműködésével. E-mail: <a href="mailto:szerencse@ppk.elte.hu">szerencse@ppk.elte.hu</a></p></div>
        <div class="resource"><h3>Lelki Elsősegély Telefonszolgálat</h3><div class="phone">116-123</div><div class="small">éjjel-nappal, ingyenes</div><p class="small muted">Ha bármilyen lelki krízisben azonnal beszélnél valakivel.</p></div>
        <div class="resource"><h3>Játékosvédelmi zöld szám</h3><div class="phone">(06-80) 205-352</div><div class="small">0–24 · ingyenes</div><p class="small muted">Bejelentések, panaszok és javaslatok a Szabályozott Tevékenységek Felügyeleti Hatósága (SZTFH) felé.</p></div>
        <div class="resource"><h3>Szerencsejáték Zrt. – felelős játékszervezés</h3><p class="small"><a href="https://rolunk.szerencsejatek.hu/hu/felelos-jatekszervezes" target="_blank" rel="noopener noreferrer">rolunk.szerencsejatek.hu/hu/felelos-jatekszervezes</a></p><p class="small"><a href="https://bet.szerencsejatek.hu/informaciok/a-jatekszenvedelyrol" target="_blank" rel="noopener noreferrer">A játékszenvedélyről – önkorlátozás, nyomtatványok</a></p></div>
        <div class="resource"><h3>Maradjon játék</h3><p class="small">Ismeretterjesztő oldal a felelős játékról.</p><p class="small"><a href="https://www.maradjonjatek.hu" target="_blank" rel="noopener noreferrer">maradjonjatek.hu</a></p></div>
        <div class="resource"><h3>Játékfüggőséggel foglalkozó szervezetek</h3><p class="small">Az SZTFH listája az ellátókról és szervezetekről.</p><p class="small"><a href="https://sztfh.hu/tevekenysegek/szerencsejatek-felugyelet/jatekosvedelem/jatekfuggoseggel-foglalkozo-szervezetek/" target="_blank" rel="noopener noreferrer">sztfh.hu – szervezetek listája</a></p></div>
      </div>
      <p class="small muted" style="margin-top:8px">Az elérhetőségek a szolgáltatók oldalain közzétett adatok alapján szerepelnek; a nyitvatartás változhat, ezért ellenőrizd a hivatalos oldalon.</p>
      <section class="card" style="margin-top:18px"><h2 style="margin-bottom:6px">Figyelmeztető jelek</h2>
        <ul style="margin:0;padding-left:1.1em;max-width:72ch">
          <li>A veszteségeidet újabb fogadással próbálod visszanyerni.</li>
          <li>Egyre nagyobb téttel fogadsz, hogy ugyanazt az izgalmat érezd.</li>
          <li>Eltitkolod a fogadást a családod vagy a barátaid elől.</li>
          <li>Kölcsönt veszel fel, vagy számlákat hagysz kifizetetlenül a fogadás miatt.</li>
          <li>Ingerült vagy nyugtalan leszel, ha nem tudsz fogadni.</li>
        </ul>
        <p class="small muted" style="margin-top:8px">Ha ezek közül bármelyik ismerős, hívd a segélytelefont – a beszélgetés ingyenes és névtelen.</p></section>`;
  }

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const limits = Object.fromEntries([...f.entries()].map(([k, x]) => [k, Number(x)]));
    try { const r = await api('/api/settings', { method: 'PUT', body: { limits } }); toast(r.notes?.[0] || 'Korlátok mentve.'); await load(); }
    catch (err) { toast(err.message, 'err'); }
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pause]'); if (!b) return;
    const days = Number(b.dataset.pause);
    modal(`<h2>Szünet ${days === 1 ? '24 órára' : days + ' napra'}?</h2><p>A szünet alatt nem rögzíthetsz új tétet, és a szünet nem rövidíthető le.</p>
      <div class="actions"><button class="btn btn-primary" id="pOk" autofocus>Igen, szünetet tartok</button><button class="btn" id="pNo">Mégsem</button></div>`,
    { label: 'Szünet megerősítése', onMount: (dlg, close) => {
      dlg.querySelector('#pNo').onclick = close;
      dlg.querySelector('#pOk').onclick = async () => { close(); try { await api('/api/selfpause', { method: 'POST', body: { days } }); toast('A szünet érvénybe lépett.'); load(); } catch (err) { toast(err.message, 'err'); } };
    } });
  });

  await load();
}
