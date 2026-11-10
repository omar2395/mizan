// engine.js — forecasting + replenishment intelligence for Mizan.
// Classical, explainable methods (weekday-seasonal decomposition + damped linear trend)
// so every number on screen has a defensible "why". No black boxes here — the LLM
// narrates on top of these figures, it does not invent them.
'use strict';

const HORIZON = 21;        // forecast days
const FIT_WINDOW = 70;     // days of history used for trend fit
const REVIEW_PERIOD = 14;  // reorder covers lead time + this many days
const Z_SAFETY = 1.64;     // ~95% service level

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

// Weekday indices from the last 8 weeks: idx[dow] = avg(dow) / overall avg
function weekdayIndices(series, dates) {
  const from = Math.max(0, series.length - 56);
  const sums = new Array(7).fill(0), counts = new Array(7).fill(0);
  for (let t = from; t < series.length; t++) {
    const dow = new Date(dates[t] + 'T00:00:00Z').getUTCDay();
    sums[dow] += series[t]; counts[dow]++;
  }
  const overall = mean(series.slice(from)) || 1;
  return sums.map((s, d) => (counts[d] ? (s / counts[d]) / overall : 1));
}

// Forecast a single daily series. Returns { points, level, slopePct, sigma, mape }
function forecastSeries(series, dates) {
  const idx = weekdayIndices(series, dates);
  const from = Math.max(0, series.length - FIT_WINDOW);
  const xs = [], ys = [];
  for (let t = from; t < series.length; t++) {
    const dow = new Date(dates[t] + 'T00:00:00Z').getUTCDay();
    xs.push(t); ys.push(series[t] / (idx[dow] || 1)); // deseasonalized
  }
  // least-squares line on deseasonalized demand
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const level = my + slope * (series.length - 1 - mx);

  // residual sigma for confidence band
  let sse = 0;
  for (let i = 0; i < xs.length; i++) {
    const fit = my + slope * (xs[i] - mx);
    sse += (ys[i] - fit) ** 2;
  }
  const sigma = Math.sqrt(sse / Math.max(1, xs.length - 2));

  // in-sample MAPE over the fit window (reseasonalized) for the accuracy KPI
  let ape = 0, apeN = 0;
  for (let i = 0; i < xs.length; i++) {
    const dow = new Date(dates[xs[i]] + 'T00:00:00Z').getUTCDay();
    const fit = (my + slope * (xs[i] - mx)) * (idx[dow] || 1);
    if (series[xs[i]] > 2) { ape += Math.abs(series[xs[i]] - fit) / series[xs[i]]; apeN++; }
  }

  const lastDate = new Date(dates[dates.length - 1] + 'T00:00:00Z');
  const damp = 0.985; // damp the trend so long horizons don't run away
  const points = [];
  for (let h = 1; h <= HORIZON; h++) {
    const d = new Date(lastDate.getTime() + h * 86400000);
    const dow = d.getUTCDay();
    let trendSum = 0;
    for (let k = 1; k <= h; k++) trendSum += slope * Math.pow(damp, k);
    const base = Math.max(0, (level + trendSum) * (idx[dow] || 1));
    const widen = sigma * Math.sqrt(1 + h / 14) * (idx[dow] || 1);
    points.push({
      date: d.toISOString().slice(0, 10),
      mean: Math.max(0, base),
      lo: Math.max(0, base - Z_SAFETY * widen),
      hi: base + Z_SAFETY * widen,
    });
  }
  const slopePct = level > 0 ? (slope / level) * 100 : 0; // % of current level per day
  return { points, level: Math.max(0, level), slopePct, sigma, mape: apeN ? ape / apeN : 0 };
}

function sumSeries(perStore, storeFilter) {
  const n = perStore[0].length;
  const out = new Array(n).fill(0);
  for (let st = 0; st < perStore.length; st++) {
    if (storeFilter != null && storeFilter !== st) continue;
    for (let t = 0; t < n; t++) out[t] += perStore[st][t];
  }
  return out;
}

// Full chain analysis: per-SKU forecast, risk classification, reorder plan, merchandising calls.
function analyze(data, storeFilter = null) {
  const { dates, skus, sales, stock, onOrder } = data;
  const rows = skus.map((sku, si) => {
    const series = sumSeries(sales[si], storeFilter);
    const fc = forecastSeries(series, dates);
    const onHand = storeFilter != null ? stock[si][storeFilter]
      : stock[si].reduce((a, b) => a + b, 0);
    const inTransit = storeFilter != null ? Math.round(onOrder[si] * 0.0) : onOrder[si];

    // days of cover: walk the forecast until stock runs out
    let remaining = onHand, cover = 0, stockoutDate = null;
    for (const p of fc.points) {
      if (remaining <= 0) break;
      remaining -= p.mean;
      if (remaining > 0) cover++;
      else stockoutDate = p.date;
    }
    if (remaining > 0) { // outlasts the horizon — extrapolate on mean rate
      const rate = Math.max(0.01, mean(fc.points.map(p => p.mean)));
      cover = onHand / rate;
    }

    const lt = sku.leadTimeDays;
    let status = 'healthy';
    if (cover < lt) status = 'critical';
    else if (cover < lt + 5) status = 'warning';
    else if (cover > 45 && fc.slopePct <= 0.05) status = 'overstock';

    // Reorder: demand over lead time + review period, plus safety stock, minus position.
    const horizonNeed = fc.points.slice(0, Math.min(HORIZON, lt + REVIEW_PERIOD))
      .reduce((a, p) => a + p.mean, 0)
      + Math.max(0, lt + REVIEW_PERIOD - HORIZON) * (fc.level || 0);
    const safety = Z_SAFETY * fc.sigma * Math.sqrt(lt);
    const rawQty = horizonNeed + safety - onHand - inTransit;
    const reorderQty = rawQty > 0 && status !== 'overstock'
      ? Math.ceil(rawQty / sku.caseSize) * sku.caseSize : 0;

    const next14 = fc.points.slice(0, 14).reduce((a, p) => a + p.mean, 0);
    const last30 = series.slice(-30).reduce((a, b) => a + b, 0);
    const prev30 = series.slice(-60, -30).reduce((a, b) => a + b, 0);
    const marginPct = (sku.price - sku.unitCost) / sku.price * 100;

    return {
      sku, si,
      history: series,
      forecast: fc.points,
      slopePct: fc.slopePct,
      mape: fc.mape,
      onHand, inTransit,
      cover: Math.round(cover * 10) / 10,
      stockoutDate, status,
      reorderQty,
      reorderCost: Math.round(reorderQty * sku.unitCost),
      next14Units: Math.round(next14),
      next14Revenue: Math.round(next14 * sku.price),
      last30Units: last30, prev30Units: prev30,
      last30Revenue: Math.round(last30 * sku.price),
      momPct: prev30 > 0 ? ((last30 - prev30) / prev30) * 100 : 0,
      marginPct,
      overstockValue: status === 'overstock'
        ? Math.round(Math.max(0, onHand - fc.level * 30) * sku.unitCost) : 0,
    };
  });

  // Merchandising calls
  const push = rows.filter(r => r.momPct > 6 && r.status !== 'critical' && r.cover > r.sku.leadTimeDays)
    .sort((a, b) => b.momPct - a.momPct).slice(0, 4)
    .map(r => ({ si: r.si, reason: `sales +${r.momPct.toFixed(0)}% MoM, ${r.marginPct.toFixed(0)}% margin, ${Math.round(r.cover)}d cover — feature it while demand is climbing` }));
  const discount = rows.filter(r => r.status === 'overstock' && r.momPct < 3)
    .sort((a, b) => b.overstockValue - a.overstockValue).slice(0, 4)
    .map(r => ({ si: r.si, reason: `${Math.round(r.cover)} days of cover with ${r.momPct.toFixed(0)}% MoM demand — ${r.overstockValue.toLocaleString('en-US')} SAR tied up beyond 30-day need` }));
  const watch = rows.filter(r => r.status === 'warning')
    .slice(0, 4)
    .map(r => ({ si: r.si, reason: `cover (${Math.round(r.cover)}d) inside lead time +5d buffer — confirm the PO lands before ${r.stockoutDate || 'month end'}` }));

  const kpis = {
    revenue30: rows.reduce((a, r) => a + r.last30Revenue, 0),
    revenuePrev30: rows.reduce((a, r) => a + Math.round(r.prev30Units * r.sku.price), 0),
    forecast14Revenue: rows.reduce((a, r) => a + r.next14Revenue, 0),
    atRisk: rows.filter(r => r.status === 'critical' || r.status === 'warning').length,
    critical: rows.filter(r => r.status === 'critical').length,
    overstockValue: rows.reduce((a, r) => a + r.overstockValue, 0),
    reorderCost: rows.reduce((a, r) => a + r.reorderCost, 0),
    accuracy: 100 - mean(rows.map(r => r.mape)) * 100,
  };

  return { rows, kpis, merch: { push, discount, watch } };
}

// Compact digest fed to the LLM — small enough to stay cheap, rich enough to reason on.
function aiDigest(data, analysis, storeName) {
  const { rows, kpis, merch } = analysis;
  const line = (r) =>
    `${r.sku.id} ${r.sku.name} [${r.sku.category}] — 30d sold ${r.last30Units}u (MoM ${r.momPct.toFixed(0)}%), ` +
    `on-hand ${r.onHand}u, cover ${Math.round(r.cover)}d, lead ${r.sku.leadTimeDays}d, status ${r.status}` +
    (r.stockoutDate ? `, projected stockout ${r.stockoutDate}` : '') +
    (r.reorderQty ? `, suggested reorder ${r.reorderQty}u (~${r.reorderCost} SAR)` : '');
  const interesting = rows
    .filter(r => r.status !== 'healthy' || Math.abs(r.momPct) > 8 || r.reorderQty > 0)
    .sort((a, b) => (a.status === 'critical' ? -1 : 1) - (b.status === 'critical' ? -1 : 1));
  return [
    `Retailer: ${data.retailer.name} (${storeName}). Data as of ${data.retailer.asOf}. Currency SAR.`,
    `KPIs: 30-day revenue ${kpis.revenue30} SAR (prev ${kpis.revenuePrev30}), next-14-day forecast revenue ${kpis.forecast14Revenue} SAR, ` +
    `${kpis.critical} critical + ${kpis.atRisk - kpis.critical} warning SKUs, overstock capital ${kpis.overstockValue} SAR, ` +
    `suggested reorder spend ${kpis.reorderCost} SAR, forecast accuracy ${kpis.accuracy.toFixed(1)}%.`,
    `SKU detail (${interesting.length} flagged of ${rows.length} total):`,
    ...interesting.map(line),
    `Merch push candidates: ${merch.push.map(m => rows[m.si].sku.name).join('; ') || 'none'}.`,
    `Discount candidates: ${merch.discount.map(m => rows[m.si].sku.name).join('; ') || 'none'}.`,
  ].join('\n');
}

module.exports = { analyze, aiDigest, HORIZON };
