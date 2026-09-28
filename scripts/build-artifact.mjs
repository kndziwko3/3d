// Builds the whole atlas into one self-contained HTML fragment for publishing as an Artifact:
// classic (non-module) script, CSS inlined, no assets, Google Fonts as the only external host.
//   node scripts/build-artifact.mjs            -> .artifact/index.html
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.artifact');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outdir: out,
  legalComments: 'none',
  loader: { '.css': 'css' },
  logLevel: 'warning',
});

const js = fs.readFileSync(path.join(out, 'main.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(out, 'main.css'), 'utf8');

// Take the body markup and the font links from the real index.html so the two never drift.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bodyInner = html
  .slice(html.indexOf('<body'), html.lastIndexOf('</body>'))
  .replace(/<body[^>]*>/, '')
  .replace(/<script type="module"[^>]*><\/script>/, '')
  .trim();
const fontLinks = [...html.matchAll(/<link[^>]+(preconnect|stylesheet)[^>]*>/g)].map((m) => m[0]).join('\n');
const icon = (html.match(/<link rel="icon"[^>]*>/) || [''])[0];

const fragment = `<title>TRAPPIST-1 Atlas</title>
${icon}
${fontLinks}
<style>${css}</style>
<script>document.body.classList.add('is-loading');</script>
${bodyInner}
<script>${js}</script>
`;
fs.writeFileSync(path.join(out, 'index.html'), fragment);
console.log(`artifact fragment: ${(fragment.length / 1024).toFixed(0)} kB -> ${path.relative(root, path.join(out, 'index.html'))}`);
