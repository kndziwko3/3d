import * as THREE from 'three';
import { COPY } from './content.js';
import { PLANETS, STAR, MOON_ANGULAR_DEG, SUN_ANGULAR_DEG, EXAG, RESONANCE_CHAIN, angularDiameterDeg, sphereAngularDeg } from './data.js';
import { makeFormatter, esc, fill, kvRow } from './ui.js';
import { UP, D2R, clamp, lerp, glerp, easeInOut, ease } from './math.js';
import { isSheet } from './layout.js';

const N_WORLDS = PLANETS.length;
const STAR_INDEX = N_WORLDS; // focus id of the star; worlds are 0..N_WORLDS-1, -1 is the overview
const isWorld = (i) => i >= 0 && i < N_WORLDS;
const OVERVIEW_DIST = 4700;
const RATE_MIN = -2;
const RATE_MAX = 1.7;
const SKY_FOV = 76;
const SKY_LIFT = 0.2; // fraction of the height the subject is lifted to clear a bottom sheet
const OPT_KEYS = { t: 'trueScale', o: 'orbits', l: 'labels', c: 'clock' };

const ICON_PAUSE = '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="1.5" width="3" height="11"/><rect x="8.5" y="1.5" width="3" height="11"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9-5.5z"/></svg>';

const screenX = (ndc, w) => (ndc.x * 0.5 + 0.5) * w;
const screenY = (ndc, h) => (-ndc.y * 0.5 + 0.5) * h;
/** Apparent radius in pixels of a body `deg` wide, small-angle form. */
const apparentPx = (deg, fov, h) => (deg / fov) * h;

const setBodyMode = (mode) => {
  const cl = document.body.classList;
  cl.toggle('is-explore', mode === 'explore');
  cl.toggle('is-sky', mode === 'sky');
  if (mode === 'story') cl.remove('is-dragging');
};

const worldButton = (attr, p) => `<button type="button" class="fbtn" data-${attr}="${p.index}" style="--hue:${p.hue}" aria-pressed="false"><i></i>${p.id}</button>`;

export class Explore {
  constructor({ engine, clock, story, sound, getLang, toast }) {
    this.engine = engine;
    this.clock = clock;
    this.story = story;
    this.sound = sound;
    this.getLang = getLang;
    this.toast = toast;
    this.storyRate = clock.rate; // restored when we leave

    this.active = false;
    this.mode = 'orrery'; // or 'sky'
    this.focus = -1;
    this.playing = true;
    this.rateLog = -0.3;
    this.opts = { orbits: true, labels: true, trueScale: false, clock: true };

    // orbit camera
    this.target = new THREE.Vector3();
    this.fromTarget = new THREE.Vector3();
    this.yaw = this.yawS = 0.6;
    this.pitch = this.pitchS = 0.5;
    this.dist = this.fromDist = this.toDist = OVERVIEW_DIST;
    this.tFocus = 1;
    this.idle = 0;
    this.exag = { p: EXAG.story.p, s: EXAG.story.s }; // current, tweened towards _exagTarget()
    this.offset = { x: 0, y: 0 }; // smoothed subject offset, see Engine.commitCamera

    // sky camera
    this.sky = { i: 3, vantage: 'terminator', yaw: 0.5, pitch: 0.45, fov: SKY_FOV, fovT: SKY_FOV, track: -1 };
    this.skyTags = null;

    this.view = {}; // filled and applied every frame, see Engine.applyView
    this.pointers = new Map();
    this.down = null;
    this.pinch = 0;
    this.pingTimers = new Map();
    this._audio = { paused: false, focus: -1 };
    this._lastText = 0;
    this._lastTime = 0;
    this._clockDays = NaN;

    for (const k of ['_v', '_w', '_P', '_r', '_t', '_n', '_h', '_e2', '_dir']) this[k] = new THREE.Vector3();

    this.root = document.getElementById('explore-ui');
    this.labelsRoot = document.getElementById('labels');
    this.ui = null;
    this.labels = null;
    this._wireInput();
    this._wirePanel();
  }

  // ------------------------------------------------------------------ helpers
  get c() {
    return COPY[this.getLang()];
  }
  get rate() {
    return Math.pow(10, this.rateLog);
  }
  /** The focused world, or -1 for the star and the overview. */
  get worldFocus() {
    return isWorld(this.focus) ? this.focus : -1;
  }
  /** What the score needs to know each frame (the object is reused). */
  get audioState() {
    this._audio.paused = !this.playing;
    this._audio.focus = this.mode === 'sky' ? this.sky.i : this.worldFocus;
    return this._audio;
  }

  _exagTarget() {
    return this.opts.trueScale ? EXAG.scale : EXAG.readable;
  }
  _bodyPos(idx, out) {
    return idx === STAR_INDEX ? out.set(0, 0, 0) : out.copy(this.engine.system.planets[idx].pos);
  }
  _bodyRadius(idx) {
    const { exag } = this.engine.system;
    return idx === STAR_INDEX ? STAR.radius * exag.star : PLANETS[idx].radius * exag.planet;
  }
  /** Camera distance that frames a focus target the way the story frames its planets. */
  _focusDist(idx) {
    const t = this._exagTarget();
    if (idx === -1) return OVERVIEW_DIST;
    return idx === STAR_INDEX ? STAR.radius * t.s * 4.2 : PLANETS[idx].radius * t.p * 6.5;
  }

  // ------------------------------------------------------------------ open / close
  open(focus = -1) {
    if (this.active && this.mode === 'orrery') return;
    if (!this.active) this._begin();
    if (this.mode === 'sky') this._leaveSky(false);
    this.setFocus(focus);
  }

  toggle() {
    if (this.active) this.close();
    else this.open(-1);
  }

  _begin() {
    const cam = this.engine.camera;
    this.active = true;
    this.mode = 'orrery';
    setBodyMode('explore');
    this._build();
    this.root.hidden = false;
    // continue smoothly from wherever the story camera is
    const look = this.story.pose.look;
    const off = this._v.copy(cam.position).sub(look);
    this.target.copy(look);
    this.fromTarget.copy(look);
    this.dist = Math.max(off.length(), 1);
    this.yaw = this.yawS = Math.atan2(off.x, off.z);
    this.pitch = this.pitchS = Math.asin(clamp(off.y / this.dist, -1, 1));
    this.exag.p = this.engine.system.exag.planet;
    this.exag.s = this.engine.system.exag.star;
    this.offset.x = this.story.pose.shiftX;
    this.offset.y = this.story.pose.shiftY;
    this.clock.rate = this.playing ? this.rate : 0;
    this._syncUi();
    this._syncFocusUi();
    this._layoutLabels();
    document.getElementById('btn-explore').classList.add('is-on');
    this._setExploreButtonText();
  }

  close() {
    if (!this.active) return;
    if (this.mode === 'sky') this._leaveSky(false);
    this.active = false;
    setBodyMode('story');
    this.root.hidden = true;
    this._clearLabels();
    this.clock.rate = this.storyRate;
    this.story.blendFrom(this.engine.camera);
    this.engine.setFade(1);
    document.getElementById('btn-explore').classList.remove('is-on');
    this._setExploreButtonText();
  }

  _setExploreButtonText() {
    const el = document.querySelector('#btn-explore .ctl-txt');
    if (el) el.textContent = this.active ? this.c.ui.backToStory : this.c.ui.explore;
  }

  openSky(planetId) {
    const i = Math.max(0, PLANETS.findIndex((p) => p.id === planetId));
    if (!this.active) this._begin();
    this._enterSky(i, this.sky.vantage);
  }

  // ------------------------------------------------------------------ focus
  setFocus(idx) {
    this.focus = idx;
    this.fromTarget.copy(this.target);
    this.fromDist = this.dist;
    this.toDist = this._focusDist(idx);
    this.tFocus = 0;
    if (idx === -1) this.pitch = Math.max(this.pitch, 0.45);
    this._syncFocusUi();
    this._syncUi();
    this.labels?.forEach((l, k) => l.el.classList.toggle('on', k === idx));
  }

  // ------------------------------------------------------------------ sky mode
  _enterSky(i, vantage) {
    const sky = this.sky;
    this.mode = 'sky';
    sky.i = i;
    sky.vantage = vantage;
    sky.yaw = vantage === 'terminator' ? 0.55 : 0;
    sky.pitch = vantage === 'substellar' ? 0.9 : vantage === 'antistellar' ? 0.5 : 0.45;
    sky.fov = sky.fovT = SKY_FOV;
    sky.track = -1;
    setBodyMode('sky');
    this.exag.p = this.exag.s = EXAG.scale.p; // the sky is always true scale
    this._clearLabels();
    this.engine.setFade(0);
    this.engine.fadeTo(1, 0.9);
    this._buildSkyTags();
    this._syncUi();
  }

  _leaveSky(back = true) {
    this.mode = 'orrery';
    setBodyMode('explore');
    this.skyTags?.forEach((t) => t.el.remove());
    this.skyTags = null;
    this.engine.camera.fov = 38;
    this._layoutLabels();
    if (back) {
      const i = this.sky.i;
      this.target.copy(this.engine.system.planets[i].pos);
      this.fromTarget.copy(this.target);
      this.dist = PLANETS[i].radius * 8;
      this.setFocus(i);
      this.engine.setFade(0);
      this.engine.fadeTo(1, 0.8);
    }
    this._syncUi();
  }

  /** Local frame of the observer: P surface point, n vertical, h horizontal towards the star. */
  _updateBasis() {
    const P = this._P.copy(this.engine.system.planets[this.sky.i].pos);
    const r = this._r.copy(P).normalize(); // star -> planet
    const t = this._t.set(-r.z, 0, r.x);
    const n = this._n;
    const v = this.sky.vantage;
    if (v === 'substellar') n.copy(r).negate();
    else if (v === 'antistellar') n.copy(r);
    else n.copy(t).multiplyScalar(Math.cos(35 * D2R)).addScaledVector(UP, Math.sin(35 * D2R)).normalize();
    const h = this._h.copy(r).negate(); // towards the star, flattened onto the horizon
    h.addScaledVector(n, -h.dot(n));
    if (h.lengthSq() < 1e-6) h.copy(t);
    h.normalize();
  }

  _updateSky(dt) {
    const eng = this.engine;
    const cam = eng.camera;
    const sky = this.sky;
    this._updateBasis();
    const n = this._n;
    const h = this._h;
    cam.position.copy(this._P).addScaledVector(n, PLANETS[sky.i].radius * 1.0004);
    const e2 = this._e2.crossVectors(n, h).normalize();
    sky.fov = lerp(sky.fov, sky.fovT, ease(5, dt));
    if (sky.track >= 0) {
      const d = this._v.copy(eng.system.planets[sky.track].pos).sub(cam.position);
      const pitchT = Math.asin(clamp(d.dot(n) / d.length(), -1, 1));
      if (pitchT < -0.03) sky.track = -1; // it has set
      else {
        let dy = Math.atan2(d.dot(e2), d.dot(h)) - sky.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // shortest way round
        const k = ease(6, dt);
        sky.yaw += dy * k;
        sky.pitch += (pitchT - sky.pitch) * k;
      }
    }
    const cp = Math.cos(sky.pitch);
    const dir = this._dir.set(0, 0, 0).addScaledVector(h, Math.cos(sky.yaw) * cp).addScaledVector(e2, Math.sin(sky.yaw) * cp).addScaledVector(n, Math.sin(sky.pitch));
    cam.up.copy(n);
    cam.fov = sky.fov;
    cam.lookAt(this._v.copy(cam.position).add(dir));
    eng.commitCamera(0, isSheet() ? SKY_LIFT : 0);
    eng.system.horizon.update(cam, n, this._v.copy(cam.position).negate().normalize());

    const v = this.view;
    v.exagP = v.exagS = EXAG.scale.p;
    v.orbits = v.markers = v.mercury = 0;
    v.focus = -1;
    v.hidden = sky.i;
    v.exposure = 1.05;
    v.bloom = 0.8;
    v.flare = 1;
    eng.applyView(v);
  }

  /** Point the sky camera at world k and zoom to see it as a disc. */
  _aimAt(k) {
    if (k === this.sky.i) return;
    this.sky.track = k;
    const d = this.engine.system.planets[k].pos.distanceTo(this.engine.camera.position);
    this.sky.fovT = clamp(angularDiameterDeg(PLANETS[k].radius, d) * 6, 2.5, 40);
  }

  _aimLargest() {
    const cam = this.engine.camera;
    let best = -1;
    let bestDeg = 0;
    for (const p of PLANETS) {
      if (p.index === this.sky.i) continue;
      const d = this._v.copy(this.engine.system.planets[p.index].pos).sub(cam.position);
      const dist = d.length();
      if (d.dot(this._n) / dist < 0.03) continue; // below the horizon
      const deg = angularDiameterDeg(p.radius, dist);
      if (deg > bestDeg) [bestDeg, best] = [deg, p.index];
    }
    if (best >= 0) this._aimAt(best);
    else this.toast(this.c.explore.belowHorizon);
  }

  _wideView() {
    this.sky.track = -1;
    this.sky.fovT = SKY_FOV;
  }

  _buildSkyTags() {
    this.skyTags?.forEach((t) => t.el.remove());
    const make = (label, onClick) => {
      const el = document.createElement('div');
      el.className = 'sky-tag';
      el.innerHTML = `<span>${label}</span><small></small>`;
      if (onClick) el.addEventListener('click', onClick);
      this.labelsRoot.appendChild(el);
      return { el, text: el.lastElementChild, opacity: '', edge: false, transform: '', label: '' };
    };
    this.skyTags = [...PLANETS.map((p) => make(p.id, () => this._aimAt(p.index))), make('★')];
  }

  /** Write a tag's state, touching the DOM only where something changed. mode: 0 hidden, 1 shown, 2 pinned to the edge. */
  _setTag(tag, mode, x, y, label) {
    const opacity = mode === 0 ? '0' : mode === 2 ? '0.75' : '1';
    if (tag.opacity !== opacity) tag.el.style.opacity = tag.opacity = opacity;
    if (tag.edge !== (mode === 2)) tag.el.classList.toggle('edge', (tag.edge = mode === 2));
    if (mode !== 0) {
      const transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
      if (tag.transform !== transform) tag.el.style.transform = tag.transform = transform;
    }
    if (label !== undefined && tag.label !== label) tag.text.textContent = tag.label = label;
  }

  _updateSkyTags(now) {
    const eng = this.engine;
    const cam = eng.camera;
    const w = eng.cssW;
    const h = eng.cssH;
    const fmt = makeFormatter(this.getLang());
    const x = this.c.explore;
    const text = now - this._lastText > 0.25;
    if (text) this._lastText = now;
    let best = { deg: 0, id: '' };
    let starDeg = 0;

    for (let k = 0; k <= STAR_INDEX; k++) {
      const tag = this.skyTags[k];
      const isStar = k === STAR_INDEX;
      if (k === this.sky.i) {
        this._setTag(tag, 0);
        continue;
      }
      const pos = this._bodyPos(k, this._w);
      const d = this._v.copy(pos).sub(cam.position);
      const dist = d.length();
      const deg = isStar ? sphereAngularDeg(STAR.radius, dist) : angularDiameterDeg(PLANETS[k].radius, dist);
      if (isStar) starDeg = deg;
      const above = d.dot(this._n) / dist > -0.02;
      if (!isStar && above && deg > best.deg) best = { deg, id: PLANETS[k].id }; // only worlds you can actually see
      const ndc = pos.project(cam);
      const onScreen = above && ndc.z < 1 && Math.abs(ndc.x) < 0.98 && Math.abs(ndc.y) < 0.95;
      if (onScreen) {
        const px = apparentPx(deg, cam.fov, h);
        const name = isStar ? x.sunWord : x.moonWord;
        const ratio = deg / (isStar ? SUN_ANGULAR_DEG : MOON_ANGULAR_DEG);
        this._setTag(tag, 1, screenX(ndc, w), screenY(ndc, h) + Math.max(isStar ? 16 : 14, px * (isStar ? 1.3 : 1.2)), text ? `${fmt(deg, 2)}° · ${fmt(ratio, 1)}× ${name}` : undefined);
      } else if (above && !isStar) {
        // above the horizon but off-screen: pin a small marker to the screen edge
        const cx = ndc.z < 1 ? ndc.x : -ndc.x;
        const cy = ndc.z < 1 ? ndc.y : -ndc.y;
        const m = Math.max(Math.abs(cx), Math.abs(cy), 1e-3);
        this._setTag(tag, 2, (clamp(cx / m, -1, 1) * 0.93 * 0.5 + 0.5) * w, (-clamp(cy / m, -1, 1) * 0.88 * 0.5 + 0.5) * h, '');
      } else {
        this._setTag(tag, 0);
      }
    }

    if (text) {
      const { skyBig, skyWho, skyStar } = this.ui;
      skyBig.textContent = `${fmt(best.deg / MOON_ANGULAR_DEG, 1)}×`;
      skyWho.textContent = `${x.biggest}: ${best.id} · ${fmt(best.deg, 2)}° ${x.moon}`;
      skyStar.textContent = fill(x.starSize, { n: fmt(starDeg / SUN_ANGULAR_DEG, 1) });
    }
  }

  // ------------------------------------------------------------------ per-frame
  update(dt, seconds) {
    const eng = this.engine;
    const cam = eng.camera;

    this.clock.rate = this.playing ? this.rate : 0;

    if (this.mode === 'sky') {
      this._updateSky(dt);
      this._updateSkyTags(seconds);
      this._updateTimeText(seconds);
      return;
    }

    // exaggeration tween (the true-scale toggle moves the target)
    const goal = this._exagTarget();
    const kx = ease(3.4, dt);
    this.exag.p = glerp(this.exag.p, goal.p, kx);
    this.exag.s = glerp(this.exag.s, goal.s, kx);

    // focus tracking
    if (this.tFocus < 1) this.tFocus = Math.min(1, this.tFocus + dt / 1.5);
    const e = easeInOut(this.tFocus);
    const fp = this.focus === -1 ? this._P.set(0, 0, 0) : this._bodyPos(this.focus, this._P);
    this.target.lerpVectors(this.fromTarget, fp, e);
    if (this.tFocus < 1) this.dist = glerp(this.fromDist, this.toDist, e);
    this.dist = clamp(this.dist, this.focus === -1 ? 60 : this._bodyRadius(this.focus) * 1.7, 16000);

    this.idle += dt;
    if (this.idle > 4 && this.tFocus >= 1 && !this.story.reduced) this.yaw += dt * 0.035;
    const ks = ease(9, dt);
    this.yawS = lerp(this.yawS, this.yaw, ks);
    this.pitchS = lerp(this.pitchS, this.pitch, ks);
    const cp = Math.cos(this.pitchS);
    cam.position.set(Math.sin(this.yawS) * cp, Math.sin(this.pitchS), Math.cos(this.yawS) * cp).multiplyScalar(this.dist).add(this.target);
    cam.up.copy(UP);
    cam.lookAt(this.target);
    cam.fov = lerp(cam.fov, 38, ks);
    // keep the subject clear of the side panel (wide screens) or the bottom sheet (phones)
    const sheet = isSheet();
    this.offset.x = lerp(this.offset.x, sheet ? 0 : -0.09, ks);
    this.offset.y = lerp(this.offset.y, sheet ? SKY_LIFT : 0, ks);
    eng.commitCamera(this.offset.x, this.offset.y);

    const v = this.view;
    v.exagP = this.exag.p;
    v.exagS = this.exag.s;
    v.orbits = this.opts.orbits ? 0.85 : 0;
    v.markers = 1;
    v.mercury = 0;
    v.focus = this.worldFocus;
    v.hidden = -1;
    v.exposure = 1;
    v.bloom = this.exag.p > 5 ? 0.75 : 0.9;
    v.flare = 0.6;
    eng.applyView(v);

    this._updateLabels();
    this._updateClock();
    this._updateTimeText(seconds);
  }

  // ------------------------------------------------------------------ input
  _wireInput() {
    const canvas = document.getElementById('gl');
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      canvas.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.down = { t: performance.now(), moved: 0 };
      this.idle = 0;
      if (this.pointers.size === 2) this.pinch = this._pointerSpan();
      document.body.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!this.active || !p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.idle = 0;
      if (this.down) this.down.moved += Math.abs(dx) + Math.abs(dy);
      if (this.pointers.size === 2) {
        const span = this._pointerSpan();
        if (this.pinch > 0) this._zoom(this.pinch / span);
        this.pinch = span;
      } else if (this.mode === 'sky') {
        const s = this.sky.fov / SKY_FOV;
        this.sky.track = -1;
        this.sky.yaw += dx * 0.0042 * s;
        this.sky.pitch = clamp(this.sky.pitch + dy * 0.0042 * s, -0.12, 1.5);
      } else {
        this.yaw -= dx * 0.0055;
        this.pitch = clamp(this.pitch + dy * 0.0055, -1.45, 1.45);
        this.tFocus = Math.max(this.tFocus, 0.999);
      }
    });
    const release = (e) => {
      if (!this.active) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = 0;
      if (this.pointers.size > 0) return;
      document.body.classList.remove('is-dragging');
      const d = this.down;
      if (d && d.moved < 7 && performance.now() - d.t < 450 && this.mode === 'orrery') this._pick(e.clientX, e.clientY);
      this.down = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        this.idle = 0;
        this._zoom(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0012)));
      },
      { passive: false },
    );
    document.addEventListener('keydown', (e) => this._onKey(e));
  }

  _pointerSpan() {
    const [a, b] = this.pointers.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _zoom(factor) {
    if (this.mode === 'sky') {
      this.sky.fovT = clamp(this.sky.fovT * factor, 2.5, 96);
      this.sky.fov = clamp(this.sky.fov * factor, 2.5, 96);
    } else {
      this.tFocus = 1;
      this.dist *= factor;
    }
  }

  _pick(x, y) {
    const cam = this.engine.camera;
    const { cssW: w, cssH: h } = this.engine;
    let best = null;
    let bestD = 30;
    for (let idx = 0; idx <= STAR_INDEX; idx++) {
      const pos = this._bodyPos(idx, this._w);
      const dist = this._v.copy(pos).sub(cam.position).length();
      const ndc = pos.project(cam);
      if (ndc.z > 1) continue;
      const rpx = (this._bodyRadius(idx) / dist) * (h / 2 / Math.tan((cam.fov * D2R) / 2));
      const d = Math.hypot(screenX(ndc, w) - x, screenY(ndc, h) - y) - rpx;
      if (d < bestD) [bestD, best] = [d, idx];
    }
    if (best !== null) this.setFocus(best === this.focus ? -1 : best);
  }

  _onKey(e) {
    if (!this.active || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target?.tagName;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && e.key !== 'Escape') return;
    // let a focused button or link handle its own Space / Enter
    if ((e.key === ' ' || e.key === 'Enter') && /^(BUTTON|A)$/.test(tag)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (k === 'Escape') {
      e.preventDefault();
      if (this.mode === 'sky') this._leaveSky(true);
      else this.close();
    } else if (k === ' ') {
      e.preventDefault();
      this.playing = !this.playing;
      this._syncUi();
    } else if (k === '[' || k === ']') {
      this.rateLog = clamp(this.rateLog + (k === ']' ? 0.15 : -0.15), RATE_MIN, RATE_MAX);
      this._syncUi();
    } else if (/^[1-7]$/.test(k)) {
      const idx = Number(k) - 1;
      if (this.mode === 'sky') this._enterSky(idx, this.sky.vantage);
      else this.setFocus(idx);
    } else if (k === 'm') {
      this.sound.toggle();
    } else if (this.mode === 'orrery') {
      if (k === '0') this.setFocus(STAR_INDEX);
      else if (k === 'Home' || k === 'h') this.setFocus(-1);
      else if (OPT_KEYS[k]) this._toggleOpt(OPT_KEYS[k]);
      else if (k === 's') this._enterSky(this.worldFocus >= 0 ? this.worldFocus : 3, this.sky.vantage);
    }
  }

  _toggleOpt(name) {
    this.opts[name] = !this.opts[name];
    // re-frame the focus at the new scale so it keeps the same apparent size
    if (name === 'trueScale' && this.focus !== -1) this.setFocus(this.focus);
    this._syncUi();
  }

  // ------------------------------------------------------------------ UI
  _build() {
    const x = this.c.explore;
    const focusButtons = `<button type="button" class="fbtn" data-focus="${STAR_INDEX}" style="--hue:${STAR.hue}" aria-pressed="false" aria-label="${esc(x.star)}"><i></i>★</button>` + PLANETS.map((p) => worldButton('focus', p)).join('');
    this.root.innerHTML = `
      <div class="ex-title only-orrery"><h2>${esc(x.title)}</h2><p>${esc(x.hint)}</p></div>
      <div class="sky-readout only-sky">
        <h2 id="sky-title"></h2>
        <div class="big" id="sky-big">–</div>
        <p id="sky-who"></p>
        <p id="sky-star"></p>
        <p class="note">${esc(x.skyNote)}</p>
      </div>
      <div class="clock only-orrery" id="ex-clock" aria-hidden="true"><svg viewBox="-66 -66 132 132"></svg></div>
      <div class="ex-keys only-orrery">${esc(x.keys)}</div>
      <aside class="ex-panel" aria-label="${esc(x.title)}">
        <section class="ex-sec">
          <h3>${esc(x.time)} <b id="ex-day">–</b></h3>
          <div class="ex-row">
            <button type="button" class="ex-play" id="ex-play" aria-label="${esc(x.pause)}">${ICON_PAUSE}</button>
            <input type="range" id="ex-speed" min="${RATE_MIN}" max="${RATE_MAX}" step="0.01" value="${this.rateLog}" aria-label="${esc(x.speed)}">
          </div>
          <div class="ex-kv">${kvRow(x.speed, '<span id="ex-rate">–</span>')}</div>
        </section>
        <section class="ex-sec only-orrery">
          <h3>${esc(x.focus)} <b id="ex-focus-name">–</b></h3>
          <div class="focus-grid">${focusButtons}</div>
          <div class="ex-kv" id="ex-focus-info"></div>
        </section>
        <section class="ex-sec only-orrery">
          <div class="tog-grid">
            <button type="button" class="tog" data-opt="orbits" aria-pressed="true">${esc(x.orbits)}</button>
            <button type="button" class="tog" data-opt="labels" aria-pressed="true">${esc(x.labels)}</button>
            <button type="button" class="tog" data-opt="trueScale" aria-pressed="false">${esc(x.true)}</button>
            <button type="button" class="tog" data-opt="clock" aria-pressed="true">${esc(x.clock)}</button>
          </div>
        </section>
        <section class="ex-sec only-orrery">
          <h3>${esc(x.sky)}</h3>
          <button type="button" class="btn btn-ghost wide" id="ex-sky-go"></button>
        </section>
        <section class="ex-sec only-sky">
          <h3>${esc(x.sky)} <b id="ex-sky-name"></b></h3>
          <div class="focus-grid">${PLANETS.map((p) => worldButton('skyworld', p)).join('')}</div>
          <div class="tog-grid gap">
            <button type="button" class="tog" data-vantage="terminator" aria-pressed="true">${esc(x.terminator)}</button>
            <button type="button" class="tog" data-vantage="substellar" aria-pressed="false">${esc(x.substellar)}</button>
            <button type="button" class="tog" data-vantage="antistellar" aria-pressed="false">${esc(x.antistellar)}</button>
          </div>
          <div class="tog-grid one gap">
            <button type="button" class="tog" id="ex-aim">${esc(x.aim)}</button>
            <button type="button" class="tog" id="ex-wide">${esc(x.wide)}</button>
          </div>
          <button type="button" class="btn btn-ghost wide gap" id="ex-sky-back">← ${esc(x.close)}</button>
        </section>
      </aside>`;
    const $ = (s) => this.root.querySelector(s);
    this.ui = {
      play: $('#ex-play'),
      speed: $('#ex-speed'),
      rate: $('#ex-rate'),
      day: $('#ex-day'),
      focusName: $('#ex-focus-name'),
      focusInfo: $('#ex-focus-info'),
      skyGo: $('#ex-sky-go'),
      skyName: $('#ex-sky-name'),
      skyTitle: $('#sky-title'),
      skyBig: $('#sky-big'),
      skyWho: $('#sky-who'),
      skyStar: $('#sky-star'),
      clock: $('#ex-clock'),
    };
    this._buildClock();
  }

  /** One delegated listener set for the whole panel; it survives the re-render on a language switch. */
  _wirePanel() {
    this.root.addEventListener('input', (e) => {
      if (e.target.id !== 'ex-speed') return;
      this.rateLog = Number(e.target.value);
      this.playing = true;
      this._syncUi();
    });
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (b.id === 'ex-play') {
        this.playing = !this.playing;
        this._syncUi();
      } else if (d.focus !== undefined) this.setFocus(Number(d.focus) === this.focus ? -1 : Number(d.focus));
      else if (d.opt) this._toggleOpt(d.opt);
      else if (b.id === 'ex-sky-go') this._enterSky(this.worldFocus >= 0 ? this.worldFocus : 3, this.sky.vantage);
      else if (b.id === 'ex-sky-back') this._leaveSky(true);
      else if (b.id === 'ex-aim') this._aimLargest();
      else if (b.id === 'ex-wide') this._wideView();
      else if (d.skyworld !== undefined) this._enterSky(Number(d.skyworld), this.sky.vantage);
      else if (d.vantage) this._enterSky(this.sky.i, d.vantage);
    });
  }

  relocalize() {
    this._setExploreButtonText();
    if (!this.ui) return;
    this._build();
    this._syncUi();
    this._syncFocusUi();
    if (this.mode === 'orrery') this._layoutLabels();
  }

  _syncUi() {
    if (!this.ui) return;
    const { play, speed, rate, skyGo, skyName, skyTitle, clock } = this.ui;
    const x = this.c.explore;
    const fmt = makeFormatter(this.getLang());
    play.innerHTML = this.playing ? ICON_PAUSE : ICON_PLAY;
    play.setAttribute('aria-label', this.playing ? x.pause : x.play);
    speed.value = String(this.rateLog);
    rate.textContent = this.playing ? `${fmt(this.rate, this.rate < 1 ? 2 : 1)} ${x.perSecond}` : x.paused;
    this.root.querySelectorAll('[data-opt]').forEach((b) => b.setAttribute('aria-pressed', String(this.opts[b.dataset.opt])));
    this.root.querySelectorAll('[data-vantage]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vantage === this.sky.vantage)));
    this.root.querySelectorAll('[data-skyworld]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.skyworld) === this.sky.i)));
    skyName.textContent = PLANETS[this.sky.i].id;
    skyTitle.textContent = fill(x.skyOf, { p: PLANETS[this.sky.i].id });
    skyGo.textContent = `${fill(this.c.ui.standOn, { p: PLANETS[this.worldFocus >= 0 ? this.worldFocus : 3].id })} →`;
    this.labelsRoot.style.display = this.opts.labels && this.mode === 'orrery' ? '' : 'none';
    clock.classList.toggle('hidden-opt', !this.opts.clock);
  }

  _syncFocusUi() {
    if (!this.ui) return;
    const c = this.c;
    const fmt = makeFormatter(this.getLang());
    this.root.querySelectorAll('[data-focus]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.focus) === this.focus)));
    let name = '–';
    let rows;
    if (this.focus === -1) {
      rows = kvRow(c.rail.chain, RESONANCE_CHAIN.join(' · '));
    } else if (this.focus === STAR_INDEX) {
      name = 'TRAPPIST-1';
      rows = kvRow(c.star.facts[0][0], STAR.spectral) + kvRow(c.star.facts[3][0], `${fmt(STAR.teff)} K`) + kvRow(c.stats.radius, `${fmt(STAR.radius, 1)} ${esc(c.ui.earthRadii)}`);
    } else {
      const p = PLANETS[this.focus];
      name = `${p.id} · ${c.planets[p.id].name}`;
      rows =
        kvRow(c.stats.radius, `${fmt(p.radius, 3)} ${esc(c.ui.earthRadii)}`) +
        kvRow(c.stats.year, `${fmt(p.period, 2)} ${esc(c.ui.days)}`) +
        kvRow(c.stats.orbit, `${fmt(p.orbitKm / 1e6, 2)} ${esc(c.ui.millionKm)}`) +
        kvRow(c.stats.temp, `${fmt(p.teq)} K`) +
        kvRow(c.stats.sky, `${fmt(p.starAngularDeg / SUN_ANGULAR_DEG, 1)}× ${esc(c.explore.sunWord)}`);
    }
    this.ui.focusName.textContent = name;
    this.ui.focusInfo.innerHTML = rows;
  }

  _updateTimeText(now) {
    if (now - this._lastTime < 0.1) return;
    this._lastTime = now;
    this.ui.day.textContent = `${this.c.explore.day} ${makeFormatter(this.getLang())(this.clock.days, 1)}`;
  }

  // labels ---------------------------------------------------------------
  _clearLabels() {
    this.labelsRoot.innerHTML = '';
    this.labels = null;
  }

  _layoutLabels() {
    this._clearLabels();
    this.labels = [];
    for (let idx = 0; idx <= STAR_INDEX; idx++) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'plabel' + (idx === this.focus ? ' on' : '');
      el.style.setProperty('--hue', idx === STAR_INDEX ? STAR.hue : PLANETS[idx].hue);
      el.tabIndex = -1;
      el.innerHTML = idx === STAR_INDEX ? '<i></i>TRAPPIST-1' : `<i></i><span class="pl-id">${PLANETS[idx].id}</span><small>${esc(this.c.planets[PLANETS[idx].id].name)}</small>`;
      el.addEventListener('click', () => this.setFocus(idx === this.focus ? -1 : idx));
      this.labelsRoot.appendChild(el);
      this.labels.push({ el, transform: '', dim: false, full: false });
    }
    this.labelsRoot.style.display = this.opts.labels ? '' : 'none';
  }

  _updateLabels() {
    if (!this.labels || !this.opts.labels) return;
    const cam = this.engine.camera;
    const { cssW: w, cssH: h } = this.engine;
    for (let idx = 0; idx <= STAR_INDEX; idx++) {
      const l = this.labels[idx];
      const ndc = this._bodyPos(idx, this._w).project(cam);
      const visible = ndc.z < 1 && Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05;
      const transform = visible ? `translate(${screenX(ndc, w).toFixed(0)}px, ${screenY(ndc, h).toFixed(0)}px)` : 'translate(-999px, -999px)';
      if (l.transform !== transform) l.el.style.transform = l.transform = transform;
      if (!visible) continue;
      const dim = this.focus >= 0 && this.focus !== idx && this.dist < 900;
      const full = idx === this.focus || this.dist < 700;
      if (l.dim !== dim) l.el.classList.toggle('dim', (l.dim = dim));
      if (l.full !== full) l.el.classList.toggle('full', (l.full = full));
    }
  }

  // resonance clock ---------------------------------------------------------
  _buildClock() {
    const svg = this.ui.clock.querySelector('svg');
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs, cls) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      if (cls) el.setAttribute('class', cls);
      svg.appendChild(el);
      return el;
    };
    mk('line', { x1: 0, y1: 0, x2: 62, y2: 0 }, 'c-axis');
    this.clockDots = PLANETS.map((p, i) => {
      mk('circle', { r: 12 + i * 8 }, 'c-ring');
      return mk('circle', { r: 3.2, fill: p.hue }, 'c-dot');
    });
    mk('circle', { r: 4 }, 'c-sun');
    mk('text', { x: 64, y: 3.5 }).textContent = '⊕';
    this._clockDays = NaN;
  }

  _updateClock() {
    if (!this.opts.clock || this.clock.days === this._clockDays) return; // nothing moved
    this._clockDays = this.clock.days;
    const { planets } = this.engine.system;
    for (let i = 0; i < N_WORLDS; i++) {
      const a = planets[i].angle;
      const r = 12 + i * 8;
      this.clockDots[i].setAttribute('cx', (Math.cos(a) * r).toFixed(2));
      this.clockDots[i].setAttribute('cy', (-Math.sin(a) * r).toFixed(2));
    }
  }

  /** Called by the sound engine when world i transits (crosses the line to Earth). */
  onPing(i) {
    const dot = this.clockDots?.[i];
    if (!dot) return;
    dot.setAttribute('r', '6');
    clearTimeout(this.pingTimers.get(i));
    this.pingTimers.set(i, setTimeout(() => dot.setAttribute('r', '3.2'), 160));
  }
}
