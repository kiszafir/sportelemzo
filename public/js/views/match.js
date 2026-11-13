// Match detail: tip with reasoning, all markets (model vs market, manual odds),
// factor breakdown with freshness, live panel, odds movement.
import { api } from '../api.js';
import { ICON } from '../icons.js';
import { esc, time, timeS, date, odds, pct, signedPct, num, evClass, badge, statusPill, conf, huf, SPORT_HU, ago } from '../format.js';
import { sparkline } from '../charts.js';

export async function render(el, { id }, { live, toast }) {
  let d = null; let kelly = null;

  async function load(silent) {
    if (!silent) el.innerHTML = `<a class="btn btn-small" href="#/">${ICON.back} Vissza</a><div style="margin-top:16px" class="skeleton" aria-busy="true" role="status" aria-label="Betöltés"><div style="height:160px"></div></div>`;
    try {
      d = await api('/api/matches/' + encodeURIComponent(id));
      kelly = null;
      if (d.tip && d.tip.oddsSource !== 'estimated') kelly = await api(`/api/kelly?p=${d.tip.p}&odds=${d.tip.odds}`).catch(() => null);
      draw();
    } catch (e) {
      el.innerHTML = `<a class="btn btn-small" href="#/">${ICON.back} Vissza</a><div class="error-box" style="margin-top:16px" role="alert"><h3>A meccs nem tölthető be</h3><p>${esc(e.message)}</p><a class="btn" href="#/">Vissza a listához</a></div>`;
    }
  }

  function draw() {
    const m = d.match; const a = d.analysis; const t = d.tip;
    const focusedId = document.activeElement?.dataset?.oddsKey;
    el.innerHTML = `
      <a class="btn btn-small" href="#/">${ICON.back} Vissza a meccsekhez</a>
      <div class="page-head" style="margin-top:14px"><div><h1>${esc(m.home.name)} – ${esc(m.away.name)}</h1>
        <p>${esc(m.leagueName)} · ${SPORT_HU[m.sport]} · ${date(m.startTime)} ${time(m.startTime)}${m.venue?.name ? ' · ' + esc(m.venue.name) : ''}${m.surface ? ' · ' + esc(m.surface) : ''}</p></div>
        <div class="toolbar" style="margin:0">${badge(m.dataStatus, m.fetchedAt)}<span class="updated">Frissítve: ${timeS(m.fetchedAt)}</span></div></div>
      ${scoreboard(m)}
      ${t ? tipCard(t, a) : `<div class="notice">${m.status === 'post' ? 'A meccs véget ért; ajánlás nem készül, az eredmény a tippnaplóban szerepel.' : 'Ehhez a meccshez nincs ajánlás.'}</div>`}
      ${m.live ? livePanel(m) : ''}
      <h2 style="margin:22px 0 10px">Piacok: modell kontra piac</h2>
      <p class="muted small">A legjobb elérhető szorzó kiemelve. Ha nincs piaci szorzó, add meg a sajátodat – az érték azonnal újraszámolódik. Árrés nélküli valószínűség: Shin-módszer.</p>
      ${marketsTable(a, d.manualOdds)}
      <div class="grid-2" style="margin-top:22px">
        <section class="card"><div class="panel-title"><h2>Modellek</h2><span class="muted small">adatlefedettség ${pct(a.coverage, 0)}</span></div>${modelsBox(a, m)}</section>
        <section class="card"><div class="panel-title"><h2>Piaci mozgás</h2></div>${movementBox(d, a)}</section>
      </div>
      <h2 style="margin:22px 0 10px">Tényezők és adatfrissesség</h2>
      ${factorsTable(a, m)}`;
    if (focusedId) el.querySelector(`[data-odds-key="${CSS.escape(focusedId)}"]`)?.focus();
  }

  function scoreboard(m) {
    const sets = m.sport === 'tennis' && (m.setScores || m.live?.setScores) ? `<div class="clock">Szettek: ${esc(m.setScores || m.live?.setScores)}</div>` : '';
    return `<section class="scoreboard" aria-label="Eredményjelző">
      <div class="side home"><span class="muted small">${m.sport === 'tennis' ? '1. játékos' : 'Hazai'}</span><span class="tname">${esc(m.home.name)}</span></div>
      <div><div class="big" aria-label="Állás">${m.home.score ?? '–'} : ${m.away.score ?? '–'}</div>
        <div class="clock">${statusPill(m)} ${esc(m.status === 'pre' ? time(m.startTime) : m.live?.clock || m.statusText || '')}</div>${sets}</div>
      <div class="side away"><span class="muted small">${m.sport === 'tennis' ? '2. játékos' : 'Vendég'}</span><span class="tname">${esc(m.away.name)}</span></div>
    </section>`;
  }

  function tipCard(t, a) {
    const k = kelly && kelly.stake > 0
      ? `<div class="small" style="margin-top:10px"><strong>Javasolt tét:</strong> <span class="num">${huf(kelly.stake)}</span> (${pct(kelly.fraction, 0)} Kelly, max. ${pct(kelly.cap, 0)} a bankrollból${kelly.limited ? ', a korlátaid miatt csökkentve' : ''}${kelly.capped ? ', plafon miatt csökkentve' : ''}) <button class="btn btn-small" id="addBet" type="button">Rögzítés a bankrollban</button></div>`
      : `<div class="small muted" style="margin-top:10px">${t.oddsSource === 'estimated' ? 'Tétjavaslat csak valós vagy kézi szorzóval készül.' : 'A Kelly-kritérium szerint ezen a szorzón nem javasolt tét (nincs pozitív érték), vagy elérted a korlátodat.'}</div>`;
    return `<section class="card tip-hero ${t.kind === 'value' ? '' : 'safe'}" aria-label="Ajánlás">
      <div class="tip-line"><span class="kind ${t.kind}">${esc(t.kindLabel)} · ${esc(t.betType)}</span>${conf(t.confidence)}${t.pRaw != null ? '<a class="badge b-manual" href="#/ai-motor" title="Az AI-motor kalibrálta ezt a becslést">AI-KORRIGÁLT</a>' : ''}</div>
      <div class="tip-line" style="margin-top:4px"><span class="tip-title">${esc(t.name)}</span><span class="odds" style="font-size:1.6rem;color:var(--amber)">${odds(t.odds)}</span>${badge(t.oddsSource)}</div>
      <div class="tip-line small" style="margin-top:6px">
        <span>Modell: <strong class="num">${pct(t.p)}</strong></span><span>Méltányos szorzó: <strong class="num">${odds(t.fair)}</strong></span>
        <span>Piac árrés nélkül: <strong class="num">${pct(t.novig)}</strong></span><span>Előny: <strong class="num ${evClass(t.edge)}">${signedPct(t.edge)}</strong></span>
        <span>EV: <strong class="num ${evClass(t.ev)}">${signedPct(t.ev)}</strong></span></div>
      <p class="reason">${esc(t.reasoning)}</p>
      ${t.topFactors?.length ? `<div class="small muted">Fő tényezők</div><div class="factor-chips">${t.topFactors.map((f) => `<span class="factor-chip">${esc(f.label)} <span class="num">${f.impact > 0 ? '+' : ''}${num(f.impact, 2)}</span></span>`).join('')}</div>` : ''}
      ${k}
    </section>`;
  }

  function livePanel(m) {
    const L = m.live; const cells = [];
    const pair = (l, h, a2, f = (x) => x) => cells.push(`<div class="live-stat"><div class="l">${l}</div><div class="v">${f(h)} – ${f(a2)}</div></div>`);
    if (L.possession) pair('Labdabirtoklás', L.possession.home, L.possession.away, (x) => pct(x, 0));
    if (L.cards) pair('Lapok (sárga/piros)', `${L.cards.home.y}/${L.cards.home.r}`, `${L.cards.away.y}/${L.cards.away.r}`);
    else if (L.redCards) pair('Piros lapok', L.redCards.home, L.redCards.away);
    if (L.fouls && L.fouls.home != null) pair('Szabálytalanságok', L.fouls.home, L.fouls.away);
    if (L.timeouts) pair('Hátralévő időkérések', L.timeouts.home, L.timeouts.away);
    if (L.shots) pair('Kapura lövések', L.shots.home, L.shots.away);
    if (L.suspensions) pair('Kiállítások (2 perc)', L.suspensions.home, L.suspensions.away);
    if (L.setScores) cells.push(`<div class="live-stat"><div class="l">Szettek</div><div class="v">${esc(L.setScores)}</div></div>`);
    if (L.momentum != null) cells.push(`<div class="live-stat"><div class="l">Lendület</div><div class="v">${L.momentum > 0.15 ? esc(m.home.name) : L.momentum < -0.15 ? esc(m.away.name) : 'kiegyenlített'}</div></div>`);
    return `<section class="card" style="margin-top:16px" aria-label="Élő adatok"><div class="panel-title"><h2>Élő tényezők</h2>${badge(m.meta?.live?.status || m.dataStatus, m.meta?.live?.fetchedAt)}</div>
      <div class="live-grid">${cells.join('') || '<span class="muted">A szolgáltató nem ad élő részstatisztikát.</span>'}</div></section>`;
  }

  function marketsTable(a, manual) {
    const rows = a.markets.map((mk) => {
      const head = `<tr class="mk-head"><td colspan="9">${esc(mk.label)}${mk.overround != null ? ` <span class="muted small">· árrés ${pct(mk.overround)}</span>` : ''}</td></tr>`;
      return head + mk.selections.map((s) => {
        const quotes = s.market?.quotes || [];
        const best = s.market?.best;
        const mkey = `${mk.key}:${s.key}`;
        const title = quotes.map((q) => `${q.book}: ${q.odds}`).join(', ');
        return `<tr>
          <td>${esc(s.name)}</td>
          <td class="r num">${pct(s.p)}${s.pRaw != null ? `<div class="small muted" title="Nyers modellbecslés az AI-korrekció előtt">nyers ${pct(s.pRaw)}</div>` : ''}</td>
          <td class="r num">${odds(s.fair)}</td>
          <td class="r" title="${esc(title)}">${best ? `<span class="best num">${odds(best)}</span> <span class="muted small">${esc(s.market.book)}</span> ${badge(s.market.src)}` : '<span class="muted small">nincs</span>'}</td>
          <td class="r num">${pct(s.novig)}</td>
          ${s.decided ? '<td class="r muted small" colspan="3">gyakorlatilag eldőlt</td>' : `<td class="r num ${evClass(s.edge)}">${signedPct(s.edge)}</td>
          <td class="r num ${evClass(s.ev)}">${signedPct(s.ev)} ${s.oddsSource === 'estimated' ? badge('estimated') : s.oddsSource === 'manual' ? badge('manual') : ''}</td>
          <td class="r num">${pct(s.kelly)}</td>`}
          <td class="r"><label class="sr-only" for="o-${esc(mkey)}">Saját szorzó: ${esc(s.name)}</label><input class="odds-input" id="o-${esc(mkey)}" data-odds-key="${esc(mkey)}" data-market="${esc(mk.key)}" data-sel="${esc(s.key)}" type="text" inputmode="decimal" placeholder="pl. 1,85" value="${manual[mkey] ? String(manual[mkey]).replace('.', ',') : ''}"></td>
        </tr>`;
      }).join('');
    }).join('');
    return `<div class="tbl-wrap"><table class="tbl"><caption class="sr-only">Piacok összehasonlítása</caption><thead><tr>
      <th scope="col">Kimenetel</th><th scope="col" class="r">Modell</th><th scope="col" class="r">Méltányos</th><th scope="col" class="r">Legjobb piaci</th>
      <th scope="col" class="r">Piac árrés nélkül</th><th scope="col" class="r" title="Modell − piac (árrés nélkül)">Előny</th><th scope="col" class="r">EV</th><th scope="col" class="r" title="Teljes Kelly-hányad">Kelly</th><th scope="col" class="r">Saját szorzó</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function modelsBox(a, m) {
    const md = a.models || {};
    const e = a.expected || {};
    const lines = [];
    lines.push(`<li>Súlyozott pontozás (alapmodell): hazai/1. játékos győzelem <strong class="num">${pct(md.weighted)}</strong></li>`);
    if (md.specific != null) lines.push(`<li>${esc(md.specificName)}${md.trained ? ' (újrabecsült)' : ''}: <strong class="num">${pct(md.specific)}</strong></li>`);
    if (m.sport === 'football' && e.lh) lines.push(`<li>Várható gólok (λ): <strong class="num">${num(e.lh)} – ${num(e.la)}</strong></li>`);
    if (m.sport === 'nhl' && e.total) lines.push(`<li>Várható gólszám: <strong class="num">${num(e.total)}</strong>${e.estimatedTotal ? ' (becsült)' : ''}</li>`);
    if (m.sport === 'nba' && e.total) lines.push(`<li>Várható különbség / összpontszám: <strong class="num">${num(e.margin, 1)} / ${num(e.total, 1)}</strong>${e.estimatedTotal ? ' (becsült)' : ''}</li>`);
    if (m.sport === 'handball' && e.total) lines.push(`<li>Várható különbség / gólszám: <strong class="num">${num(e.margin, 1)} / ${num(e.total, 1)}</strong>${e.estimatedTotal ? ' (becsült)' : ''}</li>`);
    if (m.sport === 'tennis' && e.setProb) lines.push(`<li>Szettnyerési esély (1. játékos): <strong class="num">${pct(e.setProb)}</strong>${e.elo ? ` · Elo ${e.elo.e1} – ${e.elo.e2}` : ''}</li>`);
    if (m.weather) lines.push(`<li>Időjárás: ${esc(m.weather.desc)}, ${num(m.weather.tempC, 0)} °C, szél ${num(m.weather.windKmh, 0)} km/h, csapadék ${num(m.weather.precipMm, 1)} mm ${badge(m.weather.src === 'mock' ? 'mock' : m.weather.status, m.weather.fetchedAt)}</li>`);
    if (m.venue?.altitude > 1000) lines.push(`<li>Tengerszint feletti magasság: ${num(m.venue.altitude, 0)} m</li>`);
    for (const n of a.notes || []) lines.push(`<li>${esc(n)}</li>`);
    return `<ul style="margin:0;padding-left:1.1em">${lines.join('')}</ul><p class="small muted" style="margin-top:8px">A végső valószínűség a sportágspecifikus modell (60%) és a súlyozott alapmodell (40%) keveréke. Részletek: <a href="#/modszertan">Módszertan</a>.</p>`;
  }

  function movementBox(d2, a) {
    const hist = Object.entries(d2.oddsHistory || {})[0];
    const mv = d2.match.movement;
    if (!hist && !mv) return '<p class="muted">Még nincs elég szorzóadat a mozgás követéséhez. Élő szorzóforrás (pl. The Odds API kulcs) esetén a nyitó és aktuális ár itt jelenik meg.</p>';
    const pts = hist ? hist[1] : [];
    const sel = a.markets[0].selections[0];
    return `<p>${esc(sel.name)}: nyitó <strong class="num">${odds(mv?.homeOpen ?? pts[0]?.odds)}</strong> → aktuális <strong class="num">${odds(mv?.homeNow ?? pts[pts.length - 1]?.odds)}</strong>
      ${mv ? `<span class="${mv.homeNow < mv.homeOpen ? 'ev-pos' : 'ev-neg'}">(${mv.homeNow < mv.homeOpen ? 'rövidült – a piac erősebbnek látja' : mv.homeNow > mv.homeOpen ? 'nyúlt – a piac gyengébbnek látja' : 'változatlan'})</span>` : ''}</p>
      ${pts.length > 1 ? sparkline(pts.map((p) => p.odds), { label: 'Szorzó alakulása' }) : ''}
      ${pts.length ? `<p class="small muted">Mérési pontok: ${pts.map((p) => `${time(p.t)} → ${odds(p.odds)}`).join(' · ')}</p>` : ''}`;
  }

  function factorsTable(a, m) {
    const maxAbs = Math.max(0.01, ...a.factors.filter((f) => f.available).map((f) => Math.abs(f.diff * f.weight)));
    const rows = a.factors.map((f) => {
      const w = Math.min(100, (Math.abs(f.diff * f.weight) / maxAbs) * 100);
      const dir = f.diff >= 0 ? 'h' : 'a';
      const src = f.src ? `${badge(f.src.status, f.src.fetchedAt)} <span class="muted small">${esc(f.src.src || '')}${f.src.fetchedAt ? ' · ' + ago(f.src.fetchedAt) : ''}</span>` : badge(null);
      let extra = '';
      if (f.key === 'injuries' && f.extra) extra = ['home', 'away'].map((s) => (f.extra[s] || []).map((i) => `${esc(i.name)} (${esc(i.type)}, ${esc(i.status)})`).join(', ')).map((x, i) => (x ? `<div class="small muted">${i ? esc(m.away.name) : esc(m.home.name)}: ${x}</div>` : '')).join('');
      if (f.key === 'form' && f.extra) extra = `<div class="small muted">Utolsó 5: ${esc(f.extra.home)} / ${esc(f.extra.away)} (régebbitől az újabbig)</div>`;
      if (f.key === 'goalie' && f.extra) extra = `<div class="small muted">${esc(f.extra.homeGoalie || '?')} ${f.extra.homeConfirmed ? '(megerősítve)' : '(nem megerősített)'} / ${esc(f.extra.awayGoalie || '?')} ${f.extra.awayConfirmed ? '(megerősítve)' : '(nem megerősített)'}</div>`;
      if (f.key === 'motivation' && f.extra) extra = `<div class="small muted">${esc(f.extra.home || '')} / ${esc(f.extra.away || '')}</div>`;
      if (f.key === 'h2h' && f.extra) extra = `<div class="small muted">${f.extra.n} meccs, ${f.extra.draws} döntetlen</div>`;
      return `<tr>
        <td>${esc(f.label)}${extra}</td>
        <td class="r num">${f.available ? esc(f.home) : '<span class="muted">–</span>'}</td>
        <td class="r num">${f.available ? esc(f.away) : '<span class="muted">–</span>'}</td>
        <td class="r num">${num(f.weight, 2)}</td>
        <td>${f.available ? `<div class="contrib" title="${f.diff >= 0 ? 'Hazai' : 'Vendég'} irányba hat"><span class="bar ${dir}" style="width:${w.toFixed(0)}%"></span><span class="small muted">${f.diff >= 0 ? 'hazai' : 'vendég'}</span></div>` : '<span class="muted small">nem elérhető</span>'}</td>
        <td>${src}</td></tr>`;
    }).join('');
    return `<div class="tbl-wrap"><table class="tbl"><caption class="sr-only">Tényezők</caption><thead><tr><th scope="col">Tényező</th><th scope="col" class="r">${m.sport === 'tennis' ? '1. játékos' : 'Hazai'}</th><th scope="col" class="r">${m.sport === 'tennis' ? '2. játékos' : 'Vendég'}</th><th scope="col" class="r">Súly</th><th scope="col">Hatás</th><th scope="col">Forrás, frissesség</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  el.addEventListener('change', async (e) => {
    const inp = e.target.closest('.odds-input'); if (!inp) return;
    const raw = inp.value.trim().replace(',', '.');
    if (raw && !(Number(raw) > 1)) { toast('A szorzónak 1-nél nagyobb számnak kell lennie (pl. 1,85).', 'err'); inp.focus(); return; }
    try {
      d = await api(`/api/matches/${encodeURIComponent(id)}/odds`, { method: 'POST', body: { market: inp.dataset.market, selection: inp.dataset.sel, odds: raw || null } });
      kelly = d.tip && d.tip.oddsSource !== 'estimated' ? await api(`/api/kelly?p=${d.tip.p}&odds=${d.tip.odds}`).catch(() => null) : null;
      draw(); toast(raw ? 'Saját szorzó mentve, az érték újraszámolva.' : 'Saját szorzó törölve.');
    } catch (err) { toast(err.message, 'err'); }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.id !== 'addBet') return;
    const t = d.tip;
    try {
      await api('/api/bankroll/bets', { method: 'POST', body: { description: `${d.match.home.name} – ${d.match.away.name}: ${t.name}`, odds: t.odds, stake: kelly.stake, sport: d.match.sport, market: t.betType, p: t.p, tipId: `tip-${d.match.id}` } });
      toast('Rögzítve a bankrollban. Az eredmény a meccs végén automatikusan elszámolódik.');
    } catch (err) { toast(err.message, 'err'); }
  });

  const onLive = () => { if (!el.contains(document.activeElement) || !document.activeElement.classList.contains('odds-input')) load(true); };
  live.listeners.add(onLive);
  await load(false);
  return () => live.listeners.delete(onLive);
}
