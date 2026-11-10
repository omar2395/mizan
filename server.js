// server.js — Mizan demand-intelligence server. Zero runtime dependencies (node:http).
// Run: node server.js  →  http://localhost:4940
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildDataset } = require('./seed');
const { analyze, aiDigest } = require('./engine');

const PORT = process.env.PORT || 4940;
const PUBLIC = path.join(__dirname, 'public');
const MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';

// --- OpenRouter key from the environment or .env (never logged, never sent to the client) ---
function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY\s*=\s*(.+)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
const OPENROUTER_KEY = loadKey();

// --- Data: built once, deterministic ---
const DATA = buildDataset();
console.log(`[mizan] dataset ready — ${DATA.skus.length} SKUs × ${DATA.stores.length} stores × ${DATA.dates.length} days`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function bootstrapPayload(storeFilter) {
  const a = analyze(DATA, storeFilter);
  return {
    retailer: DATA.retailer,
    stores: DATA.stores,
    dates: DATA.dates,
    aiReady: Boolean(OPENROUTER_KEY),
    model: MODEL,
    kpis: a.kpis,
    merch: a.merch,
    rows: a.rows.map(r => ({
      si: r.si, sku: r.sku,
      history: r.history, forecast: r.forecast,
      slopePct: r.slopePct, onHand: r.onHand, inTransit: r.inTransit,
      cover: r.cover, stockoutDate: r.stockoutDate, status: r.status,
      reorderQty: r.reorderQty, reorderCost: r.reorderCost,
      next14Units: r.next14Units, next14Revenue: r.next14Revenue,
      last30Units: r.last30Units, last30Revenue: r.last30Revenue,
      momPct: r.momPct, marginPct: r.marginPct, overstockValue: r.overstockValue,
    })),
  };
}

async function handleAI(req, res, body) {
  if (!OPENROUTER_KEY) return json(res, 503, { error: 'OPENROUTER_API_KEY is not set' });
  let parsed = {};
  try { parsed = JSON.parse(body || '{}'); } catch { /* default */ }
  const storeFilter = Number.isInteger(parsed.store) ? parsed.store : null;
  const storeName = storeFilter == null ? 'all 5 branches'
    : `${DATA.stores[storeFilter].name} branch only`;
  const analysis = analyze(DATA, storeFilter);
  const digest = aiDigest(DATA, analysis, storeName);

  const system = `You are Mizan, the demand-planning analyst for a Saudi food retail chain. You are given real computed figures (forecasts, cover days, reorder quantities). Write for a busy operations director.
Respond in GitHub-flavored Markdown with EXACTLY these sections:
## The week ahead
2-3 sentences: overall demand direction, the single biggest risk, the single biggest opportunity.
## Act now
A numbered list of the 4-6 most urgent moves. Each item: **SKU name** — the action (with concrete quantity/SAR figure from the data) — then "Why:" one sentence explaining the reasoning in plain language.
## Merchandising calls
Short bullets: what to push, what to discount, referencing the candidates given.
## Watch list
1-2 bullets on trends that aren't urgent yet but will be.
Rules: never invent numbers not present in the data; keep the whole brief under 350 words; no preamble before the first heading.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:' + PORT,
        'X-Title': 'Mizan Demand Intelligence',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 900,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: digest },
        ],
      }),
    });
    clearTimeout(timer);
    if (!r.ok) {
      const t = await r.text();
      return json(res, 502, { error: `OpenRouter ${r.status}: ${t.slice(0, 200)}` });
    }
    const out = await r.json();
    const text = out.choices?.[0]?.message?.content || '';
    return json(res, 200, { brief: text, model: out.model || MODEL, generatedAt: new Date().toISOString() });
  } catch (e) {
    return json(res, 502, { error: e.name === 'AbortError' ? 'AI request timed out' : String(e.message || e) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/bootstrap') {
    const s = url.searchParams.get('store');
    const storeFilter = s !== null && s !== '' && s !== 'all' ? Number(s) : null;
    return json(res, 200, bootstrapPayload(Number.isInteger(storeFilter) ? storeFilter : null));
  }

  if (url.pathname === '/api/ai/brief' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => handleAI(req, res, body));
    return;
  }

  // static
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^([.\\/])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`[mizan] Baraka Markets demand intelligence → http://localhost:${PORT}`);
  console.log(`[mizan] AI: ${OPENROUTER_KEY ? `ready (${MODEL})` : 'DISABLED — OPENROUTER_API_KEY is not set'}`);
});
