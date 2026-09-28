// End-to-end smoke test: loads the built or dev app, drives the main flows, fails on any console error.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const url = process.argv[2] || 'http://127.0.0.1:5173/?debug&q=1';
const exe = process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const FD = process.env.FONT_DIR;
if (FD) {
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(FD, 'fonts.css'), 'utf8') }));
  await page.route('https://fonts.gstatic.com/**', (r) => { const f = path.join(FD, path.basename(new URL(r.request().url()).pathname)); fs.existsSync(f) ? r.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) }) : r.abort(); });
}
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console.error: ' + m.text().slice(0, 400)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const ok = [];
const check = (name, cond, extra = '') => { (cond ? ok : errors).push(cond ? `ok   ${name}` : `FAIL ${name} ${extra}`); };
await page.goto(url, { waitUntil: 'load' });
for (let i = 0; i < 3; i++) { try { await page.waitForFunction(() => window.__ready === true && window.__app, null, { timeout: 120000 }); break; } catch {} }
check('app ready', await page.evaluate(() => !!window.__app));
// enter with sound
await page.click('#enter-sound');
await page.waitForTimeout(800);
const audio = await page.evaluate(() => ({ enabled: window.__app.hooks.audio.enabled, state: window.__app.hooks.audio.ctx?.state, voices: window.__app.hooks.audio.voices.length }));
check('audio enabled', audio.enabled && audio.voices === 7, JSON.stringify(audio));
check('body not loading', await page.evaluate(() => !document.body.classList.contains('is-loading')));
// scroll flow
for (const s of [1.3, 4.3, 9.3]) { await page.evaluate((s) => window.__app.at(s), s); }
check('rail active after scroll', await page.evaluate(() => document.querySelectorAll('.rail-item.on').length === 1));
check('one panel visible', await page.evaluate(() => document.querySelectorAll('.panel.is-on').length >= 1));
// audio pings fire while story runs
await page.evaluate(() => window.__app.step(40, 200));
// language
await page.click('#lang-seg button[data-lang="pl"]');
check('lang pl', await page.evaluate(() => document.documentElement.lang === 'pl' && /Siedem/.test(document.querySelector('#panel-hero h1').textContent)));
await page.click('#lang-seg button[data-lang="en"]');
// explore
await page.click('#btn-explore');
await page.waitForTimeout(300);
check('explore active', await page.evaluate(() => window.__app.hooks.explore.active && document.body.classList.contains('is-explore')));
await page.evaluate(() => window.__app.step(6, 100));
for (const k of [' ', ' ', ']', '[', '3', 't', 't', 'o', 'o', 'l', 'l', '0', 'Home']) { await page.keyboard.press(k); }
check('focus keys', await page.evaluate(() => window.__app.hooks.explore.focus === -1));
await page.keyboard.press('4');
await page.keyboard.press('s');
await page.evaluate(() => window.__app.step(6, 100));
check('sky mode', await page.evaluate(() => window.__app.hooks.explore.mode === 'sky' && document.body.classList.contains('is-sky')));
await page.click('#ex-aim').catch(() => {});
await page.click('[data-vantage="substellar"]');
await page.click('[data-vantage="antistellar"]');
await page.evaluate(() => window.__app.step(6, 100));
await page.keyboard.press('Escape');
check('back to orrery', await page.evaluate(() => window.__app.hooks.explore.mode === 'orrery' && window.__app.hooks.explore.active));
await page.keyboard.press('Escape');
check('back to story', await page.evaluate(() => !window.__app.hooks.explore.active && !document.body.classList.contains('is-explore')));
// resize
await page.setViewportSize({ width: 420, height: 800 });
await page.evaluate(() => window.__app.step(4, 100));
check('no horizontal overflow @420', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), await page.evaluate(() => `${document.documentElement.scrollWidth} > ${innerWidth}`));
// sound toggle off
await page.click('#btn-sound');
check('sound toggled off', await page.evaluate(() => window.__app.hooks.audio.enabled === false));
console.log(ok.join('\n'));
const failed = errors.filter((e) => /^(FAIL|console|pageerror)/.test(e));
if (failed.length) { console.log('\nPROBLEMS:\n' + failed.join('\n')); process.exitCode = 1; } else console.log('\nALL CHECKS PASSED');
await browser.close();
