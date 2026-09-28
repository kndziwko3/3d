import { COPY } from './content.js';
import { PLANETS, STAR, R_EARTH_KM, byId, chordHz } from './data.js';

export const STOPS = ['hero', 'star', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'chain', 'scale'];
export const SUN_ANGULAR_DEG = 0.533; // mean apparent diameter of the Sun from Earth

const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
const fill = (str, map) => str.replace(/\{(\w+)\}/g, (_, k) => map[k] ?? '');

export function makeFormatter(lang) {
  const cache = new Map();
  return (v, d = 0) => {
    const key = d;
    let nf = cache.get(key);
    if (!nf) {
      nf = new Intl.NumberFormat(lang === 'pl' ? 'pl-PL' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: true });
      cache.set(key, nf);
    }
    return nf.format(v).replace(/ /g, ' ');
  };
}

const unitSpan = (t) => `<small>${esc(t)}</small>`;

function planetStats(p, c, fmt) {
  const km = p.radius * R_EARTH_KM;
  return [
    { k: c.stats.radius, v: fmt(p.radius, 3), u: `${c.ui.earthRadii} · ${fmt(Math.round(km / 10) * 10)} ${c.ui.km}` },
    { k: c.stats.mass, v: fmt(p.mass, 3), u: c.ui.earthRadii },
    { k: c.stats.year, v: fmt(p.period, 2) + unitSpan(' ' + c.ui.days), u: `${fmt(p.period * 24, 0)} ${c.ui.hours}` },
    { k: c.stats.orbit, v: fmt(p.orbitKm / 1e6, 2) + unitSpan(' ' + c.ui.millionKm), u: `${fmt(p.a, 4)} AU` },
    { k: c.stats.temp, v: fmt(Math.round(p.teq), 0) + unitSpan(' K'), u: `${fmt(Math.round(p.teq - 273.15), 0)} °C` },
    { k: c.stats.light, v: fmt(p.flux, 2), u: c.ui.earthLight },
    { k: c.stats.gravity, v: fmt(p.g, 2) + unitSpan(' g'), u: fill(c.stats.escape, { v: fmt(p.escapeKms, 1) }) },
    { k: c.stats.sky, v: fmt(p.starAngularDeg / SUN_ANGULAR_DEG, 1) + unitSpan('×'), u: c.stats.skyUnit },
  ];
}

const statsHtml = (cells) =>
  `<dl class="stats">${cells.map((s) => `<div class="stat"><dt>${esc(s.k)}</dt><dd><span class="v">${s.v}</span><span class="u">${esc(s.u)}</span></dd></div>`).join('')}</dl>`;

function starFacts(c) {
  return c.star.facts.map(([k, v, u]) => ({ k, v: esc(v), u }));
}

export function buildPanels(lang) {
  const c = COPY[lang];
  const fmt = makeFormatter(lang);
  const out = [];

  out.push({
    id: 'hero',
    hue: '#ff7a45',
    html: `
      <p class="kicker"><span>${esc(c.hero.kicker)}</span></p>
      <h1>${esc(c.hero.title)}</h1>
      <p class="lede hero-sub">${esc(c.hero.sub)}</p>
      <div class="scroll-hint"><i></i><span>${esc(c.ui.scrollHint)}</span></div>`,
  });

  out.push({
    id: 'star',
    hue: '#ff7a45',
    glyph: '★',
    html: `
      <p class="kicker"><span>${esc(c.star.kicker)}</span><span class="sep"></span><span class="muted">TRAPPIST-1</span></p>
      <h2>${esc(c.star.name)}</h2>
      <p class="lede">${esc(c.star.lede)}</p>
      ${statsHtml(starFacts(c))}
      <div class="kn"><div><h3>${esc(c.ui.unknown)}</h3><p>${esc(c.star.unknown)}</p></div></div>
      <div class="surf"><p><em>${esc(c.ui.surface)}</em>${esc(c.star.surface)}</p></div>`,
  });

  PLANETS.forEach((p, i) => {
    const t = c.planets[p.id];
    out.push({
      id: p.id,
      hue: p.hue,
      glyph: p.id,
      html: `
        <p class="kicker"><span>TRAPPIST-1 ${p.id}</span><span class="sep"></span><span class="muted">${esc(c.ui.chapter)} ${i + 1}/7</span></p>
        <h2>${esc(t.name)}</h2>
        <p class="lede">${esc(t.lede)}</p>
        ${statsHtml(planetStats(p, c, fmt))}
        <div class="kn"><div><h3>${esc(c.ui.known)}</h3><p>${esc(t.known)}</p></div><div><h3>${esc(c.ui.unknown)}</h3><p>${esc(t.unknown)}</p></div></div>
        <div class="surf"><p><em>${esc(c.ui.artist.split('.')[0])}</em>${esc(t.surface)}</p></div>
        <div class="actions"><button type="button" class="btn btn-ghost" data-act="sky" data-planet="${p.id}">${esc(fill(c.ui.lookUp, { p: p.id }))} <span class="arr">→</span></button></div>`,
    });
  });

  const chips = [...PLANETS].reverse().map((p) => `<span data-chip="${p.id}"><b>${p.id}</b>${fmt(chordHz(p.id), chordHz(p.id) % 1 ? 1 : 0)} Hz</span>`).join('');
  out.push({
    id: 'chain',
    hue: '#ffb27a',
    glyph: '∞',
    html: `
      <p class="kicker"><span>${esc(c.chain.kicker)}</span><span class="sep"></span><span class="muted">8:5 · 5:3 · 3:2 · 3:2 · 4:3 · 3:2</span></p>
      <h2>${esc(c.chain.name)}</h2>
      <p class="lede">${esc(c.chain.lede)}</p>
      <p class="lede">${esc(c.chain.sound)}</p>
      <div class="chord" aria-hidden="true">${chips}</div>
      <div class="actions">
        <button type="button" class="btn btn-primary" data-act="listen" aria-pressed="false"><span data-listen-label>${esc(c.chain.listen)}</span></button>
        <button type="button" class="btn btn-ghost" data-act="sky" data-planet="e">${esc(c.chain.standOn)} <span class="arr">→</span></button>
      </div>`,
  });

  out.push({
    id: 'scale',
    hue: '#ff7a45',
    glyph: '×1',
    html: `
      <p class="kicker"><span>${esc(c.scale.name)}</span><span class="sep"></span><span class="muted">${esc(c.scale.kicker)}</span></p>
      <h2>${esc(c.scale.name)}</h2>
      <p class="lede">${esc(c.scale.lede)}</p>
      <p class="lede" style="color:var(--ink-3)">${esc(c.scale.note)}</p>`,
  });
  return out;
}

export function buildSpacers(mount) {
  mount.innerHTML = STOPS.map((id, i) => `<section class="stop" id="${id}" data-id="${id}" data-stop="${i}" aria-hidden="true"></section>`).join('');
  return [...mount.children];
}

export function renderPanels(mount, lang, prevRefs) {
  const items = buildPanels(lang);
  mount.innerHTML = items
    .map((it) => `<article class="panel" id="panel-${it.id}" data-panel="${it.id}" style="--hue:${it.hue}" aria-labelledby="h-${it.id}">${it.glyph ? `<div class="glyph" aria-hidden="true">${esc(it.glyph)}</div>` : ''}${it.html.replace(/<(h1|h2)>/, `<$1 id="h-${it.id}">`)}</article>`)
    .join('');
  return [...mount.children];
}

export function renderRail(list, lang) {
  const c = COPY[lang];
  const items = [];
  items.push({ id: 'star', label: c.rail.star, hue: '#ff7a45', idx: 1 });
  PLANETS.forEach((p, i) => items.push({ id: p.id, label: `${p.id} · ${c.planets[p.id].name}`, hue: p.hue, idx: 2 + i }));
  items.push({ id: 'chain', label: c.rail.chain, hue: '#ffb27a', idx: 9 });
  items.push({ id: 'scale', label: c.rail.scale, hue: '#ff7a45', idx: 10 });
  list.innerHTML = items
    .map((it) => `<li class="rail-item" data-idx="${it.idx}" style="--hue:${it.hue}"><a href="#${it.id}"><span class="rail-dot"></span><span class="rail-lab">${esc(it.label)}</span></a></li>`)
    .join('');
  return [...list.children];
}

// --------------------------------------------------------------------------------------
// Data section: semantic table + two single-series charts (radius, starlight)
// --------------------------------------------------------------------------------------

function tableHtml(c, fmt) {
  const head = c.data.cols.map((h, i) => `<th scope="col">${esc(h)}${c.data.colsUnits[i] ? `<small>${esc(c.data.colsUnits[i])}</small>` : ''}</th>`).join('');
  const rows = PLANETS.map(
    (p) => `<tr style="--hue:${p.hue}">
      <th scope="row" style="text-align:left;font-weight:300"><span class="dot"></span>${p.id}</th>
      <td>${fmt(p.radius, 3)}</td><td>${fmt(p.mass, 3)}</td><td>${fmt(p.period, 3)}</td>
      <td>${fmt(p.orbitKm / 1e6, 2)}</td><td>${fmt(p.teq, 0)}</td><td>${fmt(p.flux, 2)}</td><td>${fmt(p.g, 2)}</td></tr>`,
  ).join('');
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(c.data.title)}"><table class="t"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const ROW_H = 38;
const CH_W = 520;
const LABEL_W = 30;
const PLOT_L = LABEL_W + 10;
const PLOT_R = CH_W - 64;

function roundedBar(x, y, w, h, r = 4) {
  // square at the baseline (left), rounded data end (right)
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 -${rr},${rr}h-${w - rr}z`;
}

function radiusChart(c, fmt) {
  const max = 1.25;
  const top = 26;
  const H = top + PLANETS.length * ROW_H + 26;
  const xs = (v) => PLOT_L + (v / max) * (PLOT_R - PLOT_L);
  const ticks = [0, 0.5, 1, 1.25];
  let s = `<svg viewBox="0 0 ${CH_W} ${H}" role="img" aria-label="${esc(c.data.radiusChart)}">`;
  ticks.forEach((t) => {
    s += `<line class="grid" x1="${xs(t)}" x2="${xs(t)}" y1="${top - 6}" y2="${H - 22}"/>`;
    s += `<text class="axis-t" x="${xs(t)}" y="${H - 6}" text-anchor="middle">${fmt(t, t % 1 ? 2 : 0)}</text>`;
  });
  PLANETS.forEach((p, i) => {
    const y = top + i * ROW_H;
    const bh = 16;
    const by = y + (ROW_H - bh) / 2;
    const w = xs(p.radius) - PLOT_L;
    s += `<g class="row" data-i="${i}"><rect class="hit" x="0" y="${y}" width="${CH_W}" height="${ROW_H}"/>`;
    s += `<text class="lab-strong" x="0" y="${by + 12.5}">${p.id}</text>`;
    s += `<path class="mark" d="${roundedBar(PLOT_L, by, w, bh)}"/>`;
    s += `<text class="lab" x="${PLOT_L + w + 8}" y="${by + 12.5}">${fmt(p.radius, 2)}</text></g>`;
  });
  s += `<line class="ref" x1="${xs(1)}" x2="${xs(1)}" y1="${top - 12}" y2="${H - 22}"/>`;
  s += `<text class="axis-t" x="${xs(1) + 6}" y="${top - 14}" style="fill:var(--ink)">${esc(c.data.earthMark)}</text>`;
  s += `</svg>`;
  return s;
}

function lightChart(c, fmt) {
  const lo = 0.1;
  const hi = 5;
  const top = 26;
  const H = top + PLANETS.length * ROW_H + 26;
  const xs = (v) => PLOT_L + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (PLOT_R - PLOT_L);
  const ticks = [0.1, 0.25, 0.5, 1, 2, 4];
  let s = `<svg viewBox="0 0 ${CH_W} ${H}" role="img" aria-label="${esc(c.data.lightChart)}">`;
  ticks.forEach((t) => {
    s += `<line class="grid" x1="${xs(t)}" x2="${xs(t)}" y1="${top - 6}" y2="${H - 22}"/>`;
    s += `<text class="axis-t" x="${xs(t)}" y="${H - 6}" text-anchor="middle">${fmt(t, t < 1 ? 2 : 0)}</text>`;
  });
  PLANETS.forEach((p, i) => {
    const y = top + i * ROW_H;
    const cy = y + ROW_H / 2;
    s += `<g class="row" data-i="${i}"><rect class="hit" x="0" y="${y}" width="${CH_W}" height="${ROW_H}"/>`;
    s += `<text class="lab-strong" x="0" y="${cy + 4.5}">${p.id}</text>`;
    s += `<line class="grid" x1="${PLOT_L}" x2="${xs(p.flux)}" y1="${cy}" y2="${cy}" style="stroke:var(--line-2)"/>`;
    s += `<circle class="mark-dot" cx="${xs(p.flux)}" cy="${cy}" r="5.5"/>`;
    s += `<text class="lab" x="${xs(p.flux) + 12}" y="${cy + 4.5}">${fmt(p.flux, 2)}</text></g>`;
  });
  s += `<line class="ref" x1="${xs(1)}" x2="${xs(1)}" y1="${top - 12}" y2="${H - 22}"/>`;
  s += `<text class="axis-t" x="${xs(1) + 6}" y="${top - 14}" style="fill:var(--ink)">${esc(c.data.earthMark)}</text>`;
  s += `</svg>`;
  return s;
}

export function renderData(mount, lang) {
  const c = COPY[lang];
  const fmt = makeFormatter(lang);
  mount.innerHTML = `<div class="doc-inner">
    <h2 id="data-title">${esc(c.data.title)}</h2>
    <p class="sub">${esc(c.data.sub)}</p>
    ${tableHtml(c, fmt)}
    <h3 class="small">${esc(c.data.chartsTitle)}</h3>
    <div class="charts">
      <figure class="chart" data-chart="radius" style="margin:0"><h3>${esc(c.data.radiusChart)}</h3><p class="note">${esc(c.ui.earthRadii)}</p>${radiusChart(c, fmt)}<div class="tip"></div></figure>
      <figure class="chart" data-chart="light" style="margin:0"><h3>${esc(c.data.lightChart)}</h3><p class="note">${esc(c.data.lightNote)}</p>${lightChart(c, fmt)}<div class="tip"></div></figure>
    </div>
  </div>`;
  wireChartTips(mount, c, fmt);
}

function wireChartTips(root, c, fmt) {
  root.querySelectorAll('.chart').forEach((fig) => {
    const tip = fig.querySelector('.tip');
    const kind = fig.dataset.chart;
    fig.querySelectorAll('.row').forEach((row) => {
      const p = PLANETS[Number(row.dataset.i)];
      const show = (ev) => {
        const r = fig.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        const detail =
          kind === 'radius'
            ? `${fmt(p.radius, 3)} ${c.ui.earthRadii} <span>· ${fmt(Math.round(p.radius * R_EARTH_KM), 0)} ${c.ui.km}</span>`
            : `${fmt(p.flux, 3)} ${c.ui.earthLight} <span>· ${fmt(p.teq, 0)} K</span>`;
        tip.innerHTML = `<b>TRAPPIST-1 ${p.id}</b> ${detail}`;
        const x = ev && ev.clientX ? ev.clientX - r.left : (b.left + b.width * 0.5) - r.left;
        tip.style.left = `${Math.max(90, Math.min(r.width - 90, x))}px`;
        tip.style.top = `${b.top - r.top + b.height * 0.2}px`;
        tip.classList.add('on');
      };
      row.addEventListener('pointermove', show);
      row.addEventListener('pointerdown', show);
      row.addEventListener('pointerleave', () => tip.classList.remove('on'));
    });
  });
}

export function renderOutro(mount, lang) {
  const c = COPY[lang];
  mount.innerHTML = `<div class="doc-inner">
    <div class="outro-grid">
      <div>
        <h2>${esc(c.outro.title)}</h2>
        <p class="sub">${esc(c.outro.lede)}</p>
        <div class="actions"><button type="button" class="btn btn-primary" data-act="explore">${esc(c.outro.cta)} <span class="arr">→</span></button>
        <button type="button" class="btn btn-ghost" data-act="sky" data-planet="e">${esc(fill(c.ui.standOn, { p: 'e' }))} <span class="arr">→</span></button></div>
      </div>
      <div>
        <h3 class="small">${esc(c.outro.sources)}</h3>
        <ul class="src">
          <li>${esc(c.outro.s1)} <a href="https://doi.org/10.1038/nature21360" target="_blank" rel="noopener">doi:10.1038/nature21360</a></li>
          <li>${esc(c.outro.s2)} <a href="https://doi.org/10.3847/PSJ/abd022" target="_blank" rel="noopener">doi:10.3847/PSJ/abd022</a></li>
          <li>${esc(c.outro.s3)}</li>
          <li>${esc(c.outro.s4)} <a href="https://exoplanetarchive.ipac.caltech.edu/overview/TRAPPIST-1" target="_blank" rel="noopener">↗</a></li>
        </ul>
        <p class="fine">${esc(c.outro.note)}</p>
      </div>
    </div>
    <div class="credits"><span>${esc(c.outro.built)}</span><span>TRAPPIST-1 · ${esc(STAR.spectral)} · ${esc(String(STAR.distLy).replace('.', lang === 'pl' ? ',' : '.'))} ly</span></div>
  </div>`;
}

/** Apply [data-i18n] text for the static skeleton in index.html. */
export function applyStaticText(lang) {
  const c = COPY[lang];
  document.documentElement.lang = lang;
  document.title = c.meta.title;
  const md = document.querySelector('meta[name="description"]');
  if (md) md.setAttribute('content', c.meta.description);
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = el.dataset.i18n.split('.').reduce((o, k) => (o ? o[k] : undefined), c);
    if (typeof v === 'string') el.textContent = v;
  });
  const sub = document.getElementById('loader-sub');
  if (sub) sub.textContent = c.hero.title;
  const canvas = document.getElementById('gl');
  if (canvas) canvas.setAttribute('aria-label', c.a11y.canvas);
  const rail = document.getElementById('rail');
  if (rail) rail.setAttribute('aria-label', c.a11y.rail);
  document.querySelectorAll('#lang-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}

export { esc, fill, byId };
