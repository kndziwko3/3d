import * as THREE from 'three';
import { System } from './system.js';
import { Post } from './post.js';

export const TIERS = [
  { name: 'low', dprCap: 1, samples: 0, levels: 4, octaves: 4 },
  { name: 'medium', dprCap: 1.5, samples: 2, levels: 5, octaves: 5 },
  { name: 'high', dprCap: 2, samples: 4, levels: 6, octaves: 6 },
];

/** Owns the renderer, camera, scene, post chain and quality governor. */
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
    this.gl = this.renderer.getContext();

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60000);
    this.system = new System();
    this.post = new Post(this.renderer);
    this.fx = {
      exposure: 1,
      bloom: 0.85,
      threshold: 0.95,
      flare: 1,
      aberration: 0.0016,
      grain: 0.03,
      vignette: 0.5,
      fade: 1,
    };

    this.rendererName = this._detectRenderer();
    const soft = /swiftshader|llvmpipe|software|softpipe/i.test(this.rendererName);
    const coarse = matchMedia('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    let start = 2;
    if (coarse || cores <= 4) start = 1;
    if (soft) start = 0;
    this.tierIndex = tier ?? start;
    // never auto-upgrade past the tier the device class suggests (soft renderers stay at low)
    this._maxTier = tier ?? (soft ? 0 : 2);
    this.resScale = 1;
    this.cssW = 1;
    this.cssH = 1;
    this.frameMs = 16;
    this._govFrames = 0;
    this._govCalm = 0;
    this._govCooldown = 0;
    this.onQuality = null;

    this._applyTier();
  }

  _detectRenderer() {
    try {
      const ext = this.gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
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
    this.onQuality?.(this);
  }

  setTier(i) {
    this.tierIndex = THREE.MathUtils.clamp(i, 0, TIERS.length - 1);
    this._applyTier();
  }

  resize(cssW, cssH, force = false) {
    if (!force && cssW === this.cssW && cssH === this.cssH) return;
    this.cssW = cssW;
    this.cssH = cssH;
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier.dprCap) * this.resScale;
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.setSize(size.x, size.y);
    this.system.setPixelScale(dpr);
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
  }

  setResScale(s) {
    const v = THREE.MathUtils.clamp(s, 0.55, 1);
    if (Math.abs(v - this.resScale) < 1e-3) return;
    this.resScale = v;
    this.resize(this.cssW, this.cssH, true);
  }

  /**
   * Called once per frame with the raw frame time in ms. rAF is vsync-locked, so "fast" means
   * "keeping up with the display's own interval" (learned from the fastest recent frames), not
   * a fixed millisecond figure. Quality steps up only if an earlier upgrade did not backfire.
   */
  govern(ms) {
    this.frameMs += (ms - this.frameMs) * 0.08;
    this._minWin = Math.min(this._minWin ?? Infinity, ms);
    if (this._govCooldown > 0) {
      this._govCooldown--;
      return;
    }
    if (++this._govFrames < 40) return;
    this._govFrames = 0;
    const base = THREE.MathUtils.clamp(this._minWin, 4, 60); // ≈ display refresh interval
    this._minWin = Infinity;
    const now = performance.now();
    const slow = this.frameMs > Math.max(24, base * 1.5);
    const keepingUp = base < 22 && this.frameMs < base * 1.12 + 1;
    if (slow) {
      this._govCalm = 0;
      if (now - (this._lastUpgrade ?? -1e9) < 12000) this._noUpgradeUntil = now + 90000; // it backfired
      if (this.resScale > 0.62) this.setResScale(this.resScale - 0.12);
      else if (this.tierIndex > 0) {
        this.setResScale(0.85);
        this.setTier(this.tierIndex - 1);
      }
      this._govCooldown = 50;
    } else if (keepingUp && now > (this._noUpgradeUntil ?? 0)) {
      if (++this._govCalm >= 5) {
        this._govCalm = 0;
        if (this.resScale < 1) {
          this.setResScale(this.resScale + 0.1);
          this._lastUpgrade = now;
        } else if (this.tierIndex < TIERS.length - 1 && this.tierIndex < this._maxTier) {
          this.setTier(this.tierIndex + 1);
          this._lastUpgrade = now;
        }
        this._govCooldown = 50;
      }
    } else {
      this._govCalm = 0;
    }
  }

  render(simDays, seconds, dt, fxOverride) {
    const s = this.system;
    this.camera.updateMatrixWorld(true); // projections below must use this frame's view matrix
    s.update(simDays, seconds, dt, this.camera, this.cssH);
    const fx = { ...this.fx, ...fxOverride };
    fx.time = seconds;
    fx.starUV = s.starUV;
    fx.flare = (fx.flare ?? 1) * s.starVisibility;
    if (this.tierIndex === 0) fx.aberration = 0;
    this.post.render(s.scene, this.camera, fx);
  }
}
