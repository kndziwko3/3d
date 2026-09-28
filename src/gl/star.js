import * as THREE from 'three';
import { NOISE, OBJ_VERT } from './glsl.js';

// TRAPPIST-1: an M8 dwarf, fully convective, deep orange-red. The surface is a
// convection-cell mosaic with strong limb darkening and a few cool starspots.

const STAR_FRAG = /* glsl */ `
varying vec3 vPos;
varying vec3 vView;
uniform float uTime;
uniform float uIntensity;
uniform float uOct;
uniform float uFlare;
uniform vec3 uFlareDir;
${NOISE}
void main(){
  vec3 N = normalize(vPos);
  vec3 V = normalize(vView);
  float mu = clamp(dot(N, V), 0.0, 1.0);
  float t = uTime * 0.02;

  vec3 q = N * 6.5 + vec3(0.0, 0.0, t);
  float warp = snoise(q * 0.5 + 4.0) * 0.7;
  float g1 = snoise(q + warp);
  float cells = smoothstep(0.04, 0.62, abs(g1));   // bright cell interiors, dark lanes between
  float g2 = snoise(q * 2.4 + vec3(t * 2.0, 0.0, 0.0));
  float g3 = uOct > 4.0 ? snoise(q * 5.0 - vec3(0.0, t * 3.0, 0.0)) : 0.0;
  float gran = 0.50 + 0.50 * cells + 0.10 * g2 + 0.06 * g3;

  float sp = snoise(N * 1.55 + vec3(3.0, 1.0, -2.0) + t * 0.05);
  float spot = smoothstep(0.50, 0.72, sp);
  float lum = gran * (1.0 - 0.62 * spot);

  float limb = 1.0 - 0.80 * (1.0 - mu);
  float b = lum * limb;

  vec3 hot = vec3(1.00, 0.40, 0.10);
  vec3 cool = vec3(0.62, 0.08, 0.02);
  vec3 col = mix(cool, hot, clamp(b * 1.15, 0.0, 1.0)) * b * uIntensity;
  float ang = acos(clamp(dot(N, uFlareDir), -1.0, 1.0));
  float flareSpot = uFlare * exp(-pow(ang / 0.24, 2.0));
  col += vec3(1.0, 0.70, 0.40) * flareSpot * 3.2 * (0.55 + 0.45 * mu);
  gl_FragColor = vec4(col, 1.0);
}
`;

const CORONA_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CORONA_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uSize;      // half-size of the quad in star radii
uniform float uIntensity;
${NOISE}
void main(){
  vec2 p = vUv * uSize;
  float x = length(p);
  if (x < 0.98) discard;
  float core = exp(-(x - 1.0) * 3.4);
  float halo = 0.10 / (x * x * 0.35 + 0.45);
  float fall = smoothstep(uSize, uSize * 0.35, x);
  float base = (core * 0.9 + halo) * fall;
  if (base < 0.0015) discard;                     // the quad is large: its far corners add nothing
  vec2 dir = p / x;
  float streak = snoise(vec3(dir * 1.6, uTime * 0.04 + x * 0.12));
  float streak2 = snoise(vec3(dir * 4.0, uTime * 0.06 - x * 0.25));
  float rays = 0.72 + 0.28 * streak + 0.12 * streak2;
  vec3 col = mix(vec3(0.95, 0.16, 0.035), vec3(1.0, 0.40, 0.12), core) * base * rays * uIntensity;
  gl_FragColor = vec4(col, 1.0);
}
`;

const ARC_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const ARC_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uIntensity;
uniform float uTime;
void main(){
  float flick = 0.82 + 0.18 * sin(vUv.x * 40.0 + uTime * 6.0);
  vec3 col = mix(vec3(1.0, 0.24, 0.04), vec3(1.0, 0.52, 0.20), 0.5 + 0.5 * sin(vUv.y * 6.2831));
  gl_FragColor = vec4(col * uIntensity * flick, 1.0);
}
`;

const CORONA_BASE = 0.85;
const FLARE_SECONDS = 8;

const flareEnvelope = (t) => (t > FLARE_SECONDS ? 0 : t < 0.5 ? t / 0.5 : Math.exp(-(t - 0.5) / 2.4));

export function createStar(shared) {
  const group = new THREE.Group();

  const sphere = new THREE.SphereGeometry(1, 128, 96);
  sphere.deleteAttribute('normal');
  sphere.deleteAttribute('uv');
  const body = new THREE.Mesh(
    sphere,
    new THREE.ShaderMaterial({
      uniforms: {
        uCamObj: { value: new THREE.Vector3() },
        uTime: shared.uTime,
        uOct: shared.uOct,
        uIntensity: { value: 1.8 },
        uFlare: { value: 0 },
        uFlareDir: { value: new THREE.Vector3(0, 0, 1) },
      },
      vertexShader: OBJ_VERT,
      fragmentShader: STAR_FRAG,
    }),
  );
  group.add(body);

  const coronaMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uSize: { value: 12 }, uIntensity: { value: CORONA_BASE } },
    vertexShader: CORONA_VERT,
    fragmentShader: CORONA_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), coronaMat);
  corona.frustumCulled = false; // billboarded and enormous: cheaper to always draw
  corona.renderOrder = 1;
  group.add(corona);

  // Post-flare loops: two nested half-tori standing on the limb, billboarded to the camera.
  const arcMat = new THREE.ShaderMaterial({
    uniforms: { uIntensity: { value: 0 }, uTime: shared.uTime },
    vertexShader: ARC_VERT,
    fragmentShader: ARC_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const arcGeo = new THREE.TorusGeometry(1, 0.05, 10, 72, Math.PI);
  const arcs = [new THREE.Mesh(arcGeo, arcMat), new THREE.Mesh(arcGeo, arcMat)];
  for (const a of arcs) {
    a.frustumCulled = false;
    a.visible = false;
    a.renderOrder = 2;
    a.matrixAutoUpdate = false;
    group.add(a);
  }

  const flare = { t: Infinity, phi: 0 };
  const uFlareDir = body.material.uniforms.uFlareDir.value;
  const right = new THREE.Vector3();
  const upV = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const foot = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const by = new THREE.Vector3();
  const bz = new THREE.Vector3();
  const m = new THREE.Matrix4();

  const hideArcs = () => {
    for (const a of arcs) a.visible = false;
  };

  return {
    group,
    setRadius(r) {
      body.scale.setScalar(r);
      corona.scale.setScalar(r * coronaMat.uniforms.uSize.value);
    },
    /** Camera position in the star's frame (the star sits at the origin, unrotated). */
    setCamera(camera) {
      body.material.uniforms.uCamObj.value.copy(camera.position).divideScalar(body.scale.x);
      corona.quaternion.copy(camera.quaternion); // billboard
    },
    /** Start a flare on a random point of the limb as the camera sees it. */
    triggerFlare(camera) {
      flare.t = 0;
      flare.phi = Math.random() * Math.PI * 2;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      upV.setFromMatrixColumn(camera.matrixWorld, 1);
      uFlareDir.copy(right).multiplyScalar(Math.cos(flare.phi)).addScaledVector(upV, Math.sin(flare.phi)).normalize();
    },
    updateFlare(dt, camera) {
      if (flare.t > FLARE_SECONDS) {
        if (body.material.uniforms.uFlare.value !== 0) {
          body.material.uniforms.uFlare.value = 0;
          coronaMat.uniforms.uIntensity.value = CORONA_BASE;
          hideArcs();
        }
        return;
      }
      flare.t += dt;
      const env = flareEnvelope(flare.t);
      body.material.uniforms.uFlare.value = env;
      coronaMat.uniforms.uIntensity.value = CORONA_BASE * (1 + env * 0.7);
      arcMat.uniforms.uIntensity.value = env * 0.85;
      if (env <= 0.02) return hideArcs();

      const Rs = body.scale.x;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      upV.setFromMatrixColumn(camera.matrixWorld, 1);
      toCam.setFromMatrixColumn(camera.matrixWorld, 2); // z axis: towards the camera
      outward.copy(right).multiplyScalar(Math.cos(flare.phi)).addScaledVector(upV, Math.sin(flare.phi)).normalize();
      tangent.copy(outward).cross(toCam).normalize().negate();
      // the silhouette as the camera sees it: a circle slightly nearer than the star's centre
      const ratio = Rs / Math.max(camera.position.length(), Rs * 1.001);
      const silhouette = Rs * Math.sqrt(Math.max(1 - ratio * ratio, 0));
      foot.copy(camera.position).normalize().multiplyScalar(Rs * ratio).addScaledVector(outward, silhouette);
      const grow = 1 - Math.pow(1 - Math.min(1, flare.t / 1.6), 2);
      for (let k = 0; k < arcs.length; k++) {
        const rad = Rs * (0.26 - k * 0.09) * (0.25 + 0.75 * grow);
        const ht = rad * (1.5 - k * 0.2);
        m.makeBasis(bx.copy(tangent).multiplyScalar(rad), by.copy(outward).multiplyScalar(ht), bz.copy(toCam).multiplyScalar(rad));
        m.setPosition(foot.x - outward.x * rad * 0.12, foot.y - outward.y * rad * 0.12, foot.z - outward.z * rad * 0.12);
        arcs[k].matrix.copy(m);
        arcs[k].visible = true;
      }
    },
  };
}
