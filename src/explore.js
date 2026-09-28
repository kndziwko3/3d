import * as THREE from 'three';
import { COPY } from './content.js';
import { PLANETS, STAR, R_EARTH_KM, MOON_ANGULAR_DEG, orbitAngle } from './data.js';
import { makeFormatter, esc, fill, SUN_ANGULAR_DEG } from './ui.js';
import { createHorizon } from './gl/horizon.js';

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const glerp = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const STAR_INDEX = 7;
const EXAG_READABLE = { p: 20, s: 4 };
const OVERVIEW_DIST = 4700;
const RATE_MIN = -2;
const RATE_MAX = 1.7;

const ICON_PAUSE = '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="1.5" width="3" height="11"/><rect x="8.5" y="1.5" width="3" height="11"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9-5.5z"/></svg>';

export class Explore {
  constructor({ engine, clock, story, sound, getLang, toast, storyRate }) {
    this.engine = engine;
    this.clock = clock;
    this.story = story;
    this.sound = sound;
    this.getLang = getLang;
    this.toast = toast;
    this.storyRate = storyRate;

    this.active = false;
    this.mode = 'orrery'; // or 'sky'
    this.focus = -1; // -1 overview, 0..6 planets, 7 star
    this.playing = true;
    this.rateLog = -0.3;
    this.opts = { orbits: true, labels: true, trueScale: false, clock: true };

    // orbit camera
    this.target = new THREE.Vector3();
    this.fromTarget = new THREE.Vector3();
    this.yaw = 0.6;
    this.pitch = 0.5;
    this.yawS = 0.6;
    this.pitchS = 0.5;
    this.dist = OVERVIEW_DIST;
    this.fromDist = OVERVIEW_DIST;
    this.toDist = OVERVIEW_DIST;
    this.tFocus = 1;
    this.idle = 0;
    this.exag = { p: 5, s: 2.5, tp: EXAG_READABLE.p, ts: EXAG_READABLE.s };

    // sky camera
    this.sky = { i: 3, vantage: 'terminator', yaw: 0.5, pitch: 0.45, fov: 76, fovT: 76, track: -1 };
    this.horizon = createHorizon(engine.system.shared);
    engine.system.scene.add(this.horizon.mesh);

    this.pointers = new Map();
    this.down = null;
    this.pinch = 0;

    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._e1 = new THREE.Vector3();
    this._e2 = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._P = new THREE.Vector3();
    this.lastText = 0;
    this.built = false;
    this.chipTimers = new Map();

    this.root = document.getElementById('explore-ui');
    this.labelsRoot = document.getElementById('labels');
    this._wireInput();
  }

  // ------------------------------------------------------------------ helpers
  get lang() {
    return this.getLang();
  }
  get c() {
    return COPY[this.lang];
  }
  get rate() {
    return Math.pow(10, this.rateLog);
  }

  bodyPos(idx, out) {
    if (idx === STAR_INDEX) return out.set(0, 0, 0);
    return out.copy(this.engine.system.planets[idx].pos);
  }
  bodyRadius(idx) {
    const sys = this.engine.system;
    if (idx === STAR_INDEX) return STAR.radius * sys.exag.star;
    return sys.planets[idx].data.radius * sys.exag.planet;
  }
  bodyHue(idx) {
    return idx === STAR_INDEX ? '#ff7a45' : PLANETS[idx].hue;
  }
  bodyLetter(idx) {
    return idx === STAR_INDEX ? '★' : PLANETS[idx].id;
  }

  // ------------------------------------------------------------------ open / close
  open(focus = -1) {
    if (this.active && this.mode === 'orrery') return;
    if (!this.active) this._begin();
    if (this.mode === 'sky') this._leaveSky(false);
    this.setFocus(focus, true);
  }

  toggle() {
    if (this.active) this.close();
    else this.open(-1);
  }

  _begin() {
    const cam = this.engine.camera;
    this.active = true;
    this.mode = 'orrery';
    document.body.classList.add('is-explore');
    document.body.classList.remove('is-sky');
    this._build();
    this.root.hidden = false;
    // continue smoothly from wherever the story camera is
    const look = this.story.out.look;
    const off = this._v.copy(cam.position).sub(look);
    this.target.copy(look);
    this.fromTarget.copy(look);
    this.dist = Math.max(off.length(), 1);
    this.yaw = this.yawS = Math.atan2(off.x, off.z);
    this.pitch = this.pitchS = Math.asin(clamp(off.y / this.dist, -1, 1));
    this.exag.p = this.engine.system.exag.planet;
    this.exag.s = this.engine.system.exag.star;
    this.exag.tp = this.opts.trueScale ? 1 : EXAG_READABLE.p;
    this.exag.ts = this.opts.trueScale ? 1 : EXAG_READABLE.s;
    this.clock.rate = this.playing ? this.rate : 0;
    this._syncUi();
    this._layoutLabels();
    document.getElementById('btn-explore').classList.add('is-on');
    this._setExploreButtonText();
  }

  close() {
    if (!this.active) return;
    if (this.mode === 'sky') this._leaveSky(false);
    this.active = false;
    document.body.classList.remove('is-explore', 'is-sky', 'is-dragging');
    this.root.hidden = true;
    this.labelsRoot.innerHTML = '';
    this.labelEls = null;
    this.clock.rate = this.storyRate;
    const sys = this.engine.system;
    sys.hidden = -1;
    sys.setFocus(-1);
    this.horizon.setVisible(false);
    this.story.blendFrom(this.engine.camera);
    this.engine.camera.clearViewOffset();
    this.engine.fx.fade = 1;
    document.getElementById('btn-explore').classList.remove('is-on');
    this._setExploreButtonText();
  }

  _setExploreButtonText() {
    const el = document.querySelector('#btn-explore .ctl-txt');
    if (!el) return;
    el.textContent = this.active ? this.c.ui.backToStory : this.c.ui.explore;
  }

  openSky(planetId) {
    const i = Math.max(0, PLANETS.findIndex((p) => p.id === planetId));
    if (!this.active) this._begin();
    this._enterSky(i, this.sky.vantage);
  }

  // ------------------------------------------------------------------ focus
  setFocus(idx, instant = false) {
    const sys = this.engine.system;
    this.focus = idx;
    this.fromTarget.copy(this.target);
    this.fromDist = this.dist;
    const scaleP = this.opts.trueScale ? 1 : EXAG_READABLE.p;
    const scaleS = this.opts.trueScale ? 1 : EXAG_READABLE.s;
    if (idx === -1) this.toDist = OVERVIEW_DIST;
    else if (idx === STAR_INDEX) this.toDist = STAR.radius * scaleS * 4.2;
    else this.toDist = PLANETS[idx].radius * scaleP * 6.5;
    this.tFocus = instant ? 0 : 0;
    if (idx === -1) this.pitch = Math.max(this.pitch, 0.45);
    sys.setFocus(idx >= 0 && idx < 7 ? idx : -1);
    this._syncFocusUi();
    this.labelEls?.forEach((el, k) => el.classList.toggle('on', k === idx));
  }

  // ------------------------------------------------------------------ sky mode
  _enterSky(i, vantage) {
    const sys = this.engine.system;
    this.mode = 'sky';
    this.sky.i = i;
    this.sky.vantage = vantage;
    this.sky.yaw = vantage === 'terminator' ? 0.55 : 0;
    this.sky.pitch = vantage === 'substellar' ? 0.9 : vantage === 'antistellar' ? 0.5 : 0.45;
    this.sky.fov = 76;
    this.sky.fovT = 76;
    this.sky.track = -1;
    document.body.classList.remove('is-explore');
    document.body.classList.add('is-sky');
    sys.setExaggeration(1, 1);
    this.exag.p = this.exag.s = this.exag.tp = this.exag.ts = 1;
    sys.hidden = i;
    sys.setVisible({ orbits: 0, markers: 0 });
    sys.setFocus(-1);
    this.horizon.setWorld(PLANETS[i].id, 3.1 + i * 5.7);
    this.horizon.setVisible(true);
    this.labelsRoot.innerHTML = '';
    this.labelEls = null;
    this.engine.fx.fade = 0;
    this._skyFade = 0;
    this._renderSkyTags();
    this._syncUi();
  }

  _leaveSky(back = true) {
    const sys = this.engine.system;
    this.horizon.setVisible(false);
    sys.hidden = -1;
    document.body.classList.remove('is-sky');
    document.body.classList.add('is-explore');
    this.exag.tp = this.opts.trueScale ? 1 : EXAG_READABLE.p;
    this.exag.ts = this.opts.trueScale ? 1 : EXAG_READABLE.s;
    this.exag.p = this.exag.s = 1;
    this.mode = 'orrery';
    this.skyTagEls?.forEach((el) => el.remove());
    this.skyTagEls = null;
    this.engine.camera.fov = 38;
    this._layoutLabels();
    if (back) {
      const i = this.sky.i;
      this.target.copy(this.engine.system.planets[i].pos);
      this.fromTarget.copy(this.target);
      this.dist = PLANETS[i].radius * 8;
      this.setFocus(i, true);
      this.engine.fx.fade = 0;
      this._skyFade = 0;
    }
    this._syncUi();
  }

  _skyBasis(i) {
    const sys = this.engine.system;
    const P = this._P.copy(sys.planets[i].pos);
    const r = this._w.copy(P).normalize(); // star -> planet
    const t = this._e1.set(-r.z, 0, r.x);
    const n = this._n;
    const v = this.sky.vantage;
    if (v === 'substellar') n.copy(r).negate();
    else if (v === 'antistellar') n.copy(r);
    else n.copy(t).multiplyScalar(Math.cos(35 * D2R)).addScaledVector(UP, Math.sin(35 * D2R)).normalize();
    // horizontal reference pointing at the star
    const s = this._look.copy(r).negate();
    const h = this._e2.copy(s).addScaledVector(n, -s.dot(n));
    if (h.lengthSq() < 1e-6) h.copy(t);
    h.normalize();
    return { P, n, h };
  }

  _updateSky(dt) {
    const eng = this.engine;
    const cam = eng.camera;
    const sys = eng.system;
    const i = this.sky.i;
    sys.hidden = i;
    const { P, n, h } = this._skyBasis(i);
    const R = PLANETS[i].radius;
    cam.position.copy(P).addScaledVector(n, R * 1.0004);
    const e2 = this._v.crossVectors(n, h).normalize();
    this.sky.fov += (this.sky.fovT - this.sky.fov) * (1 - Math.exp(-dt * 5));
    if (this.sky.track >= 0) {
      const tp = sys.planets[this.sky.track].pos;
      const d = this._w.copy(tp).sub(cam.position);
      const len = d.length();
      const yawT = Math.atan2(d.dot(e2), d.dot(h));
      const pitchT = Math.asin(clamp(d.dot(n) / len, -1, 1));
      if (pitchT < -0.03) this.sky.track = -1;
      else {
        let dy = yawT - this.sky.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const kt = 1 - Math.exp(-dt * 6);
        this.sky.yaw += dy * kt;
        this.sky.pitch += (pitchT - this.sky.pitch) * kt;
      }
    }
    const cp = Math.cos(this.sky.pitch);
    const dir = this._look.set(0, 0, 0).addScaledVector(h, Math.cos(this.sky.yaw) * cp).addScaledVector(e2, Math.sin(this.sky.yaw) * cp).addScaledVector(n, Math.sin(this.sky.pitch));
    cam.up.copy(n);
    cam.fov = this.sky.fov;
    cam.lookAt(this._w.copy(cam.position).add(dir));
    if (cam.aspect < 1.05) cam.setViewOffset(eng.cssW, eng.cssH, 0, 0.2 * eng.cssH, eng.cssW, eng.cssH);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    const sunDir = this._w.copy(cam.position).negate().normalize();
    this.horizon.update(cam, n, sunDir);
    this._skyFade = Math.min(1, (this._skyFade ?? 0) + dt / 0.9);
    eng.fx.fade = this._skyFade;
    eng.fx.exposure = 1.05;
    eng.fx.bloom = 0.8;
    eng.fx.flare = 1;
  }

  /** Point the sky camera at world k and zoom to see it as a disc. */
  _aimAt(k) {
    if (k === this.sky.i) return;
    this.sky.track = k;
    const sys = this.engine.system;
    const d = sys.planets[k].pos.distanceTo(this.engine.camera.position);
    const deg = (2 * Math.atan(PLANETS[k].radius / d)) / D2R;
    this.sky.fovT = clamp(deg * 6, 2.5, 40);
  }

  _aimLargest() {
    const sys = this.engine.system;
    const cam = this.engine.camera;
    const n = this._skyBasis(this.sky.i).n.clone();
    let best = -1;
    let bestDeg = 0;
    PLANETS.forEach((p, k) => {
      if (k === this.sky.i) return;
      const d = this._v.copy(sys.planets[k].pos).sub(cam.position);
      const dist = d.length();
      if (d.dot(n) / dist < 0.03) return; // below the horizon
      const deg = (2 * Math.atan(p.radius / dist)) / D2R;
      if (deg > bestDeg) {
        bestDeg = deg;
        best = k;
      }
    });
    if (best >= 0) this._aimAt(best);
    else this.toast?.(this.c.explore.belowHorizon);
  }

  _wideView() {
    this.sky.track = -1;
    this.sky.fovT = 76;
  }

  _renderSkyTags() {
    this.skyTagEls?.forEach((el) => el.remove());
    this.skyTagEls = PLANETS.map((p) => {
      const el = document.createElement('div');
      el.className = 'sky-tag';
      el.style.opacity = '0';
      el.innerHTML = `<span>${p.id}</span><small></small>`;
      el.addEventListener('click', () => this._aimAt(p.index));
      this.labelsRoot.appendChild(el);
      return el;
    });
    const el = document.createElement('div');
    el.className = 'sky-tag';
    el.innerHTML = `<span>★</span><small></small>`;
    this.labelsRoot.appendChild(el);
    this.skyTagEls.push(el);
  }

  _updateSkyTags(now) {
    const eng = this.engine;
    const cam = eng.camera;
    const sys = eng.system;
    const w = eng.cssW;
    const h = eng.cssH;
    const fmt = makeFormatter(this.lang);
    const i = this.sky.i;
    const camPos = cam.position;
    const n = this._skyBasis(i).n.clone();
    let best = { deg: 0, id: '' };
    const doText = now - this.lastText > 0.25;
    if (doText) this.lastText = now;
    PLANETS.forEach((p, k) => {
      const el = this.skyTagEls[k];
      if (k === i) {
        el.style.opacity = '0';
        return;
      }
      const pos = sys.planets[k].pos;
      const d = this._v.copy(pos).sub(camPos);
      const dist = d.length();
      const deg = (2 * Math.atan(p.radius / dist)) / D2R;
      const above = d.dot(n) / dist > -0.02;
      if (above && deg > best.deg) best = { deg, id: p.id }; // only worlds you can actually see
      const ndc = this._w.copy(pos).project(cam);
      const vis = above && ndc.z < 1 && Math.abs(ndc.x) < 0.98 && Math.abs(ndc.y) < 0.95;
      el.classList.toggle('edge', false);
      el.style.opacity = vis ? '1' : '0';
      if (!vis && above) {
        // world above the horizon but off-screen: pin a small marker to the screen edge
        const cx = ndc.z < 1 ? ndc.x : -ndc.x;
        const cy = ndc.z < 1 ? ndc.y : -ndc.y;
        const m = Math.max(Math.abs(cx), Math.abs(cy), 1e-3);
        const ex = clamp(cx / m, -1, 1) * 0.93;
        const ey = clamp(cy / m, -1, 1) * 0.88;
        el.classList.add('edge');
        el.style.opacity = '0.75';
        el.style.transform = `translate(${((ex * 0.5 + 0.5) * w).toFixed(1)}px, ${((-ey * 0.5 + 0.5) * h).toFixed(1)}px)`;
        if (doText) el.lastElementChild.textContent = '';
      }
      if (vis) {
        const px = deg / 2 / (cam.fov / 2) * (h / 2); // apparent radius in px, small-angle
        el.style.transform = `translate(${((ndc.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-ndc.y * 0.5 + 0.5) * h + Math.max(14, px * 1.2)).toFixed(1)}px)`;
        if (doText) el.lastElementChild.textContent = `${fmt(deg, 2)}° · ${fmt(deg / MOON_ANGULAR_DEG, 1)}× ${this.c.explore.moonWord}`;
      }
    });
    // the star
    const sEl = this.skyTagEls[7];
    const sd = camPos.length();
    const sDeg = (2 * Math.asin(STAR.radius / sd)) / D2R;
    const sNdc = this._w.set(0, 0, 0).project(cam);
    const sAbove = this._v.set(0, 0, 0).sub(camPos).normalize().dot(n) > -0.02;
    const sVis = sAbove && sNdc.z < 1 && Math.abs(sNdc.x) < 0.98 && Math.abs(sNdc.y) < 0.95;
    sEl.style.opacity = sVis ? '1' : '0';
    if (sVis) {
      const px = sDeg / 2 / (cam.fov / 2) * (h / 2);
      sEl.style.transform = `translate(${((sNdc.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-sNdc.y * 0.5 + 0.5) * h + Math.max(16, px * 1.3)).toFixed(1)}px)`;
      if (doText) sEl.lastElementChild.textContent = `${fmt(sDeg, 2)}° · ${fmt(sDeg / SUN_ANGULAR_DEG, 1)}× ${this.c.explore.sunWord}`;
    }
    if (doText) {
      const big = document.getElementById('sky-big');
      const who = document.getElementById('sky-who');
      const star = document.getElementById('sky-star');
      if (big) big.textContent = `${fmt(best.deg / MOON_ANGULAR_DEG, 1)}×`;
      if (who) who.textContent = `${this.c.explore.biggest}: ${best.id} · ${fmt(best.deg, 2)}° ${this.c.explore.moon}`;
      if (star) star.textContent = fill(this.c.explore.starSize, { n: fmt(sDeg / SUN_ANGULAR_DEG, 1) });
    }
  }

  // ------------------------------------------------------------------ per-frame
  update(dt, seconds) {
    const eng = this.engine;
    const cam = eng.camera;
    const sys = eng.system;

    this.clock.rate = this.playing ? this.rate : 0;

    if (this.mode === 'sky') {
      this._updateSky(dt);
      this._updateSkyTags(seconds);
      this._updateTimeText(seconds);
      return;
    }

    eng.fx.fade = Math.min(1, eng.fx.fade + dt / 0.8); // fades back in after leaving the surface view
    // exaggeration tween (true scale toggle)
    const k = 1 - Math.exp(-dt * 3.4);
    this.exag.p = glerp(this.exag.p, this.exag.tp, k);
    this.exag.s = glerp(this.exag.s, this.exag.ts, k);
    sys.setExaggeration(this.exag.p, this.exag.s);
    sys.setVisible({ orbits: this.opts.orbits ? 0.85 : 0, markers: 1 });
    sys.hidden = -1;

    // focus tracking
    const fp = this._focusPos();
    if (this.tFocus < 1) this.tFocus = Math.min(1, this.tFocus + dt / 1.5);
    const e = easeInOut(this.tFocus);
    this.target.lerpVectors(this.fromTarget, fp, e);
    if (this.tFocus < 1) this.dist = glerp(this.fromDist, this.toDist, e);
    const minD = this.focus === -1 ? 60 : this.bodyRadius(this.focus) * 1.7;
    this.dist = clamp(this.dist, minD, 16000);

    this.idle += dt;
    if (this.idle > 4 && this.tFocus >= 1 && !this.story.reduced) this.yaw += dt * 0.035;
    const ks = 1 - Math.exp(-dt * 9);
    this.yawS += (this.yaw - this.yawS) * ks;
    this.pitchS += (this.pitch - this.pitchS) * ks;
    const cp = Math.cos(this.pitchS);
    cam.position.set(Math.sin(this.yawS) * cp, Math.sin(this.pitchS), Math.cos(this.yawS) * cp).multiplyScalar(this.dist).add(this.target);
    cam.up.copy(UP);
    cam.lookAt(this.target);
    cam.fov += (38 - cam.fov) * ks;
    // keep the subject clear of the side panel on wide screens
    const portrait = cam.aspect < 1.05;
    const panelShift = portrait ? 0 : 0.09 * eng.cssW;
    const liftTarget = portrait ? 0.2 * eng.cssH : 0; // clear the bottom sheet on phones
    this._shift = (this._shift ?? 0) + (panelShift - (this._shift ?? 0)) * ks;
    this._lift = (this._lift ?? 0) + (liftTarget - (this._lift ?? 0)) * ks;
    if (this._shift > 0.5 || this._lift > 0.5) cam.setViewOffset(eng.cssW, eng.cssH, this._shift, this._lift, eng.cssW, eng.cssH);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    eng.fx.exposure = 1;
    eng.fx.bloom = this.exag.p > 5 ? 0.75 : 0.9;
    eng.fx.flare = 0.6;

    this._updateLabels();
    this._updateClock();
    this._updateTimeText(seconds);
  }

  _focusPos() {
    if (this.focus === -1) return this._P.set(0, 0, 0);
    return this.bodyPos(this.focus, this._P);
  }

  // ------------------------------------------------------------------ input
  _wireInput() {
    const canvas = document.getElementById('gl');
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      canvas.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      this.idle = 0;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      document.body.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.active || !this.pointers.has(e.pointerId)) return;
      const p = this.pointers.get(e.pointerId);
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.idle = 0;
      if (this.down) this.down.moved += Math.abs(dx) + Math.abs(dy);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch > 0) this._zoom(this.pinch / d);
        this.pinch = d;
        return;
      }
      if (this.mode === 'sky') {
        const s = this.sky.fov / 76;
        this.sky.track = -1;
        this.sky.yaw += dx * 0.0042 * s;
        this.sky.pitch = clamp(this.sky.pitch + dy * 0.0042 * s, -0.12, 1.5);
      } else {
        this.yaw -= dx * 0.0055;
        this.pitch = clamp(this.pitch + dy * 0.0055, -1.45, 1.45);
        this.tFocus = Math.max(this.tFocus, 0.999);
      }
    });
    const up = (e) => {
      if (!this.active) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = 0;
      if (this.pointers.size === 0) {
        document.body.classList.remove('is-dragging');
        const d = this.down;
        if (d && d.moved < 7 && performance.now() - d.t < 450 && this.mode === 'orrery') this._pick(e.clientX, e.clientY);
        this.down = null;
      }
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
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
    const w = this.engine.cssW;
    const h = this.engine.cssH;
    let best = null;
    let bestD = 30;
    for (let idx = 0; idx <= STAR_INDEX; idx++) {
      const pos = this.bodyPos(idx, this._v);
      const ndc = this._w.copy(pos).project(cam);
      if (ndc.z > 1) continue;
      const sx = (ndc.x * 0.5 + 0.5) * w;
      const sy = (-ndc.y * 0.5 + 0.5) * h;
      const dist = this._v.copy(pos).sub(cam.position).length();
      const rpx = (this.bodyRadius(idx) / dist) * (h / 2 / Math.tan((cam.fov * D2R) / 2));
      const d = Math.hypot(sx - x, sy - y) - rpx;
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
    if (best !== null) this.setFocus(best === this.focus ? -1 : best);
  }

  _onKey(e) {
    if (!this.active || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.key !== 'Escape') return;
    const k = e.key;
    // let a focused button or link handle its own Space / Enter
    if ((k === ' ' || k === 'Enter') && e.target && /^(BUTTON|A)$/.test(e.target.tagName)) return;
    if (k === 'Escape') {
      e.preventDefault();
      if (this.mode === 'sky') this._leaveSky(true);
      else this.close();
    } else if (k === ' ') {
      e.preventDefault();
      this.playing = !this.playing;
      this._syncUi();
    } else if (k === '[') {
      this.rateLog = clamp(this.rateLog - 0.15, RATE_MIN, RATE_MAX);
      this._syncUi();
    } else if (k === ']') {
      this.rateLog = clamp(this.rateLog + 0.15, RATE_MIN, RATE_MAX);
      this._syncUi();
    } else if (k >= '1' && k <= '7') {
      const idx = Number(k) - 1;
      if (this.mode === 'sky') this._enterSky(idx, this.sky.vantage);
      else this.setFocus(idx);
    } else if (k === '0' && this.mode === 'orrery') {
      this.setFocus(STAR_INDEX);
    } else if ((k === 'Home' || k === 'h' || k === 'H') && this.mode === 'orrery') {
      this.setFocus(-1);
    } else if ((k === 't' || k === 'T') && this.mode === 'orrery') {
      this._toggleOpt('trueScale');
    } else if ((k === 'o' || k === 'O') && this.mode === 'orrery') {
      this._toggleOpt('orbits');
    } else if ((k === 'l' || k === 'L') && this.mode === 'orrery') {
      this._toggleOpt('labels');
    } else if ((k === 'c' || k === 'C') && this.mode === 'orrery') {
      this._toggleOpt('clock');
    } else if ((k === 's' || k === 'S') && this.mode === 'orrery') {
      this._enterSky(this.focus >= 0 && this.focus < 7 ? this.focus : 3, this.sky.vantage);
    } else if (k === 'm' || k === 'M') {
      this.sound?.toggle?.();
    }
  }

  _toggleOpt(name) {
    this.opts[name] = !this.opts[name];
    if (name === 'trueScale') {
      this.exag.tp = this.opts.trueScale ? 1 : EXAG_READABLE.p;
      this.exag.ts = this.opts.trueScale ? 1 : EXAG_READABLE.s;
      if (this.focus >= 0) {
        // keep the same apparent framing while the planet shrinks or grows
        const R = this.focus === STAR_INDEX ? STAR.radius * this.exag.ts : PLANETS[this.focus].radius * this.exag.tp;
        this.fromDist = this.dist;
        this.toDist = R * (this.focus === STAR_INDEX ? 4.2 : 6.5);
        this.fromTarget.copy(this.target);
        this.tFocus = 0;
      }
    }
    this._syncUi();
    if (name === 'labels') this.labelsRoot.style.display = this.opts.labels ? '' : 'none';
  }

  // ------------------------------------------------------------------ UI
  _build() {
    const c = this.c;
    const x = c.explore;
    const focusBtns = [`<button type="button" class="fbtn" data-focus="7" style="--hue:#ff7a45" aria-pressed="false" aria-label="${esc(x.star)}"><i></i>★</button>`]
      .concat(PLANETS.map((p) => `<button type="button" class="fbtn" data-focus="${p.index}" style="--hue:${p.hue}" aria-pressed="false"><i></i>${p.id}</button>`))
      .join('');
    this.root.innerHTML = `
      <div class="ex-title only-orrery"><h2>${esc(x.title)}</h2><p>${esc(x.hint)}</p></div>
      <div class="sky-readout only-sky">
        <h2 id="sky-title"></h2>
        <div class="big" id="sky-big">–</div>
        <p id="sky-who"></p>
        <p id="sky-star"></p>
        <p style="color:var(--ink-3);max-width:44ch">${esc(x.skyNote)}</p>
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
          <div class="ex-kv"><div><span>${esc(x.speed)}</span><b id="ex-rate">–</b></div></div>
        </section>
        <section class="ex-sec only-orrery">
          <h3>${esc(x.focus)} <b id="ex-focus-name">–</b></h3>
          <div class="focus-grid">${focusBtns}</div>
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
          <button type="button" class="btn btn-ghost" id="ex-sky-go" style="width:100%"></button>
        </section>
        <section class="ex-sec only-sky">
          <h3>${esc(x.sky)} <b id="ex-sky-name"></b></h3>
          <div class="focus-grid" id="ex-sky-worlds">${PLANETS.map((p) => `<button type="button" class="fbtn" data-skyworld="${p.index}" style="--hue:${p.hue}" aria-pressed="false"><i></i>${p.id}</button>`).join('')}</div>
          <div class="tog-grid" style="margin-top:8px">
            <button type="button" class="tog" data-vantage="terminator" aria-pressed="true">${esc(x.terminator)}</button>
            <button type="button" class="tog" data-vantage="substellar" aria-pressed="false">${esc(x.substellar)}</button>
            <button type="button" class="tog" data-vantage="antistellar" aria-pressed="false">${esc(x.antistellar)}</button>
          </div>
          <div class="tog-grid one" style="margin-top:8px">
            <button type="button" class="tog" id="ex-aim">${esc(x.aim)}</button>
            <button type="button" class="tog" id="ex-wide">${esc(x.wide)}</button>
          </div>
          <button type="button" class="btn btn-ghost" id="ex-sky-back" style="width:100%;margin-top:12px">← ${esc(x.close)}</button>
        </section>
      </aside>`;
    this.built = true;
    const $ = (s) => this.root.querySelector(s);
    $('#ex-play').addEventListener('click', () => {
      this.playing = !this.playing;
      this._syncUi();
    });
    $('#ex-speed').addEventListener('input', (e) => {
      this.rateLog = Number(e.target.value);
      this.playing = true;
      this._syncUi();
    });
    this.root.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => this.setFocus(Number(b.dataset.focus) === this.focus ? -1 : Number(b.dataset.focus))));
    this.root.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => this._toggleOpt(b.dataset.opt)));
    $('#ex-sky-go').addEventListener('click', () => this._enterSky(this.focus >= 0 && this.focus < 7 ? this.focus : 3, this.sky.vantage));
    $('#ex-sky-back').addEventListener('click', () => this._leaveSky(true));
    $('#ex-aim').addEventListener('click', () => this._aimLargest());
    $('#ex-wide').addEventListener('click', () => this._wideView());
    this.root.querySelectorAll('[data-skyworld]').forEach((b) => b.addEventListener('click', () => this._enterSky(Number(b.dataset.skyworld), this.sky.vantage)));
    this.root.querySelectorAll('[data-vantage]').forEach((b) =>
      b.addEventListener('click', () => {
        this._enterSky(this.sky.i, b.dataset.vantage);
      }),
    );
    this._buildClock();
  }

  relocalize() {
    if (!this.built) {
      this._setExploreButtonText();
      return;
    }
    this._build();
    this._syncUi();
    this._syncFocusUi();
    if (this.mode === 'orrery') this._layoutLabels();
    this._setExploreButtonText();
  }

  _syncUi() {
    if (!this.built) return;
    const $ = (s) => this.root.querySelector(s);
    const fmt = makeFormatter(this.lang);
    $('#ex-play').innerHTML = this.playing ? ICON_PAUSE : ICON_PLAY;
    $('#ex-play').setAttribute('aria-label', this.playing ? this.c.explore.pause : this.c.explore.play);
    $('#ex-speed').value = String(this.rateLog);
    $('#ex-rate').textContent = this.playing ? `${fmt(this.rate, this.rate < 1 ? 2 : 1)} ${this.c.explore.perSecond}` : this.c.explore.paused;
    this.root.querySelectorAll('[data-opt]').forEach((b) => b.setAttribute('aria-pressed', String(this.opts[b.dataset.opt])));
    this.root.querySelectorAll('[data-vantage]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vantage === this.sky.vantage)));
    this.root.querySelectorAll('[data-skyworld]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.skyworld) === this.sky.i)));
    const skyName = $('#ex-sky-name');
    if (skyName) skyName.textContent = PLANETS[this.sky.i].id;
    const title = $('#sky-title');
    if (title) title.textContent = fill(this.c.explore.skyOf, { p: PLANETS[this.sky.i].id });
    const go = $('#ex-sky-go');
    if (go) {
      const idx = this.focus >= 0 && this.focus < 7 ? this.focus : 3;
      go.innerHTML = `${esc(fill(this.c.ui.standOn, { p: PLANETS[idx].id }))} →`;
    }
    this.labelsRoot.style.display = this.opts.labels && this.mode === 'orrery' ? '' : 'none';
    $('#ex-clock')?.classList.toggle('hidden-opt', !this.opts.clock);
  }

  _syncFocusUi() {
    if (!this.built) return;
    const $ = (s) => this.root.querySelector(s);
    const fmt = makeFormatter(this.lang);
    this.root.querySelectorAll('[data-focus]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.focus) === this.focus)));
    const nameEl = $('#ex-focus-name');
    const info = $('#ex-focus-info');
    const c = this.c;
    if (this.focus === -1) {
      nameEl.textContent = '–';
      info.innerHTML = `<div><span>${esc(c.rail.chain)}</span><b>8:5 · 5:3 · 3:2 · 3:2 · 4:3 · 3:2</b></div>`;
    } else if (this.focus === STAR_INDEX) {
      nameEl.textContent = 'TRAPPIST-1';
      info.innerHTML = `<div><span>${esc(c.star.facts[0][0])}</span><b>${STAR.spectral}</b></div><div><span>${esc(c.star.facts[3][0])}</span><b>${fmt(STAR.teff)} K</b></div><div><span>${esc(c.stats.radius)}</span><b>${fmt(STAR.radius, 1)} ${esc(c.ui.earthRadii)}</b></div>`;
    } else {
      const p = PLANETS[this.focus];
      nameEl.textContent = `${p.id} · ${c.planets[p.id].name}`;
      info.innerHTML = `<div><span>${esc(c.stats.radius)}</span><b>${fmt(p.radius, 3)} ${esc(c.ui.earthRadii)}</b></div>
        <div><span>${esc(c.stats.year)}</span><b>${fmt(p.period, 2)} ${esc(c.ui.days)}</b></div>
        <div><span>${esc(c.stats.orbit)}</span><b>${fmt(p.orbitKm / 1e6, 2)} ${esc(c.ui.millionKm)}</b></div>
        <div><span>${esc(c.stats.temp)}</span><b>${fmt(Math.round(p.teq))} K</b></div>
        <div><span>${esc(c.stats.sky)}</span><b>${fmt(p.starAngularDeg / SUN_ANGULAR_DEG, 1)}× ${esc(c.explore.sunWord)}</b></div>`;
    }
    this._syncUi();
  }

  _updateTimeText(now) {
    if (now - (this._lastTime ?? 0) < 0.1) return;
    this._lastTime = now;
    const fmt = makeFormatter(this.lang);
    const d = this.root.querySelector('#ex-day');
    if (d) d.textContent = `${this.c.explore.day} ${fmt(this.clock.days, 1)}`;
  }

  // labels ---------------------------------------------------------------
  _layoutLabels() {
    this.labelsRoot.innerHTML = '';
    this.labelEls = [];
    const c = this.c;
    for (let idx = 0; idx <= STAR_INDEX; idx++) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'plabel' + (idx === this.focus ? ' on' : '');
      el.style.setProperty('--hue', this.bodyHue(idx));
      el.tabIndex = -1;
      el.innerHTML = idx === STAR_INDEX ? `<i></i>TRAPPIST-1` : `<i></i><span class="pl-id">${PLANETS[idx].id}</span><small>${esc(c.planets[PLANETS[idx].id].name)}</small>`;
      el.addEventListener('click', () => this.setFocus(idx === this.focus ? -1 : idx));
      this.labelsRoot.appendChild(el);
      this.labelEls.push(el);
    }
    this.labelsRoot.style.display = this.opts.labels ? '' : 'none';
  }

  _updateLabels() {
    if (!this.labelEls || !this.opts.labels) return;
    const cam = this.engine.camera;
    const w = this.engine.cssW;
    const h = this.engine.cssH;
    for (let idx = 0; idx <= STAR_INDEX; idx++) {
      const el = this.labelEls[idx];
      const pos = this.bodyPos(idx, this._v);
      const ndc = this._w.copy(pos).project(cam);
      const visible = ndc.z < 1 && Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05;
      if (!visible) {
        el.style.transform = 'translate(-999px,-999px)';
        continue;
      }
      const x = (ndc.x * 0.5 + 0.5) * w;
      const y = (-ndc.y * 0.5 + 0.5) * h;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.classList.toggle('dim', this.focus >= 0 && this.focus !== idx && this.dist < 900);
      el.classList.toggle('full', idx === this.focus || this.dist < 700);
    }
  }

  // resonance clock ---------------------------------------------------------
  _buildClock() {
    const svg = this.root.querySelector('#ex-clock svg');
    if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';
    const mk = (n, attrs) => {
      const el = document.createElementNS(NS, n);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
      return el;
    };
    mk('line', { x1: 0, y1: 0, x2: 62, y2: 0, stroke: 'rgba(243,231,221,0.35)', 'stroke-width': 1 });
    this.clockDots = PLANETS.map((p, i) => {
      const r = 12 + i * 8;
      mk('circle', { cx: 0, cy: 0, r, fill: 'none', stroke: 'rgba(243,231,221,0.14)', 'stroke-width': 1 });
      return mk('circle', { r: 3.2, fill: p.hue, stroke: '#07040a', 'stroke-width': 1.5 });
    });
    mk('circle', { cx: 0, cy: 0, r: 4, fill: '#ff7a45' });
    mk('text', { x: 64, y: 3.5, fill: 'rgba(243,231,221,0.6)', 'font-size': 8, 'font-family': 'IBM Plex Mono, monospace' }).textContent = '⊕';
  }

  _updateClock() {
    if (!this.clockDots || !this.opts.clock) return;
    const d = this.clock.days;
    PLANETS.forEach((p, i) => {
      const a = orbitAngle(p, d);
      const r = 12 + i * 8;
      this.clockDots[i].setAttribute('cx', (Math.cos(a) * r).toFixed(2));
      this.clockDots[i].setAttribute('cy', (-Math.sin(a) * r).toFixed(2));
    });
  }

  /** Called by the sound engine when world i transits (crosses the line to Earth). */
  onPing(i) {
    const dot = this.clockDots?.[i];
    if (dot) {
      dot.setAttribute('r', '6');
      clearTimeout(this.chipTimers.get(i));
      this.chipTimers.set(i, setTimeout(() => dot.setAttribute('r', '3.2'), 160));
    }
  }
}
