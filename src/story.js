import * as THREE from 'three';
import { PLANETS, STAR, R_EARTH_KM, EXAG, orbitPosition } from './data.js';
import { STOP } from './ui.js';
import { UP, D2R, clamp, lerp, glerp, smooth, easeInOut, ease } from './math.js';
import { isSheet } from './layout.js';

const C_KMS = 299792.458;
const INTRO_SECONDS = 3.4;

// Camera rigs, one per stop.
//  planet rigs: az 0 = camera on the star side (full phase), 90 = quarter, 180 = night side.
//  dist is in *visual* planet radii. shift moves the subject right (fraction of width).
const PLANET_RIG = { kind: 'planet', dist: 4.7, fov: 36, exag: [EXAG.story.p, EXAG.story.s], shift: 0.2, drift: [7, 2] };
const planetRig = (p, az, el) => ({ ...PLANET_RIG, p, az, el });
const FREE_VIEW = { kind: 'free', pos: [0, 3100, 4300], look: [0, 0, 0], fov: 34, shift: 0.15, orbits: 0.95, markers: 1, drift: [0, 0] };

const RIG_LIST = {
  hero: { kind: 'planet', p: 3, az: 187, el: 3.5, dist: 10.5, fov: 34, exag: [EXAG.story.p, 4.2], shift: 0.15, drift: [2.5, 0.8], fx: { bloom: 0.95 } },
  star: { kind: 'star', az: 6, el: 9, dist: 3.9, fov: 38, exag: [EXAG.story.p, EXAG.story.s], shift: 0.22, drift: [7, 1.5], fx: { exposure: 0.95, bloom: 0.8 } },
  b: planetRig(0, 88, 9),
  c: planetRig(1, 92, 7),
  d: planetRig(2, 70, 11),
  e: planetRig(3, 100, 8),
  f: planetRig(4, 102, 6),
  g: planetRig(5, 84, 12),
  h: planetRig(6, 96, 8),
  chain: { ...FREE_VIEW, exag: [24, 4.5], fx: { bloom: 0.7, flare: 0.5 } },
  // pulled far back: the whole system is a speck inside Mercury's orbit (see MERCURY_ORBIT)
  scale: { ...FREE_VIEW, pos: [0, 15200, 20800], exag: [EXAG.scale.p, EXAG.scale.s], mercury: 1, fx: { bloom: 1.0, flare: 0.5 } },
};
export const RIGS = Object.keys(STOP).map((id) => RIG_LIST[id]);
if (RIGS.includes(undefined)) throw new Error('RIG_LIST must define a camera rig for every stop');

// Pose fields blended between rigs. Position and look are handled separately.
const LINEAR = ['fov', 'shiftX', 'shiftY', 'orbits', 'markers', 'mercury', 'exposure', 'bloom', 'flare'];
const GEOMETRIC = ['exagP', 'exagS'];

class Pose {
  constructor() {
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    Object.assign(this, { fov: 40, shiftX: 0, shiftY: 0, orbits: 0, markers: 0, mercury: 0, exposure: 1, bloom: 0.85, flare: 1, exagP: EXAG.story.p, exagS: EXAG.story.s });
  }
  copy(o) {
    this.pos.copy(o.pos);
    this.look.copy(o.look);
    for (const k of LINEAR) this[k] = o[k];
    for (const k of GEOMETRIC) this[k] = o[k];
    return this;
  }
}

const _r = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Evaluate rig i at `phase` in [-0.5, 0.5] (slow drift while the stop is held). */
function evalRig(i, phase, ctx, out) {
  const rig = RIGS[i];
  const fit = Math.max(1, 1.12 / ctx.aspect);
  const pxAz = rig.drift[0] * phase * 2 + ctx.breath * 0.6;
  const pxEl = rig.drift[1] * phase * 2;

  [out.exagP, out.exagS] = rig.exag;
  out.fov = rig.fov;
  out.shiftX = ctx.sheet ? 0 : rig.shift;
  out.shiftY = ctx.sheet ? 0.2 : 0;
  out.orbits = rig.orbits ?? 0;
  out.markers = rig.markers ?? 0;
  out.mercury = rig.mercury ?? 0;
  out.exposure = rig.fx?.exposure ?? 1;
  out.bloom = rig.fx?.bloom ?? 0.85;
  out.flare = rig.fx?.flare ?? 1;

  if (rig.kind === 'free') {
    out.look.set(...rig.look);
    out.pos.set(...rig.pos).sub(out.look).multiplyScalar(fit * ctx.dolly).add(out.look);
    if (!ctx.reduced) out.pos.sub(out.look).applyAxisAngle(UP, (pxAz + ctx.time * 0.6) * D2R * 0.25).add(out.look); // slow orbit for life
    return out;
  }

  // planet and star rigs share a frame: r = away from the star, t = along the orbit
  const anchor = rig.kind === 'planet' ? rig.p : 3;
  orbitPosition(PLANETS[anchor], ctx.days, _p);
  _r.copy(_p).normalize();
  _t.set(-_r.z, 0, _r.x);
  const az = (rig.az + pxAz) * D2R;
  const el = (rig.el + pxEl) * D2R;
  if (rig.kind === 'planet') {
    _d.copy(_r).multiplyScalar(-Math.cos(az)).addScaledVector(_t, Math.sin(az));
    _d.multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el));
    out.pos.copy(_p).addScaledVector(_d, rig.dist * PLANETS[rig.p].radius * rig.exag[0] * fit * ctx.dolly);
    out.look.copy(_p);
  } else {
    _d.copy(_r).multiplyScalar(Math.cos(az)).addScaledVector(_t, Math.sin(az));
    _d.multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el));
    out.pos.copy(_d).multiplyScalar(rig.dist * STAR.radius * rig.exag[1] * fit * ctx.dolly);
    out.look.set(0, 0, 0);
  }
  return out;
}

const _mid = new THREE.Vector3();
const _tan = new THREE.Vector3();
function blendPose(A, B, s, out) {
  const e = easeInOut(s);
  // quadratic Bezier with a lifted control point keeps the flight from grazing worlds. Lift up and
  // sideways along the orbit: the camera then passes worlds at quarter phase instead of behind them,
  // where only their dark sides would face it.
  _mid.copy(A.pos).add(B.pos).multiplyScalar(0.5);
  const span = A.pos.distanceTo(B.pos);
  _tan.set(-_mid.z, 0, _mid.x);
  if (_tan.lengthSq() > 1e-6) _tan.normalize().multiplyScalar(span * (span < 400 ? 0.42 : 0.1));
  _mid.addScaledVector(UP, span * 0.12).add(_tan);
  const a = 1 - e;
  out.pos.set(0, 0, 0).addScaledVector(A.pos, a * a).addScaledVector(_mid, 2 * a * e).addScaledVector(B.pos, e * e);
  out.look.lerpVectors(A.look, B.look, e);
  for (const k of LINEAR) out[k] = lerp(A[k], B[k], e);
  for (const k of GEOMETRIC) out[k] = glerp(A[k], B[k], e);
  out.fov += Math.sin(Math.PI * s) * 7; // a little kick while travelling
  return out;
}

export class Story {
  constructor({ engine, clock, spacers, panels, railItems, els }) {
    this.engine = engine;
    this.clock = clock;
    this.spacers = spacers;
    this.panels = panels;
    this.railItems = railItems;
    this.els = els;
    this.s = 0; // smoothed stop coordinate
    this.sTarget = 0;
    this.introOn = false;
    this.introT = 0;
    this.pointer = new THREE.Vector2();
    this.pointerS = new THREE.Vector2();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.A = new Pose();
    this.B = new Pose();
    this.pose = new Pose(); // the pose applied this frame
    this.ctx = { days: 0, aspect: 1, breath: 0, dolly: 1, reduced: this.reduced, time: 0, sheet: false };
    this.view = { exagP: 5, exagS: 2.5 };
    this.activeRail = -1;
    this.focusIndex = -1;
    this.flareIn = 0;
    this.blend = null;
    this.lastTele = 0;
    this._o = [];
    this._css = {};
    this.layout();

    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    });
  }

  /** Re-measure the spacers and the scroll range. Cheap enough for resize; not for every frame. */
  layout() {
    this.tops = this.spacers.map((el) => el.offsetTop);
    this.heights = this.spacers.map((el) => el.offsetHeight);
    this.maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  }

  /** New DOM after a language switch: the story owns its references. */
  relocalize({ panels, railItems, els }) {
    this.panels = panels;
    this.railItems = railItems;
    Object.assign(this.els, els);
    this.activeRail = -1;
    this._o = [];
  }

  startIntro() {
    this.introOn = true;
    this.introT = 0;
  }

  get intro() {
    return clamp(this.introT / INTRO_SECONDS, 0, 1);
  }

  /** Snap to stop coordinate s: no smoothing, no intro, no pending blend or flare. */
  jumpTo(s) {
    this.s = this.sTarget = s;
    this.introOn = false;
    this.introT = INTRO_SECONDS;
    this.blend = null;
    this.flareIn = 0;
  }

  /** Stop coordinate from the scroll position: integer part = stop, fraction = progress through it. */
  coordinate() {
    const y = window.scrollY + innerHeight * 0.5;
    const n = this.spacers.length;
    if (y >= this.tops[n - 1] + this.heights[n - 1]) return n - 0.001;
    for (let i = n - 1; i >= 0; i--) {
      if (y >= this.tops[i]) return i + clamp((y - this.tops[i]) / this.heights[i], 0, 1);
    }
    return 0;
  }

  /** Scroll target that shows stop i in its held pose with the text fully visible. */
  scrollTargetFor(i) {
    return i <= 0 ? 0 : this.tops[i] + this.heights[i] * 0.33 - innerHeight * 0.5;
  }

  goTo(i, smoothly = true) {
    window.scrollTo({ top: this.scrollTargetFor(i), behavior: smoothly && !this.reduced ? 'smooth' : 'instant' });
  }

  /** Ease the camera from its current state (e.g. leaving Explore) into the story pose. */
  blendFrom(cam) {
    this.blend = { t: 0, pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };
    this.s = this.sTarget = this.coordinate();
  }

  /** How strongly world i is the subject of the camera right now, 0..1. */
  planetWeight(i) {
    return Math.max(0, 1 - Math.abs(this.s - (STOP.b + i)) * 1.8);
  }

  /** Drone balance for the score: fills one weight per world. */
  audioMix(out) {
    const s = this.s;
    for (let i = 0; i < out.length; i++) out[i] = 0.3 + this.planetWeight(i) * 1.5;
    if (s >= STOP.h + 0.7) out.fill(0.85); // the chain: everyone
    if (s < STOP.b - 0.8) {
      const swell = Math.max(0, 1 - Math.abs(s - STOP.star) * 0.8) * 0.7; // low notes swell near the star
      for (let i = 0; i < out.length; i++) out[i] = 0.5 + (i > 4 ? swell : 0);
    }
  }

  poseAt(s, out) {
    const n = RIGS.length;
    const k = Math.min(n - 1, Math.floor(s));
    const f = s - k;
    evalRig(k, clamp(f, 0, 1) - 0.5, this.ctx, this.A);
    if (k < n - 1 && f > 0.55) {
      evalRig(k + 1, -0.5, this.ctx, this.B);
      return blendPose(this.A, this.B, (f - 0.55) / 0.45, out);
    }
    return out.copy(this.A);
  }

  update(dt, seconds) {
    const eng = this.engine;
    const cam = eng.camera;

    this.sTarget = this.coordinate();
    this.s = this.reduced ? this.sTarget : lerp(this.s, this.sTarget, ease(5.2, dt));
    if (Math.abs(this.sTarget - this.s) < 1e-4) this.s = this.sTarget;
    if (this.introOn) this.introT = Math.min(INTRO_SECONDS, this.introT + dt);

    this.pointerS.lerp(this.pointer, ease(3, dt));
    const introE = 1 - Math.pow(1 - this.intro, 3);
    const onHero = this.s < 1;

    const ctx = this.ctx;
    ctx.days = this.clock.days;
    ctx.aspect = cam.aspect;
    ctx.sheet = isSheet();
    ctx.breath = this.reduced ? 0 : Math.sin(seconds * 0.11) * 1.4;
    ctx.dolly = 1 + (1 - introE) * (onHero ? 0.55 : 0);
    ctx.time = seconds;
    const pose = this.poseAt(this.s, this.pose);

    cam.fov = pose.fov + (1 - introE) * (onHero ? 8 : 0);
    cam.position.copy(pose.pos);
    cam.up.copy(UP);
    cam.lookAt(pose.look);
    if (!this.reduced) {
      // pointer parallax: a few degrees of yaw and pitch
      cam.rotateY(-this.pointerS.x * 0.026);
      cam.rotateX(-this.pointerS.y * 0.016);
    }
    if (this.blend) {
      const b = this.blend;
      b.t = Math.min(1, b.t + dt / 1.4);
      const e = easeInOut(b.t);
      cam.position.lerpVectors(b.pos, cam.position, e);
      cam.quaternion.slerpQuaternions(b.quat, cam.quaternion, e);
      cam.fov = lerp(b.fov, cam.fov, e);
      if (b.t >= 1) this.blend = null;
    }
    eng.commitCamera(pose.shiftX, pose.shiftY);

    const v = this.view;
    v.exagP = pose.exagP;
    v.exagS = pose.exagS;
    v.orbits = pose.orbits;
    v.markers = pose.markers;
    v.mercury = pose.mercury;
    v.exposure = pose.exposure;
    v.bloom = pose.bloom;
    v.flare = pose.flare;
    eng.applyView(v);

    if (this.flareIn > 0 && (this.flareIn -= dt) <= 0) eng.system.triggerFlare(cam);

    this._panels(this.s);
    this._telemetry(cam, pose, seconds);
    this._scaleLabel(cam, pose);
  }

  _panels(s) {
    let veil = 0;
    for (let i = 0; i < this.panels.length; i++) {
      const f = s - i;
      const o = f > -0.02 && f < 1.02 ? smooth(0.05, 0.24, f) * (1 - smooth(0.7, 0.9, f)) : 0;
      const str = o.toFixed(3);
      if (str !== this._o[i]) {
        this._o[i] = str;
        const el = this.panels[i];
        el.style.setProperty('--o', str);
        el.classList.toggle('is-on', o > 0.02);
      }
      veil = Math.max(veil, o);
    }
    this._write('veil', this.els.veil.style, '--veil', veil.toFixed(3));
    this._write('tele', this.els.telemetryEl.style, 'opacity', (1 - smooth(STOP.scale + 0.55, STOP.scale + 0.95, s)).toFixed(3));

    // rail follows the camera's arrival: stop k until 62% through it, then k+1
    const k = Math.floor(s);
    const active = Math.min(this.spacers.length - 1, s - k > 0.62 ? k + 1 : k);
    if (active !== this.activeRail) {
      this.activeRail = active;
      for (const li of this.railItems) {
        const idx = Number(li.dataset.idx);
        li.classList.toggle('on', idx === active);
        li.classList.toggle('past', idx < active);
      }
      this.focusIndex = active >= STOP.b && active <= STOP.h ? active - STOP.b : -1;
      if (active === STOP.star) this.flareIn = 2.4; // let the star show off when we arrive
      const hue = this.panels[active]?.style.getPropertyValue('--hue');
      if (hue) document.documentElement.style.setProperty('--hue', hue);
    }
    this._write('prog', this.els.progress.style, '--p', clamp(window.scrollY / this.maxScroll, 0, 1).toFixed(4));
  }

  /** Style write that skips unchanged values (custom properties dirty the whole subtree). */
  _write(key, style, prop, value) {
    if (this._css[key] === value) return;
    this._css[key] = value;
    style.setProperty(prop, value);
  }

  _scaleLabel(cam, pose) {
    const el = this.els.scaleLabel;
    if (pose.mercury < 0.02) {
      if (el.style.opacity !== '0') el.style.opacity = '0';
      return;
    }
    const v = this._labelPoint || (this._labelPoint = new THREE.Vector3(Math.cos(1.0) * this.els.mercuryOrbit, 0, Math.sin(1.0) * this.els.mercuryOrbit));
    const p = _p.copy(v).project(cam);
    if (p.z >= 1) return;
    el.style.transform = `translate(${((p.x * 0.5 + 0.5) * this.engine.cssW).toFixed(1)}px, ${((-p.y * 0.5 + 0.5) * this.engine.cssH).toFixed(1)}px)`;
    el.style.opacity = String(Math.min(1, pose.mercury) * 0.9);
  }

  _telemetry(cam, pose, seconds) {
    if (seconds - this.lastTele < 0.1) return;
    this.lastTele = seconds;
    const { fmt, units, dist, delay, scale } = this.els;
    const km = cam.position.length() * R_EARTH_KM;
    const light = km / C_KMS;
    dist.textContent = `${fmt(km / 1e6, km < 1e7 ? 2 : 1)} ${units.millionKm}`;
    delay.textContent = light < 100 ? `${fmt(light, 1)} ${units.s}` : `${fmt(light / 60, 1)} ${units.min}`;
    const x = pose.exagP;
    scale.textContent = x < 1.05 ? units.trueScale : units.exaggerated.replace('{n}', fmt(x, x < 10 ? 1 : 0).replace(/[.,]0$/, ''));
  }
}
