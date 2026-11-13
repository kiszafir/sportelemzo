// Bet builders: "Könnyű" (≤ 10.00) and "Brutális" (≥ 70.00) accumulators.
import { api } from '../api.js';
import { ICON } from '../icons.js';
import { esc, odds, pct, signedPct, evClass, badge, timeS, time, relDay, huf, RISK_HU, SPORT_HU, num } from '../format.js';

const dayLabel = (day, today) => {
  const d = (k) => Date.UTC(...k.split('-').map((x, i) => (i === 1 ? x - 1 : +x)));
  const off = Math.round((d(day) - d(today)) / 864e5);
  const named = off === 0 ? 'Ma' : off === 1 ? 'Holnap' : off === 2 ? 'Holnapután' : off === -1 ? 'Tegnap' : '';
  const nice = new Intl.DateTimeFormat('hu-HU', { timeZone: 'UTC', month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(d(day)));
  return named ? `${named} · ${nice}` : nice;
};

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export async function render(el, { mode }, { toast }) {
  const brutal = mode === 'brutal';
  const st = { seed: Number(sessionStorage.getItem('seed:' + mode)) || 1, locked: store.get('locked:' + mode, []), day: sessionStorage.getItem('day:' + mode) || '', markets: store.get('markets:' + mode, []), data: null, error: null, loading: true, stakes: {} };

  const intro = brutal
    ? `<div class="brutal-zone"><div class="page-head" style="margin:6px 0 0"><div><h1>Brutális mix</h1><p class="muted">Legalább 70,00-es eredő szorzó, az összes sportágból, élő tételekkel ahol lehet.</p></div>
        <div class="toolbar" style="margin:0"><button class="btn btn-brutal" id="regen" type="button">${ICON.dice} Újragenerálás</button><button class="btn" id="unlockAll" type="button" style="background:transparent;color:#fff;border-color:#6b3249">Rögzítések törlése</button></div></div>
        <div class="brutal-warning" role="alert">${ICON.warn}<div>Nagyon magas kockázat. Ezek a szelvények a legtöbbször veszítenek: a becsült nyerési esély jellemzően 1–3% alatti. Szórakozásnak tekintsd, csak olyan összeggel, amelynek az elvesztését megengedheted magadnak.</div></div>
        <div id="out"></div></div>`
    : `<div class="page-head"><div><h1>Könnyű mix</h1><p>2–6 tételes szelvények, legfeljebb 10,00-es eredő szorzóval, nagy valószínűségű tételekből.</p></div>
        <div class="toolbar" style="margin:0"><button class="btn btn-easy" id="regen" type="button">${ICON.dice} Újragenerálás</button><button class="btn" id="unlockAll" type="button">Rögzítések törlése</button></div></div>
        <div class="notice">Tipp: a lakat ikonnal rögzíthetsz egy tételt – az újragenerálás megtartja, és csak a többit cseréli. A tételek egymástól független meccsekről származnak.</div>
        <div id="out"></div>`;
  el.innerHTML = intro;
  const out = el.querySelector('#out');

  async function load() {
    st.loading = true; draw();
    try {
      const q = new URLSearchParams({ seed: st.seed, locked: st.locked.join(','), day: st.day, markets: st.markets.join(',') });
      st.data = await api(`/api/combos/${mode}?${q}`); st.error = null;
      if (st.data.day && st.data.day !== st.day) { st.day = st.data.day; sessionStorage.setItem('day:' + mode, st.day); }
      // Drop locks that no longer exist.
      const ids = new Set(st.data.tickets.flatMap((t) => t.legs.map((l) => l.id)));
      if (st.locked.some((id) => !ids.has(id)) && st.data.tickets.length) { st.locked = st.locked.filter((id) => ids.has(id)); store.set('locked:' + mode, st.locked); }
      st.stakes = {};
      await Promise.all(st.data.tickets.map(async (t) => {
        if (t.ev > 0) st.stakes[t.id] = await api(`/api/kelly?p=${t.p}&odds=${t.odds}`).catch(() => null);
      }));
    } catch (e) { st.error = e.message; }
    st.loading = false; draw();
  }

  function draw() {
    if (st.loading && !st.data) { out.innerHTML = `<div class="tickets" aria-busy="true">${'<div class="skeleton" style="height:320px;border-radius:16px"></div>'.repeat(3)}</div>`; return; }
    if (st.error) { out.innerHTML = `<div class="error-box" role="alert"><h3>Nem sikerült szelvényt generálni</h3><p>${esc(st.error)}</p><button class="btn" id="retry">Újrapróbálás</button></div>`; return; }
    const d = st.data;
    const warn = d.warnings.length ? `<div class="notice warn" role="status">${d.warnings.map(esc).join('<br>')}</div>` : '';
    const days = (d.days || []).length ? `<div class="toolbar"><div class="seg" role="group" aria-label="Nap kiválasztása">${d.days.map((x) => `<button type="button" data-day="${x.day}" aria-pressed="${x.day === d.day}" title="${x.matches} meccs, ${x.sports.length} sportág">${esc(dayLabel(x.day, d.today))} <span class="muted small">(${x.matches})</span></button>`).join('')}</div><span class="small ${brutal ? 'muted' : 'muted'}">Egy szelvény minden meccse ugyanazon a napon van.</span></div>` : '';
    const groups = d.marketGroups || [];
    const filt = groups.length ? `<div class="toolbar"><span class="small ${brutal ? 'muted' : 'muted'}">Piacok:</span><div class="chips" role="group" aria-label="Piactípusok a szelvényen">
      <button class="chip" type="button" data-mk="all" aria-pressed="${!st.markets.length}">Mind</button>
      ${groups.map((g) => `<button class="chip" type="button" data-mk="${g.id}" aria-pressed="${st.markets.includes(g.id)}">${esc(g.label)}</button>`).join('')}</div></div>` : '';
    const info = `<p class="small muted">${d.realOnly ? '<strong>Csak valós meccsek</strong> · ' : '<strong>Demó mód: mintameccsekből</strong> · '}${d.candidates} jelölt tétel · ${d.sportsAvailable.map((s) => SPORT_HU[s]).join(', ') || '–'} · állapot: ${d.lastUpdate ? timeS(d.lastUpdate) : '–'} · változat #${st.seed}</p>`;
    if (!d.tickets.length) { out.innerHTML = days + filt + warn + `<div class="empty"><h3>Nincs szelvény</h3><p>A jelenlegi kínálatból nem állt össze a feltételeknek megfelelő kombináció.</p><button class="btn" id="regen2">Újrapróbálás más változattal</button></div>`; return; }
    out.innerHTML = days + filt + warn + info + `<div class="tickets">${d.tickets.map(ticket).join('')}</div>`;
  }

  function ticket(t) {
    const legs = t.legs.map((l) => {
      const locked = st.locked.includes(l.id);
      return `<li class="leg">
        <button class="lock" type="button" data-lock="${esc(l.id)}" aria-pressed="${locked}" aria-label="${locked ? 'Rögzítés feloldása' : 'Tétel rögzítése'}: ${esc(l.name)}" title="${locked ? 'Rögzítve' : 'Rögzítés'}">${locked ? ICON.lock : ICON.unlock}</button>
        <div><div class="lname">${esc(l.name)}</div>
          <div class="lmeta">${esc(l.matchName)} · ${esc(l.leagueName)} · ${l.status === 'live' ? `<span class="badge b-live">ÉLŐ</span> ${esc(l.statusText || '')}` : `${relDay(l.startTime)} ${time(l.startTime)}`}</div>
          <div class="lmeta">${esc(l.marketLabel)} · modell ${pct(l.p, 0)} ${l.oddsSource !== 'live' ? badge(l.oddsSource) : ''}</div></div>
        <span class="lodds">${odds(l.odds)}</span></li>`;
    }).join('');
    const oneIn = t.p > 0 ? Math.round(1 / t.p) : null;
    const est = t.legs.filter((l) => l.oddsSource === 'estimated').length;
    const estNote = est ? `<div class="stake-hint small ${brutal ? '' : 'muted'}">${est} tétel BECSÜLT szorzóval szerepel (nincs rá fogadóirodai ár): a valódi szorzó eltérhet, ezért az eredő szorzó és az EV csak tájékoztató.</div>` : '';
    const starts = t.legs.map((l) => Date.parse(l.startTime));
    const span = `${relDay(Math.min(...starts))} ${time(Math.min(...starts))}–${time(Math.max(...starts))}`;
    const k = st.stakes[t.id];
    const stake = k && k.stake > 0 ? `<div class="stake-hint">Javasolt tét: <strong class="num">${huf(k.stake)}</strong> (${pct(k.fraction, 0)} Kelly, max. ${pct(k.cap, 0)}${k.limited ? ', korlát miatt csökkentve' : ''})</div>`
      : `<div class="stake-hint muted">A Kelly-kritérium szerint nem javasolt tét${t.ev > 0 ? ' (elérted a korlátodat)' : ' (nincs pozitív várható érték)'}.</div>`;
    if (brutal) {
      return `<article class="ticket brutal" aria-label="${esc(t.bucket)} szelvény, eredő szorzó ${odds(t.odds)}">
        <div class="ticket-warn" role="note">${ICON.warn.replace('<svg', '<svg style="width:16px;height:16px;vertical-align:-3px"')} Becsült esély: kb. 1 a ${oneIn ?? '∞'}-hoz. Valószínűleg veszít.</div>
        <div class="ticket-head"><div><div class="bucket">${esc(t.bucket)}</div><div class="small" style="color:#c9aab6">${t.legs.length} tétel · ${t.sports.map((s) => SPORT_HU[s]).join(', ')}</div><div class="small" style="color:#c9aab6">Kezdések: ${span}</div></div>
          <div class="ticket-odds">${odds(t.odds)}<small>eredő szorzó</small></div></div>
        <ul class="legs">${legs}</ul>
        <div style="padding:10px 16px"><div class="small" style="color:#c9aab6;display:flex;justify-content:space-between"><span>Diverzifikáció</span><span class="num">${t.diversification}/100</span></div><div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${t.diversification}" aria-label="Diverzifikációs pontszám"><span style="width:${t.diversification}%"></span></div>
          ${t.correlationPenalty > 0.05 ? `<div class="small" style="color:#ffc35a;margin-top:6px">Korrelációs büntetés: ${num(t.correlationPenalty, 2)} (azonos meccsről származó tételek)</div>` : ''}</div>
        <div class="ticket-foot"><div><div class="l">Becsült esély</div><div class="v">${pct(t.p, 2)}</div></div><div><div class="l">Várható érték</div><div class="v ${evClass(t.ev)}">${signedPct(t.ev)}</div></div><div><div class="l">Kockázat</div><div class="v">${t.risk}</div></div></div>
        ${estNote}${stake}
      </article>`;
    }
    return `<article class="ticket easy" aria-label="${esc(t.bucket)} szelvény, eredő szorzó ${odds(t.odds)}">
      <div class="ticket-head"><div><div class="bucket">${esc(t.bucket)}</div><div class="small muted">${t.legs.length} tétel · kezdések: ${span}</div><span class="risk risk-${t.risk}">${RISK_HU[t.risk]}</span></div>
        <div class="ticket-odds">${odds(t.odds)}<small>eredő szorzó</small></div></div>
      <ul class="legs">${legs}</ul>
      <div class="ticket-foot"><div><div class="l">Modell szerinti esély</div><div class="v">${pct(t.p, 1)}</div></div><div><div class="l">Várható érték</div><div class="v ${evClass(t.ev)}">${signedPct(t.ev)}</div></div><div><div class="l">Átl. bizalom</div><div class="v">${t.avgConfidence}</div></div></div>
      ${estNote}${stake}
    </article>`;
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.lock) {
      const id = b.dataset.lock;
      st.locked = st.locked.includes(id) ? st.locked.filter((x) => x !== id) : [...st.locked, id];
      store.set('locked:' + mode, st.locked);
      draw();
      toast(st.locked.includes(id) ? 'Tétel rögzítve. Az újragenerálás megtartja.' : 'Rögzítés feloldva.');
    } else if (b.id === 'regen' || b.id === 'regen2' || b.id === 'retry') {
      st.seed += 1; sessionStorage.setItem('seed:' + mode, String(st.seed)); load();
    } else if (b.dataset.mk) {
      const id = b.dataset.mk;
      st.markets = id === 'all' ? [] : st.markets.includes(id) ? st.markets.filter((x) => x !== id) : [...st.markets, id];
      store.set('markets:' + mode, st.markets); load();
    } else if (b.dataset.day) {
      st.day = b.dataset.day; sessionStorage.setItem('day:' + mode, st.day); load();
    } else if (b.id === 'unlockAll') {
      st.locked = []; store.set('locked:' + mode, []); load();
    }
  });

  await load();
}
