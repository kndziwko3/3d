import { COPY } from './content.js';
import { PLANETS, STAR, R_EARTH_KM, RESONANCE_CHAIN, SUN_ANGULAR_DEG, chordHz } from './data.js';

export const STOPS = ['hero', 'star', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'chain', 'scale'];
/** Stop index by id, so chapters can be reordered without hunting for magic numbers. */
export const STOP = Object.fromEntries(STOPS.map((id, i) => [id, i]));

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (m) => HTML_ESC[m]);
export const fill = (str, map) => str.replace(/\{(\w+)\}/g, (_, k) => map[k] ?? '');

const formatters = {};
/** Locale-aware number formatter, one Intl.NumberFormat per (language, digits), shared by everyone. */
export function makeFormatter(lang) {
  if (formatters[lang]) return formatters[lang];
  const cache = new Map();
  const locale = lang === 'pl' ? 'pl-PL' : 'en-US';
  return (formatters[lang] = (v, d = 0) => {
    let nf = cache.get(d);
    if (!nf) cache.set(d, (nf = new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d })));
    return nf.format(v).replace(/ /g, ' ');
  });
}

const unitSpan = (t) => `<small>${esc(t)}</small>`;
/** `<div><span>key</span><b>value</b></div>` row used by the explore panel. */
export const kvRow = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;

export function planetStats(p, c, fmt) {
  const km = p.radius * R_EARTH_KM;
  return [
    { k: c.stats.radius, v: fmt(p.radius, 3), u: `${c.ui.earthRadii} · ${fmt(Math.round(km / 10) * 10)} ${c.ui.km}` },
    { k: c.stats.mass, v: fmt(p.mass, 3), u: c.ui.earthRadii },
    { k: c.stats.year, v: fmt(p.period, 2) + unitSpan(' ' + c.ui.days), u: `${fmt(p.period * 24, 0)} ${c.ui.hours}` },
    { k: c.stats.orbit, v: fmt(p.orbitKm / 1e6, 2) + unitSpan(' ' + c.ui.millionKm), u: `${fmt(p.a, 4)} AU` },
    { k: c.stats.temp, v: fmt(p.teq, 0) + unitSpan(' K'), u: `${fmt(p.teq - 273.15, 0)} °C` },
    { k: c.stats.light, v: fmt(p.flux, 2), u: c.ui.earthLight },
    { k: c.stats.gravity, v: fmt(p.g, 2) + unitSpan(' g'), u: fill(c.stats.escape, { v: fmt(p.escapeKms, 1) }) },
    { k: c.stats.sky, v: fmt(p.starAngularDeg / SUN_ANGULAR_DEG, 1) + unitSpan('×'), u: c.stats.skyUnit },
  ];
}

const statsHtml = (cells) =>
  `<dl class="stats">${cells.map((s) => `<div class="stat"><dt>${esc(s.k)}</dt><dd><span class="v">${s.v}</span><span class="u">${esc(s.u)}</span></dd></div>`).join('')}</dl>`;

export const starFacts = (c) => c.star.facts.map(([k, v, u]) => ({ k, v: esc(v), u }));

export function buildPanels(lang) {
  const c = COPY[lang];
  const fmt = makeFormatter(lang);
  const out = [];

  out.push({
    id: 'hero',
    hue: STAR.hue,
    html: `
      <p class="kicker"><span>${esc(c.hero.kicker)}</span></p>
      <h1 id="h-hero">${esc(c.hero.title)}</h1>
      <p class="lede hero-sub">${esc(c.hero.sub)}</p>
      <div class="scroll-hint"><i></i><span>${esc(c.ui.scrollHint)}</span></div>`,
  });

  out.push({
    id: 'star',
    hue: STAR.hue,
    html: `
      <p class="kicker"><span>${esc(c.star.kicker)}</span><span class="sep"></span><span class="muted">TRAPPIST-1</span></p>
      <h2 id="h-star">${esc(c.star.name)}</h2>
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
        <p class="kicker"><span>TRAPPIST-1 ${p.id}</span><span class="sep"></span><span class="muted">${esc(c.ui.chapter)} ${i + 1}/${PLANETS.length}</span></p>
        <h2 id="h-${p.id}">${esc(t.name)}</h2>
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
      <p class="kicker"><span>${esc(c.chain.kicker)}</span><span class="sep"></span><span class="muted">${RESONANCE_CHAIN.join(' · ')}</span></p>
      <h2 id="h-chain">${esc(c.chain.name)}</h2>
      <p class="lede">${esc(c.chain.lede)}</p>
      <p class="lede">${esc(c.chain.sound)}</p>
      <div class="chord" aria-hidden="true">${chips}</div>
      <div class="actions">
        <button type="button" class="btn btn-primary" data-act="listen" aria-pressed="false">${esc(c.chain.listen)}</button>
        <button type="button" class="btn btn-ghost" data-act="sky" data-planet="e">${esc(c.chain.standOn)} <span class="arr">→</span></button>
      </div>`,
  });

  out.push({
    id: 'scale',
    hue: STAR.hue,
    glyph: '×1',
    html: `
      <p class="kicker"><span>${esc(c.scale.name)}</span><span class="sep"></span><span class="muted">${esc(c.scale.kicker)}</span></p>
      <h2 id="h-scale">${esc(c.scale.name)}</h2>
      <p class="lede">${esc(c.scale.lede)}</p>
      <p class="lede" style="color:var(--ink-3)">${esc(c.scale.note)}</p>`,
  });
  return out;
}

export function buildSpacers(mount) {
  mount.innerHTML = STOPS.map((id, i) => `<section class="stop" id="${id}" data-id="${id}" data-stop="${i}" aria-hidden="true"></section>`).join('');
  return [...mount.children];
}

export function renderPanels(mount, lang) {
  mount.innerHTML = buildPanels(lang)
    .map((it) => `<article class="panel" id="panel-${it.id}" data-panel="${it.id}" style="--hue:${it.hue}" aria-labelledby="h-${it.id}">${it.glyph ? `<div class="glyph" aria-hidden="true">${esc(it.glyph)}</div>` : ''}${it.html}</article>`)
    .join('');
  return [...mount.children];
}

export function renderRail(list, lang) {
  const c = COPY[lang];
  const items = [
    { id: 'star', label: c.rail.star, hue: STAR.hue },
    ...PLANETS.map((p) => ({ id: p.id, label: `${p.id} · ${c.planets[p.id].name}`, hue: p.hue })),
    { id: 'chain', label: c.rail.chain, hue: '#ffb27a' },
    { id: 'scale', label: c.rail.scale, hue: STAR.hue },
  ];
  list.innerHTML = items
    .map((it) => `<li class="rail-item" data-idx="${STOP[it.id]}" style="--hue:${it.hue}"><a href="#${it.id}"><span class="rail-dot"></span><span class="rail-lab">${esc(it.label)}</span></a></li>`)
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
      <th scope="row"><span class="dot"></span>${p.id}</th>
      <td>${fmt(p.radius, 3)}</td><td>${fmt(p.mass, 3)}</td><td>${fmt(p.period, 3)}</td>
      <td>${fmt(p.orbitKm / 1e6, 2)}</td><td>${fmt(p.teq, 0)}</td><td>${fmt(p.flux, 2)}</td><td>${fmt(p.g, 2)}</td></tr>`,
  ).join('');
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(c.data.title)}"><table class="t"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const ROW_H = 38;
const CH_W = 520;
const PLOT_L = 40;
const PLOT_R = CH_W - 64;
const CH_TOP = 26;
const CH_H = CH_TOP + PLANETS.length * ROW_H + 26;

function roundedBar(x, y, w, h, r = 4) {
  // square at the baseline (left), rounded data end (right)
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 -${rr},${rr}h-${w - rr}z`;
}

/**
 * Shared frame of both charts: axis ticks, one hit row per planet, the Earth reference line.
 * `xs` maps a value to x; `mark(p, y, cy)` returns the row's mark and value label.
 */
function chartSvg(c, { aria, ticks, tickText, xs, mark }) {
  let s = `<svg viewBox="0 0 ${CH_W} ${CH_H}" role="img" aria-label="${esc(aria)}">`;
  for (const t of ticks) {
    s += `<line class="grid" x1="${xs(t)}" x2="${xs(t)}" y1="${CH_TOP - 6}" y2="${CH_H - 22}"/>`;
    s += `<text class="axis-t" x="${xs(t)}" y="${CH_H - 6}" text-anchor="middle">${tickText(t)}</text>`;
  }
  PLANETS.forEach((p, i) => {
    const y = CH_TOP + i * ROW_H;
    const cy = y + ROW_H / 2;
    s += `<g class="row" data-i="${i}"><rect class="hit" x="0" y="${y}" width="${CH_W}" height="${ROW_H}"/>`;
    s += `<text class="lab-strong" x="0" y="${cy + 4.5}">${p.id}</text>${mark(p, y, cy)}</g>`;
  });
  s += `<line class="ref" x1="${xs(1)}" x2="${xs(1)}" y1="${CH_TOP - 12}" y2="${CH_H - 22}"/>`;
  s += `<text class="axis-t" x="${xs(1) + 6}" y="${CH_TOP - 14}" style="fill:var(--ink)">${esc(c.data.earthMark)}</text></svg>`;
  return s;
}

function radiusChart(c, fmt) {
  const max = 1.25;
  const xs = (v) => PLOT_L + (v / max) * (PLOT_R - PLOT_L);
  return chartSvg(c, {
    aria: c.data.radiusChart,
    ticks: [0, 0.5, 1, 1.25],
    tickText: (t) => fmt(t, t % 1 ? 2 : 0),
    xs,
    mark: (p, y, cy) => {
      const bh = 16;
      const w = xs(p.radius) - PLOT_L;
      return `<path class="mark" d="${roundedBar(PLOT_L, cy - bh / 2, w, bh)}"/><text class="lab" x="${PLOT_L + w + 8}" y="${cy + 4.5}">${fmt(p.radius, 2)}</text>`;
    },
  });
}

function lightChart(c, fmt) {
  const [lo, hi] = [0.1, 5];
  const xs = (v) => PLOT_L + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (PLOT_R - PLOT_L);
  return chartSvg(c, {
    aria: c.data.lightChart,
    ticks: [0.1, 0.25, 0.5, 1, 2, 4],
    tickText: (t) => fmt(t, t < 1 ? 2 : 0),
    xs,
    mark: (p, y, cy) =>
      `<line class="grid" x1="${PLOT_L}" x2="${xs(p.flux)}" y1="${cy}" y2="${cy}" style="stroke:var(--line-2)"/>` +
      `<circle class="mark-dot" cx="${xs(p.flux)}" cy="${cy}" r="5.5"/><text class="lab" x="${xs(p.flux) + 12}" y="${cy + 4.5}">${fmt(p.flux, 2)}</text>`,
  });
}

const CHART_TIP = {
  radius: (p, c, fmt) => `${fmt(p.radius, 3)} ${c.ui.earthRadii} <span>· ${fmt(Math.round(p.radius * R_EARTH_KM), 0)} ${c.ui.km}</span>`,
  light: (p, c, fmt) => `${fmt(p.flux, 3)} ${c.ui.earthLight} <span>· ${fmt(p.teq, 0)} K</span>`,
};

export function renderData(mount, lang) {
  const c = COPY[lang];
  const fmt = makeFormatter(lang);
  mount.innerHTML = `<div class="doc-inner">
    <h2 id="data-title">${esc(c.data.title)}</h2>
    <p class="sub">${esc(c.data.sub)}</p>
    ${tableHtml(c, fmt)}
    <h3 class="small">${esc(c.data.chartsTitle)}</h3>
    <div class="charts">
      <figure class="chart" data-chart="radius"><h3>${esc(c.data.radiusChart)}</h3><p class="note">${esc(c.ui.earthRadii)}</p>${radiusChart(c, fmt)}<div class="tip"></div></figure>
      <figure class="chart" data-chart="light"><h3>${esc(c.data.lightChart)}</h3><p class="note">${esc(c.data.lightNote)}</p>${lightChart(c, fmt)}<div class="tip"></div></figure>
    </div>
  </div>`;
  wireChartTips(mount, c, fmt);
}

function wireChartTips(root, c, fmt) {
  root.querySelectorAll('.chart').forEach((fig) => {
    const tip = fig.querySelector('.tip');
    const detail = CHART_TIP[fig.dataset.chart];
    fig.querySelectorAll('.row').forEach((row) => {
      const p = PLANETS[Number(row.dataset.i)];
      const show = (ev) => {
        const r = fig.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        tip.innerHTML = `<b>TRAPPIST-1 ${p.id}</b> ${detail(p, c, fmt)}`;
        const x = ev.clientX ? ev.clientX - r.left : b.left + b.width * 0.5 - r.left;
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
  const fmt = makeFormatter(lang);
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
          <li>${esc(c.outro.s1)} <a href="https://doi.org/10.1038/nature21360" target="_blank" rel="noopener noreferrer">doi:10.1038/nature21360</a></li>
          <li>${esc(c.outro.s2)} <a href="https://doi.org/10.3847/PSJ/abd022" target="_blank" rel="noopener noreferrer">doi:10.3847/PSJ/abd022</a></li>
          <li>${esc(c.outro.s3)}</li>
          <li>${esc(c.outro.s4)} <a href="https://exoplanetarchive.ipac.caltech.edu/overview/TRAPPIST-1" target="_blank" rel="noopener noreferrer">↗</a></li>
        </ul>
        <p class="fine">${esc(c.outro.note)}</p>
      </div>
    </div>
    <div class="credits"><span>${esc(c.outro.built)}</span><span>TRAPPIST-1 · ${esc(STAR.spectral)} · ${fmt(STAR.distLy, 2)} ly</span></div>
  </div>`;
}

/** Apply [data-i18n] text for the static skeleton in index.html. */
export function applyStaticText(lang) {
  const c = COPY[lang];
  document.documentElement.lang = lang;
  document.title = c.meta.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', c.meta.description);
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = el.dataset.i18n.split('.').reduce((o, k) => o?.[k], c);
    if (typeof v === 'string') el.textContent = v;
  });
  document.getElementById('gl')?.setAttribute('aria-label', c.a11y.canvas);
  document.getElementById('rail')?.setAttribute('aria-label', c.a11y.rail);
  document.querySelectorAll('#lang-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}
