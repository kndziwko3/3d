import * as THREE from 'three';
import { NOISE, CRATERS, BUMP, LINES, RAY_SPHERE, SUN_DIR, OBJ_VERT } from './glsl.js';

// All planets are tidally locked, so in a planet's own frame the star sits on +X
// forever. The mesh is rotated each frame to keep that true (see system.js), which
// lets every shader assume L = (1, 0, 0) in object space.

const PLANET_FRAG = /* glsl */ `
varying vec3 vPos;
varying vec3 vView;
uniform float uTime;
uniform float uOct;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
${SUN_DIR}
${NOISE}
${CRATERS}
${BUMP}
${LINES}

struct Surf {
  vec3 albedo;
  float height;
  float spec;
  float gloss;
  float bump;
  vec3 emit;
};

Surf surface(vec3 p){
  Surf s;
  s.spec = 0.0; s.gloss = 60.0; s.bump = 0.8; s.emit = vec3(0.0); s.height = 0.0;
  float oct = uOct;

#if PTYPE == 0
  // b: airless, scorched basalt. JWST sees a bare dayside near 500 K.
  float low = fbm(p * 2.2 + 3.0, 3.0);
  float rimA, rimB;
  float ch = craterLayer(p, 5.0, 1.0, rimA);
  float ch2 = craterLayer(p, 12.0, 7.0, rimB);
  float fine = fbm(p * 38.0, max(oct - 2.0, 2.0));
  s.height = ch + ch2 * 0.7 + low * 0.05 + fine * 0.006;
  vec3 dark = vec3(0.040, 0.036, 0.040);
  vec3 mid = vec3(0.170, 0.118, 0.092);
  vec3 rust = vec3(0.330, 0.150, 0.085);
  vec3 a = mix(dark, mid, smoothstep(-0.35, 0.65, low + fine * 0.5));
  a = mix(a, rust, smoothstep(0.30, 0.75, fbm(p * 3.4 + 9.0, 3.0)) * 0.55);
  a *= 1.0 - 0.45 * smoothstep(-0.02, -0.10, ch);
  a = mix(a, a * 1.9 + 0.02, clamp(rimA + rimB * 0.6, 0.0, 1.0) * 0.55);
  s.albedo = a;
  s.bump = 1.1;
  // faint thermal glow on the hottest hemisphere
  float hot = smoothstep(0.55, 1.0, p.x);
  s.emit = vec3(0.55, 0.11, 0.03) * hot * hot * (0.05 + 0.25 * smoothstep(0.2, 0.8, ridged(p * 6.0, 3.0)));

#elif PTYPE == 1
  // c: dusty ochre plains, dark basaltic basins
  float mott = fbm(p * 3.0 + 1.0, 4.0);
  float dunes = ridged(p * vec3(9.0, 15.0, 9.0) + mott * 1.4, 3.0);
  float basin = smoothstep(0.05, 0.32, fbm(p * 1.3 + 5.0, 3.0));
  float rimA, rimB;
  float ch = craterLayer(p, 4.0, 3.0, rimA) * 0.7;
  float ch2 = craterLayer(p, 9.5, 5.0, rimB) * 0.6;
  float fine = fbm(p * 30.0, max(oct - 2.0, 2.0));
  s.height = ch + ch2 + mott * 0.03 + dunes * 0.012 + fine * 0.004;
  vec3 c0 = vec3(0.440, 0.285, 0.115);
  vec3 c1 = vec3(0.235, 0.135, 0.070);
  vec3 c2 = vec3(0.650, 0.520, 0.320);
  vec3 a = mix(c1, c0, smoothstep(-0.35, 0.45, mott));
  a = mix(a, c2, smoothstep(0.55, 0.95, dunes) * 0.45);
  a = mix(a, vec3(0.055, 0.048, 0.052), basin * 0.85);
  a = mix(a, a * 1.7 + 0.03, clamp(rimA + rimB * 0.5, 0.0, 1.0) * 0.4);
  s.albedo = a * (0.9 + 0.2 * fine);
  s.bump = 1.0;

#elif PTYPE == 2
  // d: veiled world, cloud deck spiralling around the sub-stellar point
  float r = acos(clamp(p.x, -1.0, 1.0));
  float phi = atan(p.z, p.y);
  float warp = fbm(p * 2.0 + vec3(uTime * 0.006), 4.0);
  float sw = phi + 2.7 * r + warp * 1.7 + uTime * 0.012;
  float bandsN = fbm(p * 5.0, 4.0);
  float bands = 0.5 + 0.5 * sin(sw * 2.4 + bandsN * 2.6);
  float fine = fbm(p * 11.0 + vec3(0.0, uTime * 0.008, 0.0), oct);
  vec3 cream = vec3(0.94, 0.79, 0.57);
  vec3 amber = vec3(0.66, 0.38, 0.17);
  vec3 pale = vec3(0.99, 0.94, 0.83);
  vec3 a = mix(amber, cream, smoothstep(0.1, 0.9, bands));
  a = mix(a, pale, smoothstep(0.15, 0.85, fine * 0.5 + 0.5) * 0.4);
  a = mix(a, vec3(0.42, 0.20, 0.11), smoothstep(0.25, 0.0, r) * 0.55 * (0.5 + 0.5 * fine));
  a = mix(a * 0.78, a * 1.12, smoothstep(0.35, 0.65, bands));
  s.albedo = a;
  s.height = bands * 0.006 + fine * 0.0015;
  s.bump = 0.22;

#elif PTYPE == 3
  // e: 'eyeball' ocean world. Water under the star, ice on the night side.
  float sunAng = p.x;
  float cont = fbm(p * 2.1 + vec3(2.0, 7.0, 3.0), 5.0);
  float bias = mix(-0.32, 0.26, smoothstep(0.75, -0.55, sunAng));
  float land = smoothstep(0.02, 0.10, cont + bias);
  float depth = smoothstep(0.05, -0.55, cont + bias);
  float iceLine = sunAng + 0.20 * fbm(p * 3.0, 3.0);
  float ice = smoothstep(-0.05, -0.38, iceLine);
  ice = max(ice, smoothstep(0.80, 0.96, abs(p.y)) * 0.75 * step(sunAng, 0.55));
  vec3 shallow = vec3(0.040, 0.215, 0.400);
  vec3 deep = vec3(0.004, 0.030, 0.150);
  vec3 water = mix(shallow, deep, depth);
  float lf = fbm(p * 8.0, 4.0) * 0.5 + 0.5;
  vec3 earth = mix(vec3(0.215, 0.160, 0.090), vec3(0.100, 0.140, 0.070), lf);
  earth = mix(earth, vec3(0.42, 0.40, 0.38), smoothstep(0.55, 0.95, cont + bias + lf * 0.2) * 0.6);
  vec3 a = mix(water, earth, land);
  vec3 iceCol = mix(vec3(0.42, 0.56, 0.68), vec3(0.72, 0.82, 0.90), lf);
  a = mix(a, iceCol, ice);
  s.albedo = a;
  s.height = land * (cont + bias) * 0.06 + ice * 0.008 * lf;
  s.spec = (1.0 - land) * (1.0 - ice) * 0.55 + ice * 0.1;
  s.gloss = 320.0;
  s.bump = 0.7;

#elif PTYPE == 4
  // f: frozen ocean, fractured blue ice
  float base = fbm(p * 2.8 + 1.0, 5.0) * 0.5 + 0.5;
  float warp = snoise(p * 2.0 + 3.0) * 0.35;
  float crack = lineMask(snoise(p * 6.5 + warp), 0.05);
  float crack2 = lineMask(snoise(p * 11.0 + warp * 2.0 + 7.0), 0.05);
  float icePatch = smoothstep(0.58, 0.82, fbm(p * 3.6 + 9.0, 3.0) * 0.5 + 0.5);
  vec3 iceA = vec3(0.20, 0.38, 0.58);
  vec3 iceB = vec3(0.46, 0.66, 0.86);
  vec3 a = mix(iceA, iceB, base);
  a = mix(a, vec3(0.04, 0.18, 0.40), icePatch * 0.6);
  a = mix(a, vec3(0.03, 0.14, 0.28), max(crack, crack2 * 0.6) * 0.55);
  s.albedo = a;
  s.height = -crack * 0.05 - crack2 * 0.02 + base * 0.012;
  s.spec = 0.55;
  s.gloss = 90.0;
  s.bump = 0.9;

#elif PTYPE == 5
  // g: snowball, pale lilac ice crossed by long dark fractures
  float base = fbm(p * 1.8 + 4.0, 4.0) * 0.5 + 0.5;
  float lin = lineMask(snoise(p * 3.0 + 0.6 * snoise(p * 1.4)), 0.035);
  float lin2 = lineMask(snoise(p * 5.6 + 0.8 * snoise(p * 2.7 + 1.0)), 0.055);
  float blue = smoothstep(0.55, 0.85, fbm(p * 2.6 + 12.0, 3.0) * 0.5 + 0.5);
  float fine = fbm(p * 24.0, max(oct - 2.0, 2.0));
  vec3 a = mix(vec3(0.42, 0.38, 0.62), vec3(0.70, 0.66, 0.88), base);
  a = mix(a, vec3(0.34, 0.50, 0.82), blue * 0.4);
  a = mix(a, vec3(0.30, 0.20, 0.36), clamp(lin + lin2 * 0.6, 0.0, 1.0) * 0.72);
  s.albedo = a * (0.94 + 0.08 * fine);
  s.height = -lin * 0.04 - lin2 * 0.015 + fine * 0.004;
  s.spec = 0.35;
  s.gloss = 70.0;
  s.bump = 0.8;

#else
  // h: coldest world, tholin-stained ice with bright fresh craters
  float mott = fbm(p * 3.0 + 6.0, 4.0) * 0.5 + 0.5;
  float rimA, rimB;
  float ch = craterLayer(p, 4.5, 11.0, rimA);
  float ch2 = craterLayer(p, 11.0, 13.0, rimB);
  float fine = fbm(p * 34.0, max(oct - 2.0, 2.0));
  s.height = ch * 0.9 + ch2 * 0.6 + mott * 0.03 + fine * 0.005;
  vec3 a = mix(vec3(0.060, 0.034, 0.045), vec3(0.230, 0.125, 0.130), smoothstep(0.15, 0.95, mott));
  a = mix(a, vec3(0.42, 0.28, 0.32), smoothstep(0.62, 0.95, fine * 0.5 + 0.5) * 0.35);
  a = mix(a, vec3(0.60, 0.56, 0.66), clamp(rimA * 1.0 + rimB * 0.7, 0.0, 1.0) * 0.55);
  s.albedo = a;
  s.bump = 1.0;
  s.spec = 0.08;
#endif

  return s;
}

void main(){
  vec3 N = normalize(vPos);
  Surf s = surface(N);
  vec3 Nb = perturbNormal(N, vPos, s.height, s.bump);
  vec3 L = SUN_DIR;
  vec3 V = normalize(vView);

  float geo = dot(N, L);
  float day = smoothstep(-0.07, 0.14, geo);
  float diff = max(dot(Nb, L), 0.0) * day;
  diff = mix(diff, pow(diff, 0.9), 0.5);

  vec3 col = s.albedo * uSunColor * diff;

  vec3 H = normalize(L + V);
  float sp = pow(max(dot(Nb, H), 0.0), s.gloss) * s.spec * day;
  col += uSunColor * sp * (1.0 + s.gloss / 60.0);

  // faint fill on the dark side: scattered starlight, neighbouring worlds
  float rimK = 1.0 - clamp(dot(N, V), 0.0, 1.0);
  col += s.albedo * uAmbient * (0.25 + 0.75 * (1.0 - day)) * (0.30 + 0.95 * pow(rimK, 1.6));
  col += s.emit * day;

  gl_FragColor = vec4(col, 1.0);
}
`;

/** One shader variant per world: PTYPE is the planet's index (b = 0 ... h = 6). */
export function createPlanetMaterial(index, shared) {
  return new THREE.ShaderMaterial({
    defines: { PTYPE: index },
    uniforms: {
      uCamObj: { value: new THREE.Vector3() },
      uTime: shared.uTime,
      uOct: shared.uOct,
      uSunColor: shared.uSunColor,
      uAmbient: { value: new THREE.Color(0.55, 0.62, 1.0).multiplyScalar(0.085) },
    },
    vertexShader: OBJ_VERT,
    fragmentShader: PLANET_FRAG,
  });
}

// ---------------------------------------------------------------------------
// Clouds: a thin shell just above the surface (worlds e and f)
// ---------------------------------------------------------------------------

const CLOUD_FRAG = /* glsl */ `
varying vec3 vPos;
varying vec3 vView;
uniform float uTime;
uniform float uOct;
uniform float uCover;
uniform float uSubstellar;
uniform vec3 uSunColor;
${SUN_DIR}
${NOISE}

vec2 cloudWarp(vec3 p){
  vec3 q = p * 1.7;
  return vec2(fbm(q * 0.7 + vec3(4.0, uTime * 0.004, 1.0), 3.0), fbm(q * 0.7 + vec3(uTime * 0.004), 3.0));
}

float density(vec3 p, vec2 wp, float oct){
  vec3 q = p * 1.7;
  q += vec3(wp.x * 1.25, wp.y * 1.35, wp.y * 0.9);
  float n = fbm(q + vec3(uTime * 0.008, 0.0, 0.0), oct) * 0.5 + 0.5;
  float cov = mix(uCover * 0.35, uCover, smoothstep(-0.35, 0.95, mix(1.0, p.x, uSubstellar)));
  float t = mix(0.70, 0.36, cov);
  return smoothstep(t, t + 0.30, n);
}

void main(){
  vec3 N = normalize(vPos);
  vec3 L = SUN_DIR;
  vec2 wp = cloudWarp(N);
  float d = density(N, wp, uOct);
  if (d < 0.004) discard;                       // most of the shell is empty: skip the shading sample
  vec3 Lt = normalize(L - N * dot(L, N) + 1e-4);
  float d2 = density(normalize(N + Lt * 0.02), wp, min(uOct, 4.0));
  float shade = clamp(1.0 - (d2 - d) * 1.4, 0.4, 1.0);
  float ndl = dot(N, L);
  float lit = smoothstep(-0.08, 0.30, ndl);
  vec3 col = vec3(0.97, 0.94, 0.92) * uSunColor * lit * shade;
  col += vec3(0.05, 0.04, 0.07) * 0.5 * (1.0 - lit);
  gl_FragColor = vec4(col, d * 0.9);
}
`;

export function createCloudMaterial(shared, { cover = 0.6, substellar = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCamObj: { value: new THREE.Vector3() },
      uTime: shared.uTime,
      uOct: shared.uOct,
      uSunColor: shared.uSunColor,
      uCover: { value: cover },
      uSubstellar: { value: substellar },
    },
    vertexShader: OBJ_VERT,
    fragmentShader: CLOUD_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Atmosphere: single-scattering ray march through an exponential shell.
// ---------------------------------------------------------------------------

const ATMO_VERT = /* glsl */ `
varying vec3 vObj;
void main(){
  vObj = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ATMO_FRAG = /* glsl */ `
varying vec3 vObj;
uniform vec3 uCamObj;
uniform float uRa;        // shell radius, planet radius = 1
uniform float uHs;        // scale height
uniform vec3 uBetaR;      // Rayleigh-like coefficient (per unit optical depth)
uniform float uBetaM;     // Mie-like coefficient
uniform float uG;         // Mie asymmetry
uniform vec3 uSunColor;
uniform float uGain;
uniform float uVeil;
uniform float uPulse;
uniform vec3 uPulseColor;
${SUN_DIR}
${RAY_SPHERE}

float phaseR(float mu){ return 0.0596831 * (1.0 + mu * mu); }
float phaseM(float mu, float g){
  float g2 = g * g;
  return 0.0795775 * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5);
}

void main(){
  vec3 ro = uCamObj;
  vec3 rd = normalize(vObj - uCamObj);
  vec2 ta = raySphere(ro, rd, uRa);
  if (ta.y < 0.0) discard;
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  vec2 tp = raySphere(ro, rd, 1.0);
  bool hitsPlanet = tp.x > 0.0;
  if (hitsPlanet) t1 = min(t1, tp.x);
  if (t1 <= t0) discard;

  vec3 L = SUN_DIR;
  float mu = dot(rd, L);
  const int N = 12;
  float dt = (t1 - t0) / float(N);
  float odView = 0.0;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    float h = max(length(p) - 1.0, 0.0);
    float rho = exp(-h / uHs);
    odView += rho * dt;
    // planetary shadow with a soft penumbra
    float b = dot(p, L);
    float disc = b * b - (dot(p, p) - 1.0);
    float shadow = 1.0;
    if (b < 0.0) shadow = 1.0 - smoothstep(-0.02, 0.05, disc);
    if (shadow < 0.002) continue;
    vec2 tl = raySphere(p, L, uRa);
    float lenL = max(tl.y, 0.0);
    float odL = 0.0;
    for (int j = 0; j < 3; j++) {
      vec3 pl = p + L * (lenL * (float(j) + 0.5) / 3.0);
      odL += exp(-max(length(pl) - 1.0, 0.0) / uHs) * lenL / 3.0;
    }
    vec3 tau = (uBetaR + vec3(uBetaM * 1.1)) * (odView + odL);
    vec3 att = exp(-tau) * shadow;
    sum += rho * dt * att;
  }
  vec3 scatter = uSunColor * sum * (uBetaR * phaseR(mu) + uBetaM * phaseM(mu, uG));
  scatter *= uGain;
  float a = (1.0 - exp(-odView * (uBetaR.g + uBetaM) * 0.6)) * uVeil;
  // ring flash when this world 'transits' (sonification ping)
  float impact = length(cross(ro, rd));
  float ring = exp(-pow((impact - 1.0) / (0.4 * (uRa - 1.0)), 2.0));
  scatter += uPulseColor * uPulse * ring;
  gl_FragColor = vec4(scatter, a);
}
`;

export function createAtmosphereMaterial(shared, cfg) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCamObj: { value: new THREE.Vector3() },
      uRa: { value: 1 + cfg.thick },
      uHs: { value: cfg.hs },
      uBetaR: { value: new THREE.Vector3(...cfg.betaR) },
      uBetaM: { value: cfg.betaM },
      uG: { value: cfg.g },
      uSunColor: shared.uAtmoSun,
      uGain: { value: cfg.gain },
      uVeil: { value: cfg.veil ?? 0.6 },
      uPulse: { value: 0 },
      uPulseColor: { value: new THREE.Color(cfg.pulse ?? '#ffffff') },
    },
    vertexShader: ATMO_VERT,
    fragmentShader: ATMO_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

// Artistic atmosphere parameters. b and c: no atmosphere (JWST). h: none.
// thick / hs are relative to planet radius and exaggerated for visibility.
export const ATMOSPHERES = {
  d: { thick: 0.085, hs: 0.030, betaR: [5.2, 8.0, 12.5], betaM: 4.0, g: 0.78, gain: 1.6, veil: 0.7, pulse: '#efcf9a' },
  e: { thick: 0.085, hs: 0.028, betaR: [3.4, 8.2, 20.0], betaM: 1.4, g: 0.78, gain: 2.6, veil: 0.55, pulse: '#56b8d6' },
  f: { thick: 0.045, hs: 0.018, betaR: [3.0, 7.0, 14.0], betaM: 0.9, g: 0.72, gain: 1.7, veil: 0.4, pulse: '#a6def0' },
  g: { thick: 0.030, hs: 0.014, betaR: [4.0, 6.2, 10.0], betaM: 0.7, g: 0.7, gain: 1.4, veil: 0.3, pulse: '#c0aef5' },
};

export const CLOUDS = {
  e: { cover: 0.62, substellar: 1.0, height: 1.010 },
  f: { cover: 0.26, substellar: 0.2, height: 1.008 },
};
