// app.js — Mizan front-end. No frameworks, no CDNs: hand-rolled SVG charting,
// a tiny markdown renderer for the AI brief, and plain DOM state.
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  data: null,        // /api/bootstrap payload
  store: 'all',      // 'all' | store index
  selectedSi: null,  // sku index charted
  riskFilter: 'all', // all | risk | overstock
  aiBusy: false,
};

const fmt = {
  int: (n) => Math.round(n).toLocaleString('en-US'),
  sar: (n) => Math.round(n).toLocaleString('en-US'),
  pct: (n, dp = 0) => `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`,
  day: (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  },
};

/* ---------------- theme ---------------- */
(function initTheme() {
  const saved = localStorage.getItem('mizan-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('mizan-theme', next);
    if (state.data) renderChart(); // grid/line colors are CSS vars, but band gradient ids persist fine
  });
})();

/* ---------------- boot ---------------- */
async function loadData() {
  const q = state.store === 'all' ? '' : `?store=${state.store}`;
  const r = await fetch('/api/bootstrap' + q);
  state.data = await r.json();
  if (state.selectedSi == null || !state.data.rows[state.selectedSi]) {
    // default selection: the most urgent SKU (critical with soonest stockout), else first
    const sorted = [...state.data.rows].sort(rankSeverity);
    state.selectedSi = sorted[0].si;
  }
  renderAll();
}

function rankSeverity(a, b) {
  const order = { critical: 0, warning: 1, overstock: 2, healthy: 3 };
  const d = order[a.status] - order[b.status];
  if (d) return d;
  if (a.status === 'critical' || a.status === 'warning') return a.cover - b.cover;
  if (a.status === 'overstock') return b.overstockValue - a.overstockValue;
  return b.last30Revenue - a.last30Revenue;
}

function renderAll() {
  renderPills();
  renderKpis();
  renderChart();
  renderTable();
  renderMerch();
  renderAiStatus();
  $('#asOf').textContent = `data as of ${state.data.retailer.asOf}`;
  $('#footStamp').textContent = `${state.data.rows.length} SKUs · ${state.data.stores.length} branches · ${state.data.dates.length}d history · 21d horizon`;
}

/* ---------------- store pills ---------------- */
function renderPills() {
  const nav = $('#storePills');
  nav.innerHTML = '';
  const mk = (label, city, val) => {
    const b = document.createElement('button');
    b.className = 'pill' + (String(state.store) === String(val) ? ' is-on' : '');
    b.innerHTML = city ? `${label}<span class="pill-city">${city}</span>` : label;
    b.addEventListener('click', () => {
      if (String(state.store) === String(val)) return;
      state.store = val;
      loadData();
    });
    nav.appendChild(b);
  };
  mk('All branches', null, 'all');
  state.data.stores.forEach((s, i) => mk(s.name, s.city, i));
}

/* ---------------- KPIs ---------------- */
function renderKpis() {
  const k = state.data.kpis;
  const mom = k.revenuePrev30 > 0 ? ((k.revenue30 - k.revenuePrev30) / k.revenuePrev30) * 100 : 0;
  const tiles = [
    {
      label: '30-day revenue', value: `<span class="unit">SAR</span>${fmt.sar(k.revenue30)}`,
      delta: `${fmt.pct(mom, 1)} vs prior 30d`, cls: mom >= 0 ? 'up' : 'down',
    },
    {
      label: 'Next 14d forecast', value: `<span class="unit">SAR</span>${fmt.sar(k.forecast14Revenue)}`,
      delta: `${k.accuracy.toFixed(1)}% model accuracy`, cls: 'flat',
    },
    {
      label: 'SKUs at risk', value: `${k.atRisk}`, vcls: k.critical ? 'crit-val' : '',
      delta: `${k.critical} critical · ${k.atRisk - k.critical} warning`, cls: k.critical ? 'down' : 'flat',
    },
    {
      label: 'Suggested reorder', value: `<span class="unit">SAR</span>${fmt.sar(k.reorderCost)}`,
      delta: 'covers lead time + 14d + safety', cls: 'flat',
    },
    {
      label: 'Capital in overstock', value: `<span class="unit">SAR</span>${fmt.sar(k.overstockValue)}`,
      vcls: k.overstockValue > 0 ? 'cold-val' : '',
      delta: 'stock beyond 30-day need', cls: 'flat',
    },
  ];
  $('#kpis').innerHTML = tiles.map(t => `
    <div class="kpi">
      <span class="kpi-label">${t.label}</span>
      <span class="kpi-value ${t.vcls || ''}">${t.value}</span>
      <span class="kpi-delta ${t.cls}">${t.delta}</span>
    </div>`).join('');
}

/* ---------------- forecast chart ---------------- */
const CHART = { histDays: 60, padL: 46, padR: 14, padT: 16, padB: 26 };

function renderChart() {
  const r = state.data.rows.find(x => x.si === state.selectedSi) || state.data.rows[0];
  const svg = $('#chart');
  const W = svg.clientWidth || 800, H = svg.clientHeight || 320;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  $('#fcTitle').textContent = r.sku.name;
  const trendWord = r.slopePct > 0.08 ? 'rising' : r.slopePct < -0.08 ? 'falling' : 'steady';
  $('#fcMeta').textContent =
    `${r.sku.category} · ${r.sku.brand} · ${r.sku.supplier} · demand ${trendWord} ${fmt.pct(r.slopePct * 7, 1)}/wk`;

  const hist = r.history.slice(-CHART.histDays);
  const histDates = state.data.dates.slice(-CHART.histDays);
  const fc = r.forecast;
  const n = hist.length + fc.length;

  const maxY = Math.max(...hist, ...fc.map(p => p.hi), 1) * 1.08;
  const x = (i) => CHART.padL + (i / (n - 1)) * (W - CHART.padL - CHART.padR);
  const y = (v) => H - CHART.padB - (v / maxY) * (H - CHART.padT - CHART.padB);

  const el = (tag, attrs, parent = svg) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e); return e;
  };

  // defs: history area gradient + forecast band hatch
  const defs = el('defs', {});
  const grad = el('linearGradient', { id: 'histGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': 0.12 }, grad);
  el('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': 0 }, grad);
  const pat = el('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 6, height: 6, fill: 'transparent' }, pat);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'currentColor', 'stroke-opacity': 0.18, 'stroke-width': 2.4 }, pat);
  svg.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

  // gridlines + y labels
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxY / ticks) * i;
    el('line', { x1: CHART.padL, x2: W - CHART.padR, y1: y(v), y2: y(v), class: 'gridline' });
    el('text', { x: CHART.padL - 8, y: y(v) + 3, 'text-anchor': 'end', class: 'axis-txt' }).textContent =
      v >= 100 ? Math.round(v / 10) * 10 : Math.round(v);
  }
  // x labels: ~6 across
  const allDates = [...histDates, ...fc.map(p => p.date)];
  for (let i = 0; i < n; i += Math.ceil(n / 6)) {
    el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'axis-txt' }).textContent = fmt.day(allDates[i]);
  }

  // forecast confidence band
  const iFc0 = hist.length - 1; // band starts at last actual
  let band = `M ${x(iFc0)} ${y(hist[hist.length - 1])} `;
  fc.forEach((p, j) => { band += `L ${x(hist.length + j)} ${y(p.hi)} `; });
  for (let j = fc.length - 1; j >= 0; j--) band += `L ${x(hist.length + j)} ${y(fc[j].lo)} `;
  band += 'Z';
  el('path', { d: band, class: 'band' });

  // history area + line
  let area = `M ${x(0)} ${y(0)} `, line = '';
  hist.forEach((v, i) => { area += `L ${x(i)} ${y(v)} `; line += `${i ? 'L' : 'M'} ${x(i)} ${y(v)} `; });
  area += `L ${x(hist.length - 1)} ${y(0)} Z`;
  el('path', { d: area, class: 'hist-area' });
  el('path', { d: line, class: 'hist-path' });

  // forecast mean line (starts from last actual for continuity)
  let fline = `M ${x(iFc0)} ${y(hist[hist.length - 1])} `;
  fc.forEach((p, j) => { fline += `L ${x(hist.length + j)} ${y(p.mean)} `; });
  el('path', { d: fline, class: 'fc-path' });

  // today divider
  el('line', { x1: x(iFc0), x2: x(iFc0), y1: CHART.padT, y2: H - CHART.padB, class: 'today-line' });
  el('text', { x: x(iFc0) - 5, y: CHART.padT + 8, 'text-anchor': 'end', class: 'today-txt' }).textContent = 'TODAY';

  // projected stockout marker
  if (r.stockoutDate) {
    const j = fc.findIndex(p => p.date === r.stockoutDate);
    if (j >= 0) {
      const sx = x(hist.length + j);
      el('line', { x1: sx, x2: sx, y1: CHART.padT + 14, y2: H - CHART.padB, class: 'stockout-line' });
      el('text', { x: sx + 5, y: CHART.padT + 24, class: 'stockout-txt' }).textContent = `STOCKOUT ${fmt.day(r.stockoutDate)}`;
    }
  }

  // hover crosshair + tooltip
  const cross = el('line', { y1: CHART.padT, y2: H - CHART.padB, class: 'crosshair', visibility: 'hidden' });
  const dot = el('circle', { r: 3.5, class: 'hover-dot', visibility: 'hidden' });
  const tip = $('#chartTip');
  svg.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - CHART.padL) / (W - CHART.padL - CHART.padR)) * (n - 1))));
    const isFc = i >= hist.length;
    const val = isFc ? fc[i - hist.length].mean : hist[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(val)); dot.setAttribute('visibility', 'visible');
    const rows = isFc
      ? `<div class="tip-row"><span>Forecast</span><span class="tip-val">${fc[i - hist.length].mean.toFixed(1)} u</span></div>
         <div class="tip-row"><span>Range</span><span class="tip-val">${fc[i - hist.length].lo.toFixed(0)}–${fc[i - hist.length].hi.toFixed(0)} u</span></div>`
      : `<div class="tip-row"><span>Sold</span><span class="tip-val">${val} u</span></div>
         <div class="tip-row"><span>Revenue</span><span class="tip-val">${fmt.sar(val * r.sku.price)} SAR</span></div>`;
    tip.innerHTML = `<div class="tip-date">${allDates[i]}${isFc ? ' · projected' : ''}</div>${rows}`;
    tip.hidden = false;
    tip.style.left = `${(x(i) / W) * rect.width}px`;
    tip.style.top = `${(y(val) / H) * rect.height + 10}px`;
  };
  svg.onmouseleave = () => {
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true;
  };

  // chips under the chart
  const chips = [];
  chips.push(`<span class="chip">next 14d <b>${fmt.int(r.next14Units)} u</b> ≈ <b>${fmt.sar(r.next14Revenue)} SAR</b></span>`);
  chips.push(`<span class="chip">on hand <b>${fmt.int(r.onHand)} u</b>${r.inTransit ? ` + <b>${fmt.int(r.inTransit)}</b> in transit` : ''}</span>`);
  chips.push(`<span class="chip">cover <b>${r.cover}d</b> vs lead <b>${r.sku.leadTimeDays}d</b></span>`);
  if (r.stockoutDate) chips.push(`<span class="chip chip-crit">projected stockout <b>${fmt.day(r.stockoutDate)}</b></span>`);
  if (r.reorderQty) chips.push(`<span class="chip chip-accent">reorder <b>${fmt.int(r.reorderQty)} u</b> (${Math.round(r.reorderQty / r.sku.caseSize)} cases · ${fmt.sar(r.reorderCost)} SAR)</span>`);
  $('#fcChips').innerHTML = chips.join('');
}

/* ---------------- risk table ---------------- */
function sparkline(hist) {
  const pts = hist.slice(-30);
  const w = 84, h = 26, max = Math.max(...pts, 1);
  const d = pts.map((v, i) =>
    `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * w},${h - 3 - (v / max) * (h - 6)}`).join(' ');
  const first = pts.slice(0, 10).reduce((a, b) => a + b, 0);
  const last = pts.slice(-10).reduce((a, b) => a + b, 0);
  const cls = last > first * 1.08 ? 'up' : last < first * 0.92 ? 'down' : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path class="spark-line ${cls}" d="${d}"/></svg>`;
}

function renderTable() {
  const rows = [...state.data.rows].sort(rankSeverity).filter(r => {
    if (state.riskFilter === 'risk') return r.status === 'critical' || r.status === 'warning';
    if (state.riskFilter === 'overstock') return r.status === 'overstock';
    return true;
  });
  const COVER_SCALE = 60; // bar full at 60 days
  $('#riskBody').innerHTML = rows.map(r => {
    const covPct = Math.min(100, (r.cover / COVER_SCALE) * 100);
    const ltPct = Math.min(100, (r.sku.leadTimeDays / COVER_SCALE) * 100);
    return `
    <tr data-si="${r.si}" class="${r.si === state.selectedSi ? 'is-selected' : ''}">
      <td><div class="sku-cell"><span class="sku-name">${r.sku.name}</span>
        <span class="sku-sub">${r.sku.id} · ${r.sku.category}</span></div></td>
      <td>${sparkline(r.history)}</td>
      <td class="num mono">${fmt.int(r.last30Units)} <span class="sku-sub">${fmt.pct(r.momPct)}</span></td>
      <td class="num mono">${fmt.int(r.onHand)}</td>
      <td><div class="cover-cell">
        <span class="cover-bar"><span class="cover-fill ${r.status}" style="width:${covPct}%"></span>
        <span class="cover-lt" style="left:${ltPct}%"></span></span>
        <span class="cover-days">${r.cover >= 90 ? '90+' : r.cover}d</span></div></td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td class="num">${r.reorderQty
        ? `<div class="reorder-cell"><span class="reorder-qty">${fmt.int(r.reorderQty)} u</span><span class="reorder-cost">${fmt.sar(r.reorderCost)} SAR</span></div>`
        : '<span class="reorder-none">—</span>'}</td>
    </tr>`;
  }).join('');

  $('#riskBody').querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      state.selectedSi = Number(tr.dataset.si);
      renderChart(); renderTable();
      $('.forecast-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

$('#riskFilter').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg-btn');
  if (!btn) return;
  state.riskFilter = btn.dataset.f;
  $('#riskFilter').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('is-on', b === btn));
  renderTable();
});

/* ---------------- merchandising ---------------- */
function renderMerch() {
  const { push, discount, watch } = state.data.merch;
  const col = (title, cls, items) => `
    <div class="merch-col ${cls}">
      <h3>${title}</h3>
      ${items.length ? items.map(m => {
        const r = state.data.rows.find(x => x.si === m.si);
        return `<div class="merch-item"><b>${r.sku.name}</b><span>${m.reason}</span></div>`;
      }).join('') : '<p class="merch-empty">Nothing qualifies this week.</p>'}
    </div>`;
  $('#merchGrid').innerHTML =
    col('Push — feature these', 'push', push) +
    col('Discount — free the capital', 'discount', discount) +
    col('Watch — confirm the POs', 'watch', watch);
}

/* ---------------- AI brief ---------------- */
function renderAiStatus() {
  $('#aiModel').textContent = state.data.model;
  $('#aiDot').classList.toggle('off', !state.data.aiReady);
  $('#aiBtn').disabled = !state.data.aiReady || state.aiBusy;
  if (!state.data.aiReady) $('#aiMeta').innerHTML = 'AI offline — set OPENROUTER_API_KEY';
}

// Minimal, safe markdown → HTML (headings, bold, ordered/unordered lists, paragraphs)
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|\s)\*(?!\s)([^*]+?)\*(?=\s|[.,;:!?)]|$)/g, '$1<em>$2</em>');
  const lines = md.split(/\r?\n/);
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const ol = line.match(/^\d+[.)]\s+(.*)/);
    const ul = line.match(/^[-*•]\s+(.*)/);
    if (h) { flushPara(); flushList(); html += `<h2>${inline(h[2])}</h2>`; }
    else if (ol) { flushPara(); if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(ol[1])}</li>`; }
    else if (ul) { flushPara(); if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(ul[1])}</li>`; }
    else para.push(line);
  }
  flushPara(); flushList();
  return html;
}

$('#aiBtn').addEventListener('click', async () => {
  if (state.aiBusy) return;
  state.aiBusy = true;
  const btn = $('#aiBtn');
  btn.disabled = true; btn.classList.add('loading');
  $('.btn-label', btn).textContent = 'Reading the numbers…';
  $('#aiBody').innerHTML = `
    <div class="ai-loading">
      <div class="ln"></div><div class="ln"></div><div class="ln"></div>
      <div class="ln"></div><div class="ln"></div><div class="ln"></div>
      <div class="ai-loading-note">Mizan is weighing forecasts, cover days and reorder math…</div>
    </div>`;
  try {
    const body = state.store === 'all' ? {} : { store: Number(state.store) };
    const r = await fetch('/api/ai/brief', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    const scope = state.store === 'all' ? 'all branches' : state.data.stores[Number(state.store)].name;
    $('#aiBody').innerHTML = `<div class="ai-brief">${mdToHtml(out.brief)}
      <div class="ai-stamp">${out.model} · ${scope} · ${new Date(out.generatedAt).toLocaleTimeString('en-GB')}</div></div>`;
  } catch (e) {
    $('#aiBody').innerHTML = `<div class="ai-error">Brief failed: ${String(e.message || e)}</div>`;
  } finally {
    state.aiBusy = false;
    btn.disabled = !state.data.aiReady; btn.classList.remove('loading');
    $('.btn-label', btn).textContent = 'Regenerate brief';
  }
});

/* ---------------- resize ---------------- */
let rz;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => state.data && renderChart(), 150); });

loadData().catch(e => {
  $('#kpis').innerHTML = `<div class="kpi"><span class="kpi-label">Error</span><span class="kpi-delta down">${e.message}</span></div>`;
});
