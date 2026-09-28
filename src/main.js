import './styles.css';
import { Engine } from './gl/engine.js';
import { COPY, detectLang } from './content.js';
import {
  STOPS,
  buildSpacers,
  renderPanels,
  renderRail,
  renderData,
  renderOutro,
  applyStaticText,
  makeFormatter,
} from './ui.js';
import { Story } from './story.js';
import { Sound } from './audio.js';
import { Explore } from './explore.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const state = { lang: detectLang(), mode: 'loading', sound: false, started: false };
const clock = { days: 0, rate: 0.012 };
const hooks = { explore: null, audio: null };

try {
  history.scrollRestoration = 'manual';
} catch {}

function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

const toastEl = $('#toast');
let toastT = 0;
export function toast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('on'), ms);
}

// -------------------------------------------------------------------------------------
// DOM assembly
// -------------------------------------------------------------------------------------
const mounts = {
  spacers: $('#story'),
  panels: $('#panels'),
  rail: $('#rail-list'),
  data: $('#data'),
  outro: $('#outro'),
};

let refs = { spacers: [], panels: [], rail: [] };

function renderAll() {
  applyStaticText(state.lang);
  refs.panels = renderPanels(mounts.panels, state.lang);
  refs.rail = renderRail(mounts.rail, state.lang);
  renderData(mounts.data, state.lang);
  renderOutro(mounts.outro, state.lang);
  wireListenLabel();
}

function telemetryContext() {
  const c = COPY[state.lang];
  return {
    fmt: makeFormatter(state.lang),
    units: {
      millionKm: c.ui.millionKm,
      s: c.ui.seconds,
      min: c.ui.minutes,
      trueScale: c.ui.trueScale,
      exaggerated: c.ui.exaggerated,
    },
    mercuryText: c.scale.mercury,
  };
}

// -------------------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------------------
let engine = null;
let story = null;

function enableStaticMode(reason) {
  document.body.classList.remove('is-loading');
  document.body.classList.add('static-mode');
  const c = COPY[state.lang];
  const note = document.createElement('p');
  note.className = 'static-note';
  note.textContent = reason === 'nogl' ? c.a11y.noWebgl : c.a11y.noWebgl;
  mounts.panels.prepend(note);
  refs.panels.forEach((p) => p.style.setProperty('--o', '1'));
  renderData(mounts.data, state.lang);
}

async function boot() {
  refs.spacers = buildSpacers(mounts.spacers);
  renderAll();

  if (!hasWebGL2()) {
    enableStaticMode('nogl');
    return;
  }

  const fill = $('#loader-fill');
  const setProgress = (v) => (fill.style.transform = `scaleX(${v})`);
  setProgress(0.12);

  try {
    const q = params.get('q');
    engine = new Engine($('#gl'), { tier: q !== null ? Number(q) : undefined });
  } catch (err) {
    console.warn('WebGL init failed', err);
    enableStaticMode('nogl');
    return;
  }
  engine.resize(innerWidth, innerHeight);

  const fontsReady = Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]);
  await fontsReady;
  setProgress(0.35);

  const els = {
    veil: $('#veil'),
    progress: $('#progress'),
    dist: $('#tele-dist'),
    delay: $('#tele-delay'),
    scale: $('#tele-scale'),
    scaleLabel: $('#scale-label'),
    ...telemetryContext(),
  };
  story = new Story({ engine, clock, spacers: refs.spacers, panels: refs.panels, railItems: refs.rail, els });

  const sound = new Sound({
    engine,
    clock,
    onPing: (i, vel) => {
      if (hooks.explore?.active || story.focusIndex === i) engine.system.ping(i, Math.min(1, 0.4 + vel));
      hooks.explore?.onPing(i);
      const chip = document.querySelector(`[data-chip="${engine.system.planets[i].data.id}"]`);
      if (chip) {
        chip.classList.add('on');
        setTimeout(() => chip.classList.remove('on'), 320);
      }
    },
  });
  const explore = new Explore({ engine, clock, story, sound, getLang: () => state.lang, toast, storyRate: clock.rate });
  hooks.audio = sound;
  hooks.explore = explore;
  hooks.explore.toggle = explore.toggle.bind(explore);

  // Compile every program (planets, atmospheres, clouds, star, post) before the first visible frame.
  try {
    story.update(0.016, 0);
    await Promise.race([engine.renderer.compileAsync(engine.system.scene, engine.camera), new Promise((r) => setTimeout(r, 20000))]);
  } catch (e) {
    console.warn('compileAsync', e);
  }
  setProgress(0.8);
  engine.fx.fade = 0.75;
  document.body.classList.add('is-ready');
  frame(performance.now());
  setProgress(1);

  $('#loader-status').textContent = COPY[state.lang].ui.ready;
  $('#loader-actions').hidden = false;
  $('#enter-sound').focus({ preventScroll: true });
  state.mode = 'ready';
  window.__ready = true;

  $('#scale-label').textContent = COPY[state.lang].scale.mercury;
  wireEvents();
  requestAnimationFrame(loop);
  if (DEBUG) exposeDebug();
}

// -------------------------------------------------------------------------------------
// Main loop
// -------------------------------------------------------------------------------------
const exploreState = { paused: false, focus: -1 };
let last = performance.now();
let seconds = 0;
let introStart = -1;

function frame(now, doRender = true) {
  const dt = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
  last = now;
  seconds += dt;
  clock.days += clock.rate * dt;

  if (introStart >= 0) {
    const t = (now - introStart) / 1000;
    story.intro = Math.min(1, t / 3.4);
    engine.fx.fade = Math.min(1, t / 1.6);
  }

  const m = hooks.explore?.active ? hooks.explore : null;
  if (m) m.update(dt, seconds);
  else story.update(dt, seconds);

  if (doRender) engine.render(clock.days, seconds, dt);
  else engine.system.update(clock.days, seconds, dt, engine.camera, engine.cssH);
  if (hooks.audio?.enabled) {
    let ex = null;
    if (m) {
      ex = exploreState;
      ex.paused = !m.playing;
      ex.focus = m.mode === 'sky' ? m.sky.i : m.focus >= 0 && m.focus < 7 ? m.focus : -1;
    }
    hooks.audio.update(dt, clock, story, ex);
  }
  return dt;
}

function loop(now) {
  const t0 = performance.now();
  if (!document.hidden) {
    const dt = frame(now);
    if (introStart >= 0 && performance.now() - introStart > 2500) engine.govern(Math.min(80, dt * 1000));
  } else {
    last = now;
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
  } catch {}
  renderAll();
  if (story) {
    story.panels = refs.panels;
    story.railItems = refs.rail;
    Object.assign(story.els, telemetryContext());
    if (story.els.scaleLabel) story.els.scaleLabel.textContent = COPY[state.lang].scale.mercury;
    story.activeRail = -1;
  }
  hooks.explore?.relocalize?.(lang);
  hooks.audio?.syncUi?.();
}

function wireListenLabel() {
  hooks.audio?.syncUi?.();
}

function enter(withSound) {
  if (state.started) return;
  state.started = true;
  state.mode = 'story';
  document.body.classList.remove('is-loading');
  window.scrollTo({ top: 0, behavior: 'instant' });
  introStart = performance.now();
  story.layout();
  if (withSound) hooks.audio?.enable?.();
  const hash = location.hash.slice(1);
  const idx = STOPS.indexOf(hash);
  if (idx > 0) setTimeout(() => story.goTo(idx, false), 60);
}

function wireEvents() {
  $('#enter-sound').addEventListener('click', () => enter(true));
  $('#enter-silent').addEventListener('click', () => enter(false));

  addEventListener('resize', () => {
    engine.resize(innerWidth, innerHeight);
    story.layout();
  });
  document.fonts?.ready?.then(() => story.layout());

  document.querySelectorAll('#lang-seg button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  $('#btn-sound').addEventListener('click', () => hooks.audio?.toggle?.());
  $('#btn-explore').addEventListener('click', () => hooks.explore?.toggle?.());

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a && story) {
      const id = a.getAttribute('href').slice(1);
      const idx = STOPS.indexOf(id);
      if (idx >= 0) {
        e.preventDefault();
        try {
          history.replaceState(null, '', `#${id}`);
        } catch {}
        story.goTo(idx);
      }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'sky') hooks.explore?.openSky?.(b.dataset.planet);
    if (act === 'explore') hooks.explore?.open?.();
    if (act === 'listen') hooks.audio?.toggle?.(true);
  });

  document.addEventListener('visibilitychange', () => hooks.audio?.visibility?.(document.hidden));
}

// -------------------------------------------------------------------------------------
// Debug hooks for scripted screenshots
// -------------------------------------------------------------------------------------
function exposeDebug() {
  window.__app = {
    engine,
    story,
    clock,
    state,
    hooks,
    enter,
    /** Jump to stop coordinate s (e.g. 3.35) and render synchronously. */
    at(s, o = {}) {
      if (!state.started) enter(false);
      story.layout();
      const k = Math.min(STOPS.length - 1, Math.floor(s));
      const f = s - k;
      const y = story.tops[k] + f * story.heights[k] - innerHeight * 0.5;
      window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
      story.s = story.coordinate();
      story.sTarget = story.s;
      story.intro = 1;
      introStart = -1;
      engine.fx.fade = 1;
      if (o.days !== undefined) clock.days = o.days;
      last = performance.now();
      for (let i = 0; i < 3; i++) frame(performance.now() + i * 16);
      return { s: story.s, scrollY: window.scrollY };
    },
    frame: () => frame(performance.now()),
    /** Advance n logic frames of `ms` each (no rendering except the last), then render. */
    step(n, ms = 100) {
      for (let k = 0; k < n; k++) {
        last = last + ms - 0;
        frame(last + ms, k === n - 1);
      }
    },
  };
}

boot();
