import * as THREE from 'three';
import { NOISE } from './glsl.js';

// Surface-sky mode. The neighbouring planets and the star are real 3D objects at true
// scale; this pass only paints the ground and the horizon haze over them. It runs in
// screen space, rebuilding each pixel's world ray, so it works at any near/far range.

const VERT = /* glsl */ `
varying vec2 vNdc;
void main(){
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec2 vNdc;
uniform mat4 uInvVP;
uniform vec3 uCam;
uniform vec3 uUp;
uniform vec3 uSun;          // unit vector to the star
uniform vec3 uSunColor;
uniform vec3 uGround;
uniform vec3 uHaze;
uniform float uHazeAmt;
uniform float uSeed;
uniform float uOct;
uniform float uOpacity;
${NOISE}

float ridge(float az, float freq, float seed){
  vec3 q = vec3(cos(az), sin(az), seed) * freq;
  return fbmFlat(q, 4.0) * 0.5 + 0.5;
}

void main(){
  vec4 wp = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - uCam);
  vec3 up = uUp;
  vec3 sunH = uSun - up * dot(uSun, up);
  vec3 e1 = length(sunH) > 1e-3 ? normalize(sunH) : normalize(cross(up, vec3(0.0, 0.0, 1.0)) + 1e-3);
  vec3 e2 = cross(up, e1);
  float sinEl = clamp(dot(dir, up), -1.0, 1.0);
  float elev = asin(sinEl);
  float az = atan(dot(dir, e2), dot(dir, e1));
  float sunElev = asin(clamp(dot(uSun, up), -1.0, 1.0));

  float daylight = smoothstep(-0.12, 0.45, sunElev);
  float facing = 0.5 - 0.5 * cos(az);                       // 1 when looking away from the star
  float lightAmt = 0.10 + 0.90 * facing * (0.25 + 0.75 * daylight) + 0.5 * daylight;

  // three ridge layers, far to near
  float baseH[3];
  float ampH[3];
  float freqs[3];
  baseH[0] = 0.006; ampH[0] = 0.100; freqs[0] = 1.3;
  baseH[1] = 0.000; ampH[1] = 0.060; freqs[1] = 2.4;
  baseH[2] = -0.006; ampH[2] = 0.030; freqs[2] = 4.4;
  float fogs[3];
  fogs[0] = 0.78; fogs[1] = 0.48; fogs[2] = 0.16;

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float rimAcc = 0.0;
  for (int i = 0; i < 3; i++) {
    float hgt = baseH[i] + ampH[i] * ridge(az, freqs[i], uSeed + float(i) * 3.7);
    float edge = elev - hgt;
    float inside = 1.0 - smoothstep(-0.0008, 0.0008, edge);
    if (inside > 0.0) {
      vec3 g = uGround * (0.55 + 0.45 * float(i) * 0.5);
      vec3 lit = g * uSunColor * lightAmt * 0.55;
      vec3 c = mix(lit, uHaze * uSunColor * 0.5 * lightAmt, fogs[i]);
      col = mix(col, c, inside);
      alpha = max(alpha, inside);
    }
    // thin bright rim along the crest when the star sits close behind it
    float rim = exp(-pow(edge / 0.0065, 2.0)) * exp(-az * az / 0.9) * (0.3 + 0.7 * daylight) * step(edge, 0.002);
    rimAcc += rim * (1.0 - fogs[i] * 0.6) * (i == 2 ? 0.35 : 1.0);
  }

  // perspective ground plane below the horizon, texture in metres-ish units
  if (sinEl < -0.004) {
    float t = 1.6 / max(-sinEl, 0.02);
    vec2 pp = vec2(dot(dir, e1), dot(dir, e2)) * t;
    float tex = fbm(vec3(pp * 0.6, 3.0), max(uOct - 2.0, 2.0)) * 0.5 + 0.5;
    float far = smoothstep(-0.02, -0.35, elev);
    vec3 gc = uGround * (0.45 + 0.7 * tex) * uSunColor * lightAmt * 0.5;
    col = mix(col, gc, far);
    alpha = 1.0;
  }

  // sky haze hugging the horizon, strongest towards the star
  float above = smoothstep(-0.01, 0.02, elev);
  float haze = uHazeAmt * exp(-max(elev, 0.0) * 8.5) * (0.35 + 0.65 * pow(max(cos(az), 0.0), 2.0)) * (0.35 + 0.65 * daylight) * above;
  vec3 hazeCol = uHaze * uSunColor * 0.42;
  vec3 outRgb = col * alpha + hazeCol * haze * (1.0 - alpha) + uSunColor * vec3(1.0, 0.62, 0.38) * rimAcc * 0.22;
  gl_FragColor = vec4(outRgb * uOpacity, alpha * uOpacity);
}
`;

// Palette per world (ground colour, haze colour, haze strength). b, c, h are airless.
export const HORIZON_STYLE = {
  b: { ground: [0.10, 0.085, 0.085], haze: [0.5, 0.3, 0.2], amt: 0.04 },
  c: { ground: [0.42, 0.27, 0.12], haze: [0.9, 0.55, 0.28], amt: 0.10 },
  d: { ground: [0.72, 0.55, 0.36], haze: [1.0, 0.68, 0.38], amt: 0.55 },
  e: { ground: [0.30, 0.36, 0.42], haze: [0.35, 0.62, 1.0], amt: 0.42 },
  f: { ground: [0.34, 0.46, 0.60], haze: [0.5, 0.75, 1.0], amt: 0.28 },
  g: { ground: [0.46, 0.42, 0.58], haze: [0.7, 0.62, 1.0], amt: 0.22 },
  h: { ground: [0.20, 0.11, 0.11], haze: [0.6, 0.35, 0.3], amt: 0.05 },
};

export function createHorizon(shared) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uInvVP: { value: new THREE.Matrix4() },
      uCam: { value: new THREE.Vector3() },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: shared.uSunColor,
      uGround: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
      uHaze: { value: new THREE.Vector3(1, 0.6, 0.3) },
      uHazeAmt: { value: 0.3 },
      uSeed: { value: 1 },
      uOct: shared.uOct,
      uOpacity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 60;
  mesh.visible = false;

  const _vp = new THREE.Matrix4();
  return {
    mesh,
    setWorld(id, seed) {
      const st = HORIZON_STYLE[id];
      mat.uniforms.uGround.value.set(...st.ground);
      mat.uniforms.uHaze.value.set(...st.haze);
      mat.uniforms.uHazeAmt.value = st.amt;
      mat.uniforms.uSeed.value = seed;
    },
    update(camera, up, sunDir) {
      camera.updateMatrixWorld(true);
      _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      mat.uniforms.uInvVP.value.copy(_vp).invert();
      mat.uniforms.uCam.value.copy(camera.position);
      mat.uniforms.uUp.value.copy(up);
      mat.uniforms.uSun.value.copy(sunDir);
    },
    setVisible(v) {
      mesh.visible = v;
    },
  };
}
