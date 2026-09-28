import './styles.css';
import { Engine } from './gl/engine.js';
import { COPY, detectLang } from './content.js';
import { MERCURY_ORBIT } from './data.js';
import { STOPS, buildSpacers, renderPanels, renderRail, renderData, renderOutro, applyStaticText, makeFormatter } from './ui.js';
import { Story } from './story.js';
import { Sound } from './audio.js';
import { Explore } from './explore.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const state = { lang: detectLang(), started: false, static: false };
const clock = { days: 0, rate: 0.012 }; // simulation days, and days per real second (story pace)

try {
  history.scrollRestoration = 'manual';
} catch {
  // some embedded contexts forbid it; the page then just restores scroll as usual
}

let engine = null;
let story = null;
let sound = null;
let explore = null;

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

const toastEl = $('#toast');
let toastTimer = 0;
function toast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
}

// -------------------------------------------------------------------------------------
// DOM assembly
// -------------------------------------------------------------------------------------
const mounts = { spacers: $('#story'), panels: $('#panels'), rail: $('#rail-list'), data: $('#data'), outro: $('#outro') };
const refs = { spacers: [], panels: [], rail: [] };
const chips = new Map(); // chord chips in the chain panel, flashed on each transit

function addStaticNote() {
  const note = document.createElement('p');
  note.className = 'static-note';
  note.textContent = COPY[state.lang].a11y.noWebgl;
  mounts.panels.prepend(note);
}

function renderAll() {
  applyStaticText(state.lang);
  refs.panels = renderPanels(mounts.panels, state.lang);
  refs.rail = renderRail(mounts.rail, state.lang);
  renderData(mounts.data, state.lang);
  renderOutro(mounts.outro, state.lang);
  chips.clear();
  mounts.panels.querySelectorAll('[data-chip]').forEach((el) => chips.set(el.dataset.chip, el));
  if (state.static) addStaticNote();
  sound?.syncUi();
}

function hudContext() {
  const c = COPY[state.lang];
  return {
    fmt: makeFormatter(state.lang),
    units: { millionKm: c.ui.millionKm, s: c.ui.seconds, min: c.ui.minutes, trueScale: c.ui.trueScale, exaggerated: c.ui.exaggerated },
  };
}

/** No WebGL2: the same content as a plain, readable page. CSS does the layout. */
function enableStaticMode() {
  state.static = true;
  document.body.classList.remove('is-loading');
  document.body.classList.add('static-mode');
  addStaticNote();
}

// -------------------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------------------
async function boot() {
  refs.spacers = buildSpacers(mounts.spacers);
  renderAll();
  wireCommon();

  if (!hasWebGL2()) return enableStaticMode();

  const fill = $('#loader-fill');
  const progress = (v) => (fill.style.transform = `scaleX(${v})`);
  progress(0.12);

  try {
    const q = params.get('q'); // ?q=0|1|2 forces low, medium or high
    engine = new Engine($('#gl'), { tier: ['0', '1', '2'].includes(q) ? Number(q) : undefined });
  } catch (err) {
    console.warn('WebGL init failed', err);
    return enableStaticMode();
  }
  engine.resize(innerWidth, innerHeight);

  await Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]);
  progress(0.35);

  const els = {
    veil: $('#veil'),
    progress: $('#progress'),
    telemetryEl: $('#telemetry'),
    dist: $('#tele-dist'),
    delay: $('#tele-delay'),
    scale: $('#tele-scale'),
    scaleLabel: $('#scale-label'),
    mercuryOrbit: MERCURY_ORBIT,
    ...hudContext(),
  };
  story = new Story({ engine, clock, spacers: refs.spacers, panels: refs.panels, railItems: refs.rail, els });
  sound = new Sound({ clock, onPing: handlePing });
  explore = new Explore({ engine, clock, story, sound, getLang: () => state.lang, toast });
  sound.syncUi();

  // Compile every program (planets, atmospheres, clouds, star, post) before the first visible frame.
  try {
    story.update(0.016, 0);
    await Promise.race([engine.renderer.compileAsync(engine.system.scene, engine.camera), new Promise((r) => setTimeout(r, 20000))]);
  } catch (e) {
    console.warn('compileAsync', e);
  }
  progress(0.8);
  engine.setFade(0.75); // the scene shows through behind the title card
  document.body.classList.add('is-ready');
  frame(performance.now());
  progress(1);

  $('#loader-status').textContent = COPY[state.lang].ui.ready;
  $('#loader-actions').hidden = false;
  $('#enter-sound').focus({ preventScroll: true });
  window.__ready = true;

  wireApp();
  requestAnimationFrame(loop);
  if (DEBUG) exposeDebug();
}

/** A world crossed the line of sight to Earth: pulse it on screen where that means something. */
function handlePing(i, level) {
  if (explore.active || story.focusIndex === i) engine.system.ping(i, Math.min(1, 0.4 + level));
  explore.onPing(i);
  const chip = chips.get(engine.system.planets[i].data.id);
  if (chip) {
    chip.classList.add('on');
    setTimeout(() => chip.classList.remove('on'), 320);
  }
}

// -------------------------------------------------------------------------------------
// Main loop
// -------------------------------------------------------------------------------------
let last = performance.now();
let seconds = 0;

/** One frame at time `now` (ms). draw = false steps the simulation without touching the GPU. */
function frame(now, draw = true) {
  const dt = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
  last = now;
  seconds += dt;
  clock.days += clock.rate * dt;

  engine.advance(clock.days, seconds, dt);
  (explore.active ? explore : story).update(dt, seconds);
  engine.render(seconds, dt, draw);
  if (sound.enabled) sound.update(dt, clock, story, explore.active ? explore.audioState : null);
  return dt;
}

function loop(now) {
  if (document.hidden) last = now;
  else {
    const dt = frame(now);
    if (story.introT > 2.5) engine.govern(Math.min(80, dt * 1000)); // only once the intro has settled
  }
  requestAnimationFrame(loop);
}

// -------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------
function setLang(lang) {
  if (lang === state.lang) return;
  state.lang = lang;
  try {
    localStorage.setItem('t1-lang', lang);
  } catch {
    // storage can be blocked; the choice then lasts for this visit only
  }
  renderAll();
  story?.relocalize({ panels: refs.panels, railItems: refs.rail, els: hudContext() });
  explore?.relocalize();
}

function enter(withSound) {
  if (state.started) return;
  state.started = true;
  document.body.classList.remove('is-loading');
  window.scrollTo({ top: 0, behavior: 'instant' });
  story.layout();
  story.startIntro();
  engine.fadeTo(1, 1.6);
  if (withSound) sound.enable();
  const idx = STOPS.indexOf(location.hash.slice(1));
  if (idx > 0) setTimeout(() => story.goTo(idx, false), 60);
}

/** Behaviour that works with or without WebGL: language switch, in-page links, actions. */
function wireCommon() {
  document.querySelectorAll('#lang-seg button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a && story) {
      const id = a.getAttribute('href').slice(1);
      const idx = STOPS.indexOf(id);
      if (idx >= 0) {
        e.preventDefault();
        try {
          history.replaceState(null, '', `#${id}`);
        } catch {
          // history can be locked down in embedded frames; scrolling still works
        }
        story.goTo(idx);
      }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b || !explore) return;
    const act = b.dataset.act;
    if (act === 'sky') explore.openSky(b.dataset.planet);
    else if (act === 'explore') explore.open();
    else if (act === 'listen') sound.toggle(true);
  });

  document.addEventListener('visibilitychange', () => sound?.visibility(document.hidden));
}

/** WebGL-only behaviour. */
function wireApp() {
  $('#enter-sound').addEventListener('click', () => enter(true));
  $('#enter-silent').addEventListener('click', () => enter(false));
  $('#btn-sound').addEventListener('click', () => sound.toggle());
  $('#btn-explore').addEventListener('click', () => explore.toggle());
  document.fonts?.ready?.then(() => story.layout());

  // Resize: one pass per frame. Phones fire it as the address bar slides during the scroll that drives
  // this page; those small height-only changes keep the render buffer (re-allocating it would hitch).
  let raf = 0;
  let bufW = innerWidth;
  let bufH = innerHeight;
  const coarse = matchMedia('(pointer: coarse)');
  addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      story.layout();
      if (coarse.matches && innerWidth === bufW && Math.abs(innerHeight - bufH) < 0.15 * bufH) return;
      bufW = innerWidth;
      bufH = innerHeight;
      engine.resize(bufW, bufH);
    });
  });
}

// -------------------------------------------------------------------------------------
// Debug hooks for scripted screenshots and tests (?debug)
// -------------------------------------------------------------------------------------
function exposeDebug() {
  window.__app = {
    engine,
    story,
    explore,
    sound,
    clock,
    state,
    enter,
    frame: () => frame(performance.now()),
    /** Jump to stop coordinate s (e.g. 3.35) and render synchronously. */
    at(s, o = {}) {
      if (!state.started) enter(false);
      story.layout();
      const k = Math.min(STOPS.length - 1, Math.floor(s));
      const y = story.tops[k] + (s - k) * story.heights[k] - innerHeight * 0.5;
      window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
      story.jumpTo(story.coordinate());
      engine.setFade(1);
      if (o.days !== undefined) clock.days = o.days;
      last = performance.now();
      for (let i = 0; i < 3; i++) frame(last + 16);
      return { s: story.s, scrollY: window.scrollY };
    },
    /** Advance n logic frames of `ms` each, drawing only the last. */
    step(n, ms = 100) {
      for (let k = 0; k < n; k++) frame(last + ms, k === n - 1);
    },
  };
}

boot();
