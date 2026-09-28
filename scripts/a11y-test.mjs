// No-WebGL fallback + reduced-motion + keyboard checks.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const url = process.argv[2] || 'http://127.0.0.1:5173/?debug&q=1';
const out = process.argv[3] || '/tmp';
const exe = process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FD = process.env.FONT_DIR;
async function open(args, ctxOpts = {}) {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...args] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, ...ctxOpts });
  const page = await ctx.newPage();
  if (FD) {
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(FD, 'fonts.css'), 'utf8') }));
    await page.route('https://fonts.gstatic.com/**', (r) => { const f = path.join(FD, path.basename(new URL(r.request().url()).pathname)); fs.existsSync(f) ? r.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) }) : r.abort(); });
  }
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  return { browser, page, errs };
}
let failed = false;
const ck = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' ' + x)); if (!c) failed = true; };

// 1. no WebGL at all
{
  const { browser, page, errs } = await open(['--disable-gpu', '--disable-3d-apis', '--disable-webgl', '--disable-webgl2']);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  ck('static mode on', await page.evaluate(() => document.body.classList.contains('static-mode')));
  ck('loader gone', await page.evaluate(() => getComputedStyle(document.getElementById('loader')).visibility === 'hidden'));
  ck('all 11 panels readable', await page.evaluate(() => [...document.querySelectorAll('.panel')].filter((p) => getComputedStyle(p).visibility === 'visible' && +getComputedStyle(p).opacity > 0.9).length === 11));
  ck('data table present', await page.evaluate(() => !!document.querySelector('table.t tbody tr')));
  await page.screenshot({ path: path.join(out, 'nogl.png') });
  ck('no page errors (no-webgl)', errs.length === 0, errs.join(' | '));
  await browser.close();
}
// 2. reduced motion + keyboard
{
  const { browser, page, errs } = await open(['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], { reducedMotion: 'reduce' });
  await page.goto(url, { waitUntil: 'load' });
  for (let i = 0; i < 3; i++) { try { await page.waitForFunction(() => window.__ready === true && window.__app, null, { timeout: 120000 }); break; } catch {} }
  ck('reduced motion detected', await page.evaluate(() => window.__app.story.reduced === true));
  await page.keyboard.press('Tab');
  ck('loader traps focus on enter button', await page.evaluate(() => /enter-/.test(document.activeElement?.id || '')), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  ck('entered via keyboard', await page.evaluate(() => !document.body.classList.contains('is-loading')));
  // Tab into the page: focusable controls include the header, not hidden panels' buttons
  const focusables = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input')].filter((el) => { const st = getComputedStyle(el); return st.visibility !== 'hidden' && el.offsetParent !== null || st.position === 'fixed'; }).length);
  ck('has focusable controls', focusables > 5);
  const before = await page.evaluate(() => ({ active: document.activeElement?.tagName + '#' + document.activeElement?.id, y: window.scrollY, overflow: getComputedStyle(document.body).overflow }));
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.scrollY);
  ck('PageDown scrolls', after > 100, JSON.stringify({ before, after }));
  ck('no page errors (reduced motion)', errs.length === 0, errs.join(' | '));
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
