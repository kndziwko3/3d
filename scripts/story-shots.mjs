// usage: node scripts/story-shots.mjs <outDir> '<json array of stop coords>' [W] [H] [extraQuery] [lang]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const [outDir, coordsArg, W = '1280', H = '720', extra = '', lang = 'en'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const coords = JSON.parse(coordsArg);
const exe = process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1, locale: lang === 'pl' ? 'pl-PL' : 'en-US' });
const page = await ctx.newPage();
// Headless Chromium here has no direct route to Google Fonts; serve verified local copies.
const FD = process.env.FONT_DIR;
if (FD) {
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(FD, 'fonts.css'), 'utf8') }));
  await page.route('https://fonts.gstatic.com/**', (r) => { const f = path.join(FD, path.basename(new URL(r.request().url()).pathname)); fs.existsSync(f) ? r.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) }) : r.abort(); });
}
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`.slice(0, 1200)); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack||'').slice(0,600)}`));
await page.goto(`http://127.0.0.1:5173/?debug&q=2${extra ? '&' + extra : ''}`, { waitUntil: 'load' });
// Vite may reload once while optimising deps; wait until the app is genuinely ready (twice if needed).
for (let attempt = 0; attempt < 3; attempt++) {
  try { await page.waitForFunction(() => window.__ready === true && window.__app, null, { timeout: 180000 }); break; }
  catch (e) { logs.push('[wait retry] ' + e.message.slice(0, 80)); await page.waitForTimeout(1500); }
}
await page.evaluate(() => window.__app.enter(false));
await page.waitForTimeout(2500);
for (const c of coords) {
  const t0 = Date.now();
  const name = typeof c === 'number' ? `s${String(c).replace('.', '_')}` : c.name;
  const s = typeof c === 'number' ? c : c.s;
  try {
    const r = await page.evaluate(([s, o]) => window.__app.at(s, o || {}), [s, c.o]);
    if (c.js) await page.evaluate(c.js);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(name, `${Date.now() - t0}ms`, JSON.stringify(r));
  } catch (e) { logs.push(`[shot ${name}] ${e.message}`.slice(0, 600)); }
}
console.log('--- console ---'); console.log(logs.join('\n'));
await browser.close();
