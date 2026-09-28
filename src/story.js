import * as THREE from 'three';
import { PLANETS, STAR, R_EARTH_KM, orbitAngle } from './data.js';
import { STOPS } from './ui.js';

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const C_KMS = 299792.458;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const glerp = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t)); // geometric, for exaggeration

// Camera rigs, one per stop (same order as STOPS).
//  planet rigs: az 0 = camera on the star side (full phase), 90 = quarter, 180 = night side.
//  dist is in *visual* planet radii. shift moves the subject right (fraction of width).
export const RIGS = [
  { kind: 'planet', p: 3, az: 187, el: 3.5, dist: 10.5, fov: 34, exag: [5, 4.2], shift: 0.15, orbits: 0, drift: [2.5, 0.8], fx: { exposure: 1.0, bloom: 0.95 } },
  { kind: 'star', az: 6, el: 9, dist: 3.9, fov: 38, exag: [5, 2.5], shift: 0.22, orbits: 0, drift: [7, 1.5], fx: { exposure: 0.95, bloom: 0.8 } },
  { kind: 'planet', p: 0, az: 88, el: 9, dist: 4.1, fov: 36, exag: [5, 2.5], shift: 0.25, orbits: 0, drift: [7, 2] },
  { kind: 'planet', p: 1, az: 92, el: 7, dist: 4.1, fov: 36, exag: [5, 2.5], shift: 0.25, orbits: 0, drift: [7, 2] },
  { kind: 'planet', p: 2, az: 70, el: 11, dist: 4.1, fov: 36, exag: [5, 2.5], shift: 0.25, orbits: 0, drift: [7, 2] },
  { kind: 'planet', p: 3, az: 100, el: 8, dist: 4.1, fov: 36, exag: [5, 2.5], shift: 0.25, orbits: 0, drift: [7, 2] },
  { kind: 'planet', p: 4, az: 102, el: 6, dist: 4.1, fov: 36, exag: [5, 2.5], shift: 0.25, orbits: 0, drift: [7, 2] },
  { kind: 'planet', p: 5, az: 84, el: 12, dist: 4.1, fov: 36, exag: [5, 2.5], shift: 0.25, orbits: 0, drift: [7, 2] },
  { kind: 'planet', p: 6, az: 96, el: 8, dist: 4.1, fov: 36, exag: [5, 2.5], shift: 0.25, orbits: 0, drift: [7, 2] },
  { kind: 'free', pos: [0, 3100, 4300], look: [0, 0, 0], fov: 34, exag: [24, 4.5], shift: 0.15, orbits: 0.95, markers: 1, drift: [0, 0], fx: { exposure: 1.0, bloom: 0.7, flare: 0.5 } },
  { kind: 'free', pos: [0, 15200, 20800], look: [0, 0, 0], fov: 34, exag: [1, 1], shift: 0.15, orbits: 0.95, markers: 1, mercury: 1, drift: [0, 0], fx: { exposure: 1.0, bloom: 1.0, flare: 0.5 } },
];

const planetPos = (i, days, out) => {
  const p = PLANETS[i];
  const th = orbitAngle(p, days);
  return out.set(Math.cos(th) * p.orbit, 0, Math.sin(th) * p.orbit);
};

class Pose {
  constructor() {
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = 40;
    this.exagP = 5;
    this.exagS = 2.5;
    this.shiftX = 0;
    this.shiftY = 0;
    this.orbits = 0;
    this.markers = 0;
    this.mercury = 0;
    this.exposure = 1;
    this.bloom = 0.85;
    this.flare = 1;
  }
  copy(o) {
    this.pos.copy(o.pos);
    this.look.copy(o.look);
    Object.assign(this, { fov: o.fov, exagP: o.exagP, exagS: o.exagS, shiftX: o.shiftX, shiftY: o.shiftY, orbits: o.orbits, markers: o.markers, mercury: o.mercury, exposure: o.exposure, bloom: o.bloom, flare: o.flare });
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
  const aspect = ctx.aspect;
  const fit = Math.max(1, 1.12 / aspect);
  const landscape = aspect > 1.05;
  const pxAz = rig.drift[0] * phase * 2 + ctx.breath * 0.6;
  const pxEl = rig.drift[1] * phase * 2;

  out.exagP = rig.exag[0];
  out.exagS = rig.exag[1];
  out.fov = rig.fov;
  out.shiftX = landscape ? rig.shift : 0;
  out.shiftY = landscape ? 0 : 0.2;
  out.orbits = rig.orbits ?? 0;
  out.markers = rig.markers ?? 0;
  out.mercury = rig.mercury ?? 0;
  out.exposure = rig.fx?.exposure ?? 1;
  out.bloom = rig.fx?.bloom ?? 0.85;
  out.flare = rig.fx?.flare ?? 1;

  if (rig.kind === 'planet') {
    const P = planetPos(rig.p, ctx.days, _p);
    const R = PLANETS[rig.p].radius * rig.exag[0];
    _r.copy(P).normalize();
    _t.set(-_r.z, 0, _r.x);
    const az = (rig.az + pxAz) * D2R;
    const el = (rig.el + pxEl) * D2R;
    _d.copy(_r).multiplyScalar(-Math.cos(az)).addScaledVector(_t, Math.sin(az));
    _d.multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el));
    const dist = rig.dist * R * fit * ctx.dolly;
    out.pos.copy(P).addScaledVector(_d, dist);
    out.look.copy(P);
  } else if (rig.kind === 'star') {
    const Rs = STAR.radius * rig.exag[1];
    const P = planetPos(3, ctx.days, _p).normalize();
    _t.set(-P.z, 0, P.x);
    const az = (rig.az + pxAz) * D2R;
    const el = (rig.el + pxEl) * D2R;
    _d.copy(P).multiplyScalar(Math.cos(az)).addScaledVector(_t, Math.sin(az));
    _d.multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el));
    out.pos.copy(_d).multiplyScalar(rig.dist * Rs * fit * ctx.dolly);
    out.look.set(0, 0, 0);
  } else {
    out.look.set(...rig.look);
    out.pos.set(...rig.pos).sub(out.look).multiplyScalar(fit * ctx.dolly).add(out.look);
    // slow orbit for life
    if (!ctx.reduced) {
      const a = (pxAz + ctx.time * 0.6) * D2R * 0.25;
      out.pos.sub(out.look).applyAxisAngle(UP, a).add(out.look);
    }
  }
  return out;
}

const _mid = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _tan = new THREE.Vector3();
function blendPose(A, B, s, out) {
  const e = easeInOut(s);
  // quadratic Bezier with a lifted control point keeps the flight from grazing worlds
  _mid.copy(A.pos).add(B.pos).multiplyScalar(0.5);
  const span = A.pos.distanceTo(B.pos);
  // Lift up and sideways along the orbit: the camera then passes worlds at quarter phase
  // instead of behind them, where only their dark sides would face it.
  _lift.copy(UP).multiplyScalar(span * 0.12);
  _tan.set(-_mid.z, 0, _mid.x);
  if (_tan.lengthSq() > 1e-6) _tan.normalize().multiplyScalar(span * (span < 400 ? 0.42 : 0.1));
  _mid.add(_lift).add(_tan);
  const a = 1 - e;
  out.pos.set(0, 0, 0).addScaledVector(A.pos, a * a).addScaledVector(_mid, 2 * a * e).addScaledVector(B.pos, e * e);
  out.look.lerpVectors(A.look, B.look, e);
  out.fov = lerp(A.fov, B.fov, e) + Math.sin(Math.PI * s) * 7;
  out.exagP = glerp(A.exagP, B.exagP, e);
  out.exagS = glerp(A.exagS, B.exagS, e);
  out.shiftX = lerp(A.shiftX, B.shiftX, e);
  out.shiftY = lerp(A.shiftY, B.shiftY, e);
  out.orbits = lerp(A.orbits, B.orbits, e);
  out.markers = lerp(A.markers, B.markers, e);
  out.mercury = lerp(A.mercury, B.mercury, e);
  out.exposure = lerp(A.exposure, B.exposure, e);
  out.bloom = lerp(A.bloom, B.bloom, e);
  out.flare = lerp(A.flare, B.flare, e);
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
    this.intro = 0;
    this.pointer = new THREE.Vector2();
    this.pointerS = new THREE.Vector2();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.A = new Pose();
    this.B = new Pose();
    this.out = new Pose();
    this.layout();
    this.activeRail = -1;
    this.lastTele = 0;
    this.fx = {};
    this.mode = 'story';
    this._fmtCache = null;
    this.blend = null;
    this.focusIndex = -1;
    this.flareIn = 0;

    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        this.pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
      }
    });
  }

  layout() {
    this.tops = this.spacers.map((el) => el.offsetTop);
    this.heights = this.spacers.map((el) => el.offsetHeight);
  }

  /** Stop coordinate from the scroll position: integer part = stop, fraction = progress through it. */
  coordinate() {
    const y = window.scrollY + innerHeight * 0.5;
    const n = this.spacers.length;
    if (y >= this.tops[n - 1] + this.heights[n - 1]) return n - 0.001;
    for (let i = n - 1; i >= 0; i--) {
      if (y >= this.tops[i]) return i + clamp01((y - this.tops[i]) / this.heights[i]);
    }
    return 0;
  }

  /** Scroll target that shows stop i in its held pose with the text fully visible. */
  scrollTargetFor(i) {
    if (i <= 0) return 0;
    return this.tops[i] + this.heights[i] * 0.33 - innerHeight * 0.5;
  }

  /** Ease the camera from its current state (e.g. leaving Explore) into the story pose. */
  blendFrom(cam) {
    this.blend = { t: 0, pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };
    this.s = this.sTarget = this.coordinate();
  }

  goTo(i, smoothly = true) {
    window.scrollTo({ top: this.scrollTargetFor(i), behavior: smoothly && !this.reduced ? 'smooth' : 'instant' });
  }

  poseAt(s, ctx, out) {
    const n = RIGS.length;
    const k = Math.min(n - 1, Math.floor(s));
    const f = s - k;
    evalRig(k, clamp01(f) - 0.5, ctx, this.A);
    if (k < n - 1 && f > 0.55) {
      evalRig(k + 1, -0.5, ctx, this.B);
      return blendPose(this.A, this.B, (f - 0.55) / 0.45, out);
    }
    return out.copy(this.A);
  }

  update(dt, seconds) {
    const eng = this.engine;
    const cam = eng.camera;
    const sys = eng.system;

    this.sTarget = this.coordinate();
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 5.2);
    this.s += (this.sTarget - this.s) * k;
    if (Math.abs(this.sTarget - this.s) < 1e-4) this.s = this.sTarget;

    this.pointerS.lerp(this.pointer, 1 - Math.exp(-dt * 3));
    const intro = this.intro;
    const introE = 1 - Math.pow(1 - clamp01(intro), 3);

    const ctx = {
      days: this.clock.days,
      aspect: cam.aspect,
      breath: this.reduced ? 0 : Math.sin(seconds * 0.11) * 1.4,
      dolly: 1 + (1 - introE) * (this.s < 1 ? 0.55 : 0),
      reduced: this.reduced,
      time: seconds,
    };
    const pose = this.poseAt(this.s, ctx, this.out);

    cam.fov = pose.fov + (1 - introE) * (this.s < 1 ? 8 : 0);
    cam.position.copy(pose.pos);
    cam.up.copy(UP);
    cam.lookAt(pose.look);

    // pointer parallax: a few degrees of yaw/pitch plus a little lateral drift
    if (!this.reduced) {
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

    const w = eng.cssW;
    const h = eng.cssH;
    if (pose.shiftX || pose.shiftY) cam.setViewOffset(w, h, -pose.shiftX * w, pose.shiftY * h, w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();

    sys.setExaggeration(pose.exagP, pose.exagS);
    sys.setVisible({ orbits: pose.orbits, markers: pose.markers, mercury: pose.mercury });
    sys.hidden = -1;
    sys.setFocus(-1);

    Object.assign(eng.fx, { exposure: pose.exposure, bloom: pose.bloom, flare: pose.flare });

    if (this.flareIn > 0) {
      this.flareIn -= dt;
      if (this.flareIn <= 0) sys.triggerFlare(cam);
    }

    this._panels(this.s);
    this._telemetry(cam, pose, seconds);
    this._scaleLabel(cam, pose);
  }

  _panels(s) {
    let veil = 0;
    let dominant = 0;
    let best = -1;
    const n = this.panels.length;
    for (let i = 0; i < n; i++) {
      const f = s - i;
      let o = 0;
      if (f > -0.02 && f < 1.02) o = smooth(0.05, 0.24, f) * (1 - smooth(0.7, 0.9, f));
      const el = this.panels[i];
      el.style.setProperty('--o', o.toFixed(3));
      const on = o > 0.02;
      if (on !== el.classList.contains('is-on')) el.classList.toggle('is-on', on);
      if (o > best) {
        best = o;
        dominant = i;
      }
      veil = Math.max(veil, o);
    }
    this.els.veil.style.setProperty('--veil', veil.toFixed(3));
    document.body.style.setProperty('--tele', (1 - smooth(10.55, 10.95, s)).toFixed(3));

    // rail follows the camera's arrival: stop k until 55% through it, then k+1
    const k = Math.floor(s);
    const f = s - k;
    const active = Math.min(this.spacers.length - 1, f > 0.62 ? k + 1 : k);
    if (active !== this.activeRail) {
      this.activeRail = active;
      const hue = this.panels[active]?.style.getPropertyValue('--hue');
      for (const li of this.railItems) {
        const idx = Number(li.dataset.idx);
        li.classList.toggle('on', idx === active);
        li.classList.toggle('past', idx < active);
      }
      this.focusIndex = active >= 2 && active <= 8 ? active - 2 : -1;
      if (active === 1) this.flareIn = 2.4;
      if (hue) document.documentElement.style.setProperty('--hue', hue);
      document.body.dataset.stop = STOPS[active];
    }
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    this.els.progress.style.setProperty('--p', clamp01(window.scrollY / maxScroll).toFixed(4));
  }

  _scaleLabel(cam, pose) {
    const el = this.els.scaleLabel;
    if (!el) return;
    const o = pose.mercury;
    if (o < 0.02) {
      if (el.style.opacity !== '0') el.style.opacity = '0';
      return;
    }
    const v = this._lv || (this._lv = new THREE.Vector3());
    v.set(Math.cos(1.0) * 9090, 0, Math.sin(1.0) * 9090).project(cam);
    if (v.z >= 1) return;
    const w = this.engine.cssW;
    const h = this.engine.cssH;
    // account for the view offset used to seat the subject beside the text panel
    el.style.transform = `translate(${((v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
    el.style.opacity = String(Math.min(1, o) * 0.9);
  }

  _telemetry(cam, pose, seconds) {
    if (seconds - this.lastTele < 0.1) return;
    this.lastTele = seconds;
    const km = cam.position.length() * R_EARTH_KM;
    const delay = km / C_KMS;
    const f = this.els.fmt;
    if (!f) return;
    this.els.dist.textContent = `${f(km / 1e6, km < 1e7 ? 2 : 1)} ${this.els.units.millionKm}`;
    this.els.delay.textContent = delay < 100 ? `${f(delay, 1)} ${this.els.units.s}` : `${f(delay / 60, 1)} ${this.els.units.min}`;
    const exp = pose.exagP;
    this.els.scale.textContent = exp < 1.05 ? this.els.units.trueScale : this.els.units.exaggerated.replace('{n}', f(exp, exp < 10 ? 1 : 0).replace(/[.,]0$/, ''));
  }
}
