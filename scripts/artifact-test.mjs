// Loads the artifact fragment inside a skeleton + strict CSP (like the Artifact viewer) and checks it boots.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const frag = fs.readFileSync(path.join(root, '.artifact/index.html'), 'utf8');
const skeleton = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'none'">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui;background:#fafaf8}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${frag}</body></html>`;
const exe = process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const FD = process.env.FONT_DIR;
if (FD) {
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(FD, 'fonts.css'), 'utf8') }));
  await page.route('https://fonts.gstatic.com/**', (r) => { const f = path.join(FD, path.basename(new URL(r.request().url()).pathname)); fs.existsSync(f) ? r.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) }) : r.abort(); });
}
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/KHR_parallel|Failed to load resource/.test(m.text())) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
await page.setContent(skeleton, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => !document.getElementById('loader-actions')?.hidden, null, { timeout: 120000 });
  console.log('loader ready: yes');
} catch { problems.push('loader never became ready'); }
await page.click('#enter-silent');
await page.waitForTimeout(2500);
await page.mouse.wheel(0, 1200);
await page.waitForTimeout(2500);
await page.screenshot({ path: process.argv[2] || '/tmp/artifact-shot.png' });
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no console problems under strict CSP');
await browser.close();
