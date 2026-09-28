import * as THREE from 'three';
import { NOISE } from './glsl.js';

// Background: a star field (Points), a faint nebular dome, and a dust volume that
// wraps around the camera to give parallax when it moves.

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STARS_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uPx;
uniform float uTime;
uniform float uTwinkle;
varying vec3 vColor;
void main(){
  vColor = aColor * (1.0 + uTwinkle * 0.35 * sin(uTime * (1.5 + aPhase) + aPhase * 40.0));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPx;
}
`;
const STARS_FRAG = /* glsl */ `
varying vec3 vColor;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = exp(-d * 4.0);
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

const NEBULA_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pinned to the far plane
}
`;
const NEBULA_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
uniform float uOct;
uniform float uStrength;
${NOISE}
void main(){
  vec3 d = normalize(vDir);
  // A tilted band, like the galactic plane seen from outside our own neighbourhood.
  vec3 axis = normalize(vec3(0.35, 0.82, -0.45));
  float lat = dot(d, axis);
  float band = exp(-lat * lat * 9.0);
  float n = fbm(d * 2.2 + 3.0, max(uOct - 1.0, 3.0)) * 0.5 + 0.5;
  float dust = fbm(d * 5.0 + 11.0, 3.0) * 0.5 + 0.5;
  float cloud = smoothstep(0.28, 0.95, n) * (0.25 + 0.75 * band);
  float lanes = smoothstep(0.55, 0.8, dust) * band;
  vec3 plum = vec3(0.060, 0.022, 0.052);
  vec3 ember = vec3(0.180, 0.055, 0.035);
  vec3 indigo = vec3(0.024, 0.030, 0.085);
  vec3 col = mix(indigo, plum, smoothstep(0.2, 0.8, n));
  col += ember * cloud * 0.9;
  col += indigo * band * 1.6;
  col *= 1.0 - lanes * 0.65;
  col *= uStrength;
  gl_FragColor = vec4(col, 1.0);
}
`;

const DUST_VERT = /* glsl */ `
attribute vec3 aSeed;
uniform vec3 uCam;
uniform float uBox;
uniform float uTime;
uniform float uPx;
uniform float uSize;
varying float vAlpha;
void main(){
  vec3 p = aSeed * uBox;
  p += vec3(sin(uTime * 0.05 + aSeed.y * 40.0), cos(uTime * 0.04 + aSeed.z * 30.0), sin(uTime * 0.03 + aSeed.x * 50.0)) * 3.0;
  vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec4 mv = viewMatrix * vec4(uCam + rel, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(rel);
  float depthFade = 1.0 - smoothstep(uBox * 0.28, uBox * 0.5, d);
  float near = smoothstep(0.0, uBox * 0.02, d);
  vAlpha = depthFade * near * (0.35 + 0.65 * fract(aSeed.x * 91.7));
  gl_PointSize = clamp(uSize * uPx * (0.6 + fract(aSeed.y * 53.1)) * (26.0 / max(-mv.z, 4.0)), 1.0, 5.0 * uPx);
}
`;
const DUST_FRAG = /* glsl */ `
varying float vAlpha;
uniform vec3 uColor;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  gl_FragColor = vec4(uColor * vAlpha * (1.0 - d), 1.0);
}
`;

export function createSky(shared) {
  const group = new THREE.Group();
  group.frustumCulled = false;

  // --- stars ---
  const rnd = mulberry32(1337);
  const N = 9000;
  const pos = new Float32Array(N * 3);
  const size = new Float32Array(N);
  const col = new Float32Array(N * 3);
  const phase = new Float32Array(N);
  const tint = [
    [1.0, 0.72, 0.5], // K/M
    [1.0, 0.9, 0.78],
    [0.85, 0.9, 1.0],
    [0.7, 0.8, 1.0],
  ];
  const axis = new THREE.Vector3(0.35, 0.82, -0.45).normalize();
  const v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    // Bias towards a band so the sky has structure.
    for (;;) {
      v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      const l = v.length();
      if (l > 1 || l < 0.05) continue;
      v.divideScalar(l);
      const lat = v.dot(axis);
      if (rnd() < 0.25 + 0.75 * Math.exp(-lat * lat * 7)) break;
    }
    pos[i * 3] = v.x * 9000;
    pos[i * 3 + 1] = v.y * 9000;
    pos[i * 3 + 2] = v.z * 9000;
    const m = Math.pow(rnd(), 5.5); // most stars are faint
    size[i] = 1.1 + m * 3.6;
    const t = tint[Math.min(3, Math.floor(rnd() * 4))];
    const b = 0.16 + m * 2.2;
    col[i * 3] = t[0] * b;
    col[i * 3 + 1] = t[1] * b;
    col[i * 3 + 2] = t[2] * b;
    phase[i] = rnd();
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  sg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uPx: shared.uPx, uTime: shared.uTime, uTwinkle: { value: 1 } },
    vertexShader: STARS_VERT,
    fragmentShader: STARS_FRAG,
    // not 'transparent': keeps the stars in the opaque pass so renderOrder puts them first
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(sg, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -90;
  group.add(stars);

  // --- nebula dome ---
  const nebMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uOct: shared.uOct, uStrength: { value: 0.1 } },
    vertexShader: NEBULA_VERT,
    fragmentShader: NEBULA_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 32), nebMat);
  dome.frustumCulled = false;
  dome.renderOrder = -100;
  group.add(dome);

  // --- dust ---
  const DN = 2600;
  const seeds = new Float32Array(DN * 3);
  const r2 = mulberry32(99);
  for (let i = 0; i < DN * 3; i++) seeds[i] = r2();
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DN * 3), 3));
  dg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  const dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uBox: { value: 220 },
      uTime: shared.uTime,
      uPx: shared.uPx,
      uSize: { value: 1.4 },
      uColor: { value: new THREE.Color(1.0, 0.62, 0.42).multiplyScalar(0.55) },
    },
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dg, dustMat);
  dust.frustumCulled = false;
  dust.renderOrder = 5;

  return {
    group,
    dust,
    starMat,
    nebMat,
    dustMat,
    /** Keep the star field centred on the camera; scale the dust box with the scene. */
    follow(camera, dustBox) {
      group.position.copy(camera.position);
      dustMat.uniforms.uCam.value.copy(camera.position);
      if (dustBox) dustMat.uniforms.uBox.value = dustBox;
    },
  };
}
