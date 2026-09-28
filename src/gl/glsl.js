// Shared GLSL chunks. three.js prepends the version line, precision and the
// varying/gl_FragColor compatibility defines, so these are written in the
// familiar GLSL 1.00 dialect that compiles unchanged as GLSL ES 3.00.

export const HASH = /* glsl */ `
vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

export const NOISE = /* glsl */ `
${HASH}
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

// Simplex noise, 3D (Ashima Arts / Ian McEwan, MIT). Output roughly in [-1, 1].
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// Fractal sum, octave count is a runtime uniform so quality tiers share one program.
// Octaves fade out as their feature size approaches the pixel footprint, which removes
// the shimmer and blocky derivative-bump artefacts on distant planets.
float fbm(vec3 p, float octaves){
  float fw = length(fwidth(p));
  float a = 0.5, s = 0.0, f = 1.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    float w = 1.0 - smoothstep(0.16, 0.55, fw * f);
    if (w <= 0.0) break;                       // this and every finer octave is below a pixel
    s += a * w * snoise(p);
    p = p * 2.03 + vec3(11.7, 3.1, 7.3);
    f *= 2.03;
    a *= 0.5;
  }
  return s / (1.0 - exp2(-octaves));           // sum of the full series 0.5 + 0.25 + ...
}

// Same fractal without the pixel-footprint fade. For coordinates with a branch cut (atan), where
// fwidth() would spike along the seam.
float fbmFlat(vec3 p, float octaves){
  float a = 0.5, s = 0.0, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    s += a * snoise(p);
    norm += a;
    p = p * 2.03 + vec3(11.7, 3.1, 7.3);
    a *= 0.5;
  }
  return s / norm;
}

// Ridged fractal: sharp creases, good for cracks and mountain chains.
float ridged(vec3 p, float octaves){
  float fw = length(fwidth(p));
  float a = 0.5, s = 0.0, norm = 0.0, f = 1.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    float w = 1.0 - smoothstep(0.16, 0.55, fw * f);
    float n = 1.0 - abs(snoise(p));
    s += a * mix(0.55, n * n, w);
    norm += a;
    p = p * 2.07 + vec3(5.3, 9.1, 2.7);
    f *= 2.07;
    a *= 0.5;
  }
  return s / norm;
}

`;

// Cellular crater field on the unit sphere. Returns height (bowl < 0, raised rim > 0)
// and writes an ejecta/rim mask for albedo brightening.
export const CRATERS = /* glsl */ `
float craterLayer(vec3 p, float freq, float seed, out float rim){
  vec3 q = p * freq;
  vec3 ic = floor(q);
  float h = 0.0;
  rim = 0.0;
  float lod = 1.0 - smoothstep(0.035, 0.16, length(fwidth(q)));   // craters smaller than a pixel vanish
  if (lod <= 0.0) return 0.0;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 c = ic + vec3(float(x), float(y), float(z));
    if (hash13(c + seed + 17.3) < 0.42) continue;   // not every cell holds a crater (cheap test first)
    vec3 r = hash33(c + seed);
    vec3 centre = c + 0.2 + 0.6 * r;
    float radius = mix(0.16, 0.5, r.x * r.x);
    float d = length(q - centre) / radius;
    if (d > 2.2) continue;
    float bowl = -(1.0 - smoothstep(0.0, 1.0, d)) * (1.0 - 0.35 * smoothstep(0.0, 0.6, d));
    float wall = exp(-pow((d - 1.0) * 3.4, 2.0));
    float ejecta = smoothstep(2.2, 1.0, d) * (1.0 - smoothstep(0.9, 1.05, d));
    h += bowl * 0.9 * radius + wall * 0.32 * radius;
    rim = max(rim, wall * 0.8 + smoothstep(2.2, 1.0, d) * 0.25 * step(1.0, d));
  }
  rim *= lod;
  return h * lod;
}
`;

// Bump mapping from screen-space derivatives (Mikkelsen 2010). One height sample per pixel.
export const BUMP = /* glsl */ `
vec3 perturbNormal(vec3 n, vec3 pos, float height, float strength){
  vec3 dpdx = dFdx(pos);
  vec3 dpdy = dFdy(pos);
  float dhdx = dFdx(height);
  float dhdy = dFdy(height);
  vec3 r1 = cross(dpdy, n);
  vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - strength * grad);
}
`;

// Anti-aliased thin line from a signed field: 1 on the zero set, fading over ~w.
// Energy fades as the line drops below a pixel, so distant cracks dim instead of sparkling.
export const LINES = /* glsl */ `
float lineMask(float v, float w){
  float aa = fwidth(v) * 1.25;
  return (1.0 - smoothstep(0.0, w + aa, abs(v))) * (w / (w + aa));
}
`;

export const RAY_SPHERE = /* glsl */ `
// Ray/sphere intersection about the origin. Returns (near, far) or (-1, -1).
vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
`;

// Every planet is tidally locked, so in its own frame the star is always on +X.
export const SUN_DIR = /* glsl */ `#define SUN_DIR vec3(1.0, 0.0, 0.0)
`;

// Vertex shader shared by planets, clouds and the star: unit-sphere position plus the camera in the
// object's frame (uCamObj is set from the CPU once per object instead of inverting a matrix per vertex).
export const OBJ_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vView;
uniform vec3 uCamObj;
void main(){
  vPos = position;
  vView = uCamObj - position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
