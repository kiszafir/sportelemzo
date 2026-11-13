// Small dependency-free SVG charts (line, bar, sparkline) with an accessible
// text alternative (aria-label + data table in <details>).
import { esc } from './format.js';

const W = 520; const H = 250; const P = { l: 46, r: 12, t: 14, b: 34 };

function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / n; const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= step0) || step0;
  const lo = Math.floor(min / step) * step; const hi = Math.ceil(max / step) * step;
  const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10) || 0); // avoid "-0"
  return out;
}

function table(caption, head, rows) {
  return `<details class="data"><summary>Adatok táblázatban</summary><div class="tbl-wrap"><table class="tbl"><caption class="sr-only">${esc(caption)}</caption><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

/**
 * series: [{ name, color, values: (number|null)[], dash? }], labels: string[]
 */
export function lineChart({ title, labels, series, yFmt = (v) => v, yMin, yMax, zeroLine = false }) {
  const vals = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!vals.length || labels.length < 2) return `<p class="muted">Ehhez a nézethez még nincs elég adat.</p>`;
  const ticks = niceTicks(yMin ?? Math.min(...vals, zeroLine ? 0 : Infinity), yMax ?? Math.max(...vals, zeroLine ? 0 : -Infinity));
  const lo = ticks[0]; const hi = ticks[ticks.length - 1];
  const x = (i) => P.l + (i / (labels.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const grid = ticks.map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join('');
  const every = Math.ceil(labels.length / 8);
  const xl = labels.map((l, i) => (i % every === 0 || i === labels.length - 1 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${esc(l)}</text>` : '')).join('');
  const paths = series.map((s) => {
    let dstr = ''; let pen = false;
    s.values.forEach((v, i) => { if (!Number.isFinite(v)) { pen = false; return; } dstr += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    const dots = s.values.map((v, i) => (Number.isFinite(v) ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${s.color}"><title>${esc(labels[i])}: ${esc(yFmt(v))}</title></circle>` : '')).join('');
    return `<path d="${dstr}" fill="none" stroke="${s.color}" stroke-width="2.4" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>${s.dash ? '' : dots}`;
  }).join('');
  const zero = zeroLine && lo < 0 && hi > 0 ? `<line x1="${P.l}" x2="${W - P.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--ink)" stroke-width="1"/>` : '';
  const aria = `${title}: ${series.map((s) => `${s.name} ${yFmt(s.values.filter(Number.isFinite).slice(-1)[0])} (utolsó)`).join(', ')}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"><g class="grid">${grid}</g>${zero}${xl}${paths}</svg>
    <div class="chart-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
    ${table(title, ['Időszak', ...series.map((s) => s.name)], labels.map((l, i) => [l, ...series.map((s) => (Number.isFinite(s.values[i]) ? yFmt(s.values[i]) : '–'))]))}`;
}

/** Horizontal bar chart (HTML, so labels stay readable at any width).
 *  items: [{ label, value, sub?, ref? }] — ref draws a marker (e.g. expected rate). */
export function barChart({ title, items, fmt = (v) => v, max, color = 'var(--ink)', refLabel }) {
  if (!items.length) return `<p class="muted">Ehhez a nézethez még nincs elég adat.</p>`;
  const mx = max ?? Math.max(...items.map((i) => Math.max(i.value ?? 0, i.ref ?? 0)), 0.0001);
  const w = (v) => Math.max(0, Math.min(100, ((v ?? 0) / mx) * 100)).toFixed(1);
  const rows = items.map((it) => `<div class="hbar"><span class="hl" title="${esc(it.label)}">${esc(it.label)}</span>
    <div class="ht"><div class="hf" style="width:${w(it.value)}%;background:${color};opacity:.85"></div>${it.ref != null ? `<div class="hr" style="left:calc(${w(it.ref)}% - 1px)" title="${esc(refLabel || 'Referencia')}: ${esc(fmt(it.ref))}"></div>` : ''}</div>
    <span class="hv">${esc(fmt(it.value))}${it.sub ? ` <span class="muted small" style="font-weight:400">· ${esc(it.sub)}</span>` : ''}</span></div>`).join('');
  return `<div class="hbars" role="img" aria-label="${esc(title + ': ' + items.map((i) => `${i.label} ${fmt(i.value)}`).join(', '))}">${rows}</div>
    ${refLabel ? `<div class="chart-legend"><span><i style="background:${color}"></i>Tényleges</span><span><i style="background:var(--amber)"></i>${esc(refLabel)}</span></div>` : ''}
    ${table(title, ['Kategória', 'Érték', 'Megjegyzés'], items.map((i) => [i.label, fmt(i.value), i.sub || '']))}`;
}

export function sparkline(values, { label = 'Trend', w = 220, h = 44 } = {}) {
  const v = values.filter(Number.isFinite); if (v.length < 2) return '';
  const lo = Math.min(...v); const hi = Math.max(...v); const span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 4 - ((x - lo) / span) * (h - 8)).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}: ${v[0]} → ${v[v.length - 1]}"><polyline points="${pts}" fill="none" stroke="var(--amber)" stroke-width="2.2" stroke-linejoin="round"/></svg>`;
}
