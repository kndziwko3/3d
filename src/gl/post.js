import * as THREE from 'three';

// Post-processing: MSAA half-float scene target -> dual-filter bloom (13-tap down,
// tent up, Karis average on the first level) -> one composite pass that adds the
// lens flare, chromatic aberration, tone mapping, grade, vignette and film grain.

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uThreshold;
uniform float uKnee;
vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main(){
  vec3 a = s(vec2(-2.0,  2.0)), b = s(vec2(0.0,  2.0)), c = s(vec2(2.0,  2.0));
  vec3 d = s(vec2(-2.0,  0.0)), e = s(vec2(0.0,  0.0)), f = s(vec2(2.0,  0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0,  1.0)), k = s(vec2(1.0,  1.0));
  vec3 l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 res;
  if (uFirst > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25;
    vec3 g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25;
    vec3 g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;
    float w0 = 0.125 / (1.0 + luma(g0));
    float w1 = 0.125 / (1.0 + luma(g1));
    float w2 = 0.125 / (1.0 + luma(g2));
    float w3 = 0.125 / (1.0 + luma(g3));
    float w4 = 0.5 / (1.0 + luma(g4));
    res = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    float br = max(res.r, max(res.g, res.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-5);
    res *= max(soft, br - uThreshold) / max(br, 1e-4);
  } else {
    res = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(res, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uWeight;
vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main(){
  vec3 r = s(vec2(-1.0,  1.0)) + s(vec2(0.0,  1.0)) * 2.0 + s(vec2(1.0,  1.0))
         + s(vec2(-1.0,  0.0)) * 2.0 + s(vec2(0.0,  0.0)) * 4.0 + s(vec2(1.0,  0.0)) * 2.0
         + s(vec2(-1.0, -1.0)) + s(vec2(0.0, -1.0)) * 2.0 + s(vec2(1.0, -1.0));
  gl_FragColor = vec4(r * (1.0 / 16.0) * uWeight, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uBloom;
uniform float uExposure;
uniform float uTime;
uniform vec2 uStarUV;
uniform float uFlare;
uniform float uAberration;
uniform float uGrain;
uniform float uVignette;
uniform float uFade;
uniform float uSat;
uniform float uContrast;

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Khronos PBR Neutral tone mapping: keeps hue and saturation of hot reds.
vec3 neutralTonemap(vec3 color){
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, newPeak * vec3(1.0), g);
}

vec3 srgbEncode(vec3 c){
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

float ring(vec2 p, float r, float w){
  float d = abs(length(p) - r);
  return smoothstep(w, 0.0, d);
}

void main(){
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  vec2 ab = c * uAberration * (0.4 + r2 * 3.0);
  vec3 col;
  col.r = texture2D(tScene, uv + ab).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - ab).b;

  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * uBloom;

  // Lens flare, driven by the star's projected position and how much of it is visible.
  if (uFlare > 0.001) {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 d = (uv - uStarUV) * asp;
    float dist = length(d);
    float streak = exp(-abs(d.y) * 130.0) * exp(-abs(d.x) * 4.6);
    float streakV = exp(-abs(d.x) * 190.0) * exp(-abs(d.y) * 9.0) * 0.10;
    vec3 flare = vec3(1.0, 0.36, 0.12) * (streak * 0.38 + streakV) * uFlare;
    flare += vec3(1.0, 0.45, 0.18) * (0.025 / (dist * dist * 55.0 + 0.03)) * uFlare * 0.55;
    vec2 axis = (vec2(0.5) - uStarUV) * asp;
    vec2 sp = uStarUV * asp;
    vec2 q = uv * asp;
    flare += vec3(0.30, 0.50, 1.00) * ring(q - (sp + axis * 1.55), 0.055, 0.030) * 0.018 * uFlare;
    flare += vec3(1.00, 0.55, 0.25) * ring(q - (sp + axis * 2.10), 0.030, 0.020) * 0.025 * uFlare;
    flare += vec3(1.00, 0.60, 0.30) * smoothstep(0.060, 0.0, length(q - (sp + axis * 1.25))) * 0.02 * uFlare;
    col += flare;
  }

  col *= uExposure;
  col = neutralTonemap(col);

  // Grade: gentle S-curve, plum shadows, warm highlights.
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float shadow = 1.0 - smoothstep(0.0, 0.45, l);
  col += vec3(0.006, 0.0018, 0.008) * shadow;
  col *= mix(vec3(1.0), vec3(0.94, 0.98, 1.10), shadow * 0.55);
  col *= mix(vec3(1.0), vec3(1.04, 1.0, 0.94), smoothstep(0.55, 1.0, l) * 0.6);
  col = mix(vec3(l), col, uSat);

  col *= 1.0 - uVignette * smoothstep(0.25, 0.95, length(c) * 1.35);

  col = srgbEncode(clamp(col, 0.0, 1.0));
  float n = hash12(uv * uRes + fract(uTime) * 91.7) - 0.5;
  col += n * uGrain;
  col *= uFade;
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeFullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.width = 2;
    this.height = 2;
    this.levels = 6;
    this.samples = 4;
    this.mips = [];
    this.sceneRT = null;

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = makeFullscreenTriangle();
    const mk = (mat) => {
      const mesh = new THREE.Mesh(tri, mat);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      return { scene, mat };
    };

    this.down = mk(
      new THREE.ShaderMaterial({
        uniforms: {
          tSrc: { value: null },
          uTexel: { value: new THREE.Vector2() },
          uFirst: { value: 0 },
          uThreshold: { value: 0.9 },
          uKnee: { value: 0.5 },
        },
        vertexShader: FS_VERT,
        fragmentShader: DOWN_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.up = mk(
      new THREE.ShaderMaterial({
        uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } },
        vertexShader: FS_VERT,
        fragmentShader: UP_FRAG,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneFactor,
      }),
    );
    this.comp = mk(
      new THREE.ShaderMaterial({
        uniforms: {
          tScene: { value: null },
          tBloom: { value: null },
          uRes: { value: new THREE.Vector2(1, 1) },
          uBloom: { value: 0.9 },
          uExposure: { value: 1 },
          uTime: { value: 0 },
          uStarUV: { value: new THREE.Vector2(0.5, 0.5) },
          uFlare: { value: 0 },
          uAberration: { value: 0.0015 },
          uGrain: { value: 0.028 },
          uVignette: { value: 0.5 },
          uFade: { value: 1 },
          uSat: { value: 1.06 },
          uContrast: { value: 0.28 },
        },
        vertexShader: FS_VERT,
        fragmentShader: COMPOSITE_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  /** width/height in device pixels. */
  setSize(width, height) {
    this.width = Math.max(2, Math.floor(width));
    this.height = Math.max(2, Math.floor(height));
    this._build();
  }

  setQuality({ samples, levels }) {
    const changed = samples !== this.samples || levels !== this.levels;
    this.samples = samples;
    this.levels = levels;
    if (changed) this._build();
  }

  _build() {
    this.sceneRT?.dispose();
    for (const m of this.mips) m.rt.dispose();
    this.mips = [];

    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.samples,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    let w = this.width;
    let h = this.height;
    for (let i = 0; i < this.levels; i++) {
      w = Math.max(2, Math.floor(w / 2));
      h = Math.max(2, Math.floor(h / 2));
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
      });
      this.mips.push({ rt, w, h });
    }
    this.comp.mat.uniforms.uRes.value.set(this.width, this.height);
  }

  _draw(pass, target, clear) {
    const r = this.renderer;
    r.setRenderTarget(target);
    if (clear) r.clear();
    r.render(pass.scene, this.cam);
  }

  /** fx: exposure, bloom, threshold, flare, starUV, aberration, grain, vignette, fade, time */
  render(scene, camera, fx) {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    r.autoClear = false;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    // bloom chain
    const d = this.down;
    d.mat.uniforms.uThreshold.value = fx.threshold ?? 0.9;
    let src = this.sceneRT.texture;
    let sw = this.width;
    let sh = this.height;
    for (let i = 0; i < this.mips.length; i++) {
      const m = this.mips[i];
      d.mat.uniforms.tSrc.value = src;
      d.mat.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      d.mat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      this._draw(d, m.rt, true);
      src = m.rt.texture;
      sw = m.w;
      sh = m.h;
    }
    const u = this.up;
    for (let i = this.mips.length - 2; i >= 0; i--) {
      const from = this.mips[i + 1];
      u.mat.uniforms.tSrc.value = from.rt.texture;
      u.mat.uniforms.uTexel.value.set(1 / from.w, 1 / from.h);
      u.mat.uniforms.uWeight.value = 1;
      this._draw(u, this.mips[i].rt, false);
    }

    const cu = this.comp.mat.uniforms;
    cu.tScene.value = this.sceneRT.texture;
    cu.tBloom.value = this.mips[0].rt.texture;
    cu.uBloom.value = fx.bloom ?? 0.9;
    cu.uExposure.value = fx.exposure ?? 1;
    cu.uTime.value = fx.time ?? 0;
    cu.uFlare.value = fx.flare ?? 0;
    if (fx.starUV) cu.uStarUV.value.copy(fx.starUV);
    cu.uAberration.value = fx.aberration ?? 0.0015;
    cu.uGrain.value = fx.grain ?? 0.028;
    cu.uVignette.value = fx.vignette ?? 0.5;
    cu.uFade.value = fx.fade ?? 1;
    this._draw(this.comp, null, true);

    r.autoClear = prevAuto;
  }

  dispose() {
    this.sceneRT?.dispose();
    for (const m of this.mips) m.rt.dispose();
  }
}
