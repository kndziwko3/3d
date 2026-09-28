import * as THREE from 'three';
import { System } from './system.js';
import { Post } from './post.js';
import { EXAG } from '../data.js';
import { clamp } from '../math.js';

export const TIERS = [
  { name: 'low', dprCap: 1, samples: 0, levels: 4, octaves: 4 },
  { name: 'medium', dprCap: 1.5, samples: 2, levels: 5, octaves: 5 },
  { name: 'high', dprCap: 2, samples: 4, levels: 6, octaves: 6 },
];

const ABERRATION = 0.0016; // chromatic aberration, off on the low tier

/** What a mode may ask of the scene each frame. Anything it leaves out means "the default", never "what the last mode left". */
const VIEW_DEFAULTS = {
  exagP: EXAG.story.p,
  exagS: EXAG.story.s,
  orbits: 0,
  markers: 0,
  mercury: 0,
  focus: -1, // planet index whose marker is emphasised
  hidden: -1, // planet index hidden because the camera stands on it (surface view)
  exposure: 1,
  bloom: 0.85,
  flare: 1,
};

/** Owns the renderer, camera, scene, post chain, screen fade and the quality governor. */
export class Engine {
  constructor(canvas, { tier } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: false, // the scene target owns depth
      powerPreference: 'high-performance',
    });
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60000);
    this.system = new System(this.renderer);
    this.post = new Post(this.renderer);
    // Single source of the look. Post reads every key from here.
    this.fx = {
      exposure: 1,
      bloom: 0.85,
      threshold: 0.95,
      flare: 1,
      starVisibility: 0,
      starUV: new THREE.Vector2(0.5, 0.5),
      aberration: ABERRATION,
      grain: 0.03,
      vignette: 0.5,
      fade: 1,
      time: 0,
    };
    this._fadeTarget = 1;
    this._fadeRate = 0;

    this.rendererName = this._detectRenderer();
    const soft = /swiftshader|llvmpipe|software|softpipe/i.test(this.rendererName);
    const coarse = matchMedia('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    this.tierIndex = tier ?? (soft ? 0 : coarse || cores <= 4 ? 1 : 2);
    // never auto-upgrade past the tier the device class suggests (soft renderers stay at low)
    this._maxTier = tier ?? (soft ? 0 : 2);
    this.resScale = 1;
    this.cssW = 1;
    this.cssH = 1;
    this.frameMs = 16;
    this._govFrames = 0;
    this._govCalm = 0;
    this._govCooldown = 0;
    this._minWin = Infinity;
    this._lastUpgrade = -Infinity;
    this._noUpgradeUntil = 0;

    this._applyTier();
  }

  _detectRenderer() {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  get tier() {
    return TIERS[this.tierIndex];
  }

  _applyTier() {
    const t = this.tier;
    this.post.setQuality({ samples: t.samples, levels: t.levels });
    this.system.setQuality({ octaves: t.octaves });
    this.resize(this.cssW, this.cssH, true);
  }

  setTier(i) {
    this.tierIndex = clamp(i, 0, TIERS.length - 1);
    this._applyTier();
  }

  resize(cssW, cssH, force = false) {
    if (!force && cssW === this.cssW && cssH === this.cssH) return;
    this.cssW = cssW;
    this.cssH = cssH;
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier.dprCap) * this.resScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.setSize(size.x, size.y);
    this.system.setPixelScale(dpr);
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
  }

  setResScale(s) {
    const v = clamp(s, 0.55, 1);
    if (Math.abs(v - this.resScale) < 1e-3) return;
    this.resScale = v;
    this.resize(this.cssW, this.cssH, true);
  }

  // ---- screen fade: the only writer of fx.fade ----

  setFade(v) {
    this.fx.fade = this._fadeTarget = v;
    this._fadeRate = 0;
  }

  fadeTo(target, seconds) {
    this._fadeTarget = target;
    this._fadeRate = Math.abs(target - this.fx.fade) / Math.max(seconds, 1e-3);
  }

  // ---- camera and view: the only place the projection is finalised ----

  /**
   * Call after positioning the camera. Seats the subject away from the centre (fx: fraction of the
   * width it moves right, fy: fraction of the height it moves up) so it clears the text panel or
   * bottom sheet, then refreshes the projection and the world matrices that projections rely on.
   */
  commitCamera(fx = 0, fy = 0) {
    const c = this.camera;
    if (Math.abs(fx) < 1e-4 && Math.abs(fy) < 1e-4) c.clearViewOffset();
    else c.setViewOffset(this.cssW, this.cssH, -fx * this.cssW, fy * this.cssH, this.cssW, this.cssH);
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
  }

  /** Apply a mode's view. Missing fields take VIEW_DEFAULTS. */
  applyView(v) {
    const d = VIEW_DEFAULTS;
    const s = this.system;
    s.setExaggeration(v.exagP ?? d.exagP, v.exagS ?? d.exagS);
    s.setVisible(v.orbits ?? d.orbits, v.markers ?? d.markers, v.mercury ?? d.mercury);
    s.setFocus(v.focus ?? d.focus);
    s.setSurfaceWorld(v.hidden ?? d.hidden);
    this.fx.exposure = v.exposure ?? d.exposure;
    this.fx.bloom = v.bloom ?? d.bloom;
    this.fx.flare = v.flare ?? d.flare;
  }

  /**
   * Called once per frame with the raw frame time in ms. rAF is vsync-locked, so "fast" means
   * "keeping up with the display's own interval" (learned from the fastest recent frames), not
   * a fixed millisecond figure. Quality steps up only if an earlier upgrade did not backfire.
   */
  govern(ms) {
    this.frameMs += (ms - this.frameMs) * 0.08;
    this._minWin = Math.min(this._minWin, ms);
    if (this._govCooldown > 0) {
      this._govCooldown--;
      return;
    }
    if (++this._govFrames < 40) return;
    this._govFrames = 0;
    const base = clamp(this._minWin, 4, 60); // ≈ display refresh interval
    this._minWin = Infinity;
    const now = performance.now();
    const slow = this.frameMs > Math.max(24, base * 1.5);
    const keepingUp = base < 22 && this.frameMs < base * 1.12 + 1;
    if (slow) {
      this._govCalm = 0;
      if (now - this._lastUpgrade < 12000) this._noUpgradeUntil = now + 90000; // it backfired
      if (this.resScale > 0.62) this.setResScale(this.resScale - 0.12);
      else if (this.tierIndex > 0) {
        this.setResScale(0.85);
        this.setTier(this.tierIndex - 1);
      }
      this._govCooldown = 50;
    } else if (keepingUp && now > this._noUpgradeUntil) {
      if (++this._govCalm >= 5) {
        this._govCalm = 0;
        if (this.resScale < 1) {
          this.setResScale(this.resScale + 0.1);
          this._lastUpgrade = now;
        } else if (this.tierIndex < this._maxTier) {
          this.setTier(this.tierIndex + 1);
          this._lastUpgrade = now;
        }
        this._govCooldown = 50;
      }
    } else {
      this._govCalm = 0;
    }
  }

  /** Step 1 of a frame: place the worlds, so modes see current positions when they move the camera. */
  advance(simDays, seconds, dt) {
    this.system.updateBodies(simDays, seconds, dt);
  }

  /** Step 2: after the mode has moved the camera. draw = false skips the GPU (test harness). */
  render(seconds, dt, draw = true) {
    const fx = this.fx;
    if (fx.fade !== this._fadeTarget) {
      const step = this._fadeRate * dt;
      fx.fade = Math.abs(this._fadeTarget - fx.fade) <= step ? this._fadeTarget : fx.fade + Math.sign(this._fadeTarget - fx.fade) * step;
    }
    const s = this.system;
    this.camera.updateMatrixWorld(true); // projections below must use this frame's view matrix
    s.update(dt, this.camera, this.cssH);
    if (!draw) return;
    fx.time = seconds;
    fx.starUV.copy(s.starUV);
    fx.starVisibility = s.starVisibility;
    fx.aberration = this.tierIndex === 0 ? 0 : ABERRATION;
    this.post.render(s.scene, this.camera, fx);
  }
}
