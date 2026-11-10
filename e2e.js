// e2e.js — self-test: boots the server, drives the primary flow with Playwright,
// verifies the live AI brief, and captures the portfolio screenshots.
// Run: npm run e2e
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 4940;
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');

const ok = (msg) => console.log('  \x1b[32m✓\x1b[0m ' + msg);
const step = (msg) => console.log('\x1b[36m▸\x1b[0m ' + msg);

async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/bootstrap');
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not come up on ' + BASE);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  step('starting server');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) },
  });
  const kill = () => { try { server.kill(); } catch { /* already dead */ } };
  process.on('exit', kill);

  try {
    const boot = await waitForServer();
    ok(`server up — ${boot.rows.length} SKUs, aiReady=${boot.aiReady}`);
    if (!boot.aiReady) throw new Error('OPENROUTER_API_KEY is not set — the e2e run needs live AI');

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    step('dashboard (dark)');
    await page.goto(BASE);
    await page.waitForSelector('#riskBody tr');
    await page.waitForSelector('.kpi-value');
    const kpiCount = await page.locator('.kpi').count();
    if (kpiCount !== 5) throw new Error(`expected 5 KPI tiles, got ${kpiCount}`);
    const rowCount = await page.locator('#riskBody tr').count();
    if (rowCount < 20) throw new Error(`expected 24 SKU rows, got ${rowCount}`);
    await page.waitForTimeout(700); // entrance animations settle
    await page.screenshot({ path: path.join(SHOTS, '01-dashboard-dark.png') });
    ok(`renders — ${kpiCount} KPIs, ${rowCount} SKU rows`);

    step('chart interaction: select an overstock SKU + hover tooltip');
    await page.click('#riskFilter [data-f="overstock"]');
    await page.waitForTimeout(200);
    await page.click('#riskBody tr:first-child');
    await page.waitForTimeout(400);
    const title = await page.textContent('#fcTitle');
    ok(`charted "${title.trim()}"`);
    const chart = await page.locator('#chart').boundingBox();
    await page.mouse.move(chart.x + chart.width * 0.55, chart.y + chart.height * 0.45);
    await page.waitForSelector('#chartTip:not([hidden])');
    ok('hover tooltip appears');
    await page.screenshot({ path: path.join(SHOTS, '02-forecast-detail.png') });
    await page.click('#riskFilter [data-f="all"]');

    step('branch filter: Corniche (Jeddah)');
    await page.click('.store-pills .pill:nth-child(4)'); // All, OLY, MLZ, COR
    await page.waitForTimeout(600);
    const pillOn = await page.textContent('.store-pills .pill.is-on');
    if (!/Corniche/.test(pillOn)) throw new Error('branch filter did not apply: ' + pillOn);
    await page.screenshot({ path: path.join(SHOTS, '03-branch-view.png') });
    ok('per-branch analysis re-computed');
    await page.click('.store-pills .pill:first-child'); // back to all
    await page.waitForTimeout(600);

    step('live AI brief (OpenRouter)');
    await page.click('#aiBtn');
    await page.waitForSelector('.ai-brief', { timeout: 100000 });
    const brief = await page.textContent('.ai-brief');
    if (brief.length < 300) throw new Error('AI brief suspiciously short: ' + brief.slice(0, 120));
    if (!/week ahead/i.test(brief) || !/act now/i.test(brief)) {
      throw new Error('AI brief missing required sections');
    }
    ok(`AI brief generated — ${brief.length} chars, sections verified`);
    await page.screenshot({ path: path.join(SHOTS, '04-ai-brief.png') });
    const rail = await page.locator('.ai-rail').boundingBox();
    await page.screenshot({
      path: path.join(SHOTS, '05-ai-brief-closeup.png'),
      clip: { x: rail.x - 8, y: Math.max(0, rail.y - 8), width: rail.width + 16, height: Math.min(884, rail.height + 16) },
    });

    step('light mode');
    await page.click('#themeToggle');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, '06-dashboard-light.png') });
    ok('light theme captured');

    await browser.close();
    console.log('\n\x1b[32mE2E PASSED\x1b[0m — screenshots in ./screenshots/');
  } finally {
    kill();
  }
})().catch((e) => { console.error('\x1b[31mE2E FAILED:\x1b[0m', e.message); process.exit(1); });
