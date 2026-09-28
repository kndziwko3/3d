import * as THREE from 'three';
import { PLANETS, STAR, orbitAngle } from '../data.js';
import { createPlanetMaterial, createCloudMaterial, createAtmosphereMaterial, ATMOSPHERES, CLOUDS } from './planets.js';
import { createStar } from './star.js';
import { createSky } from './sky.js';
import { createOrbit, createEarthLine } from './orbits.js';

const MARKER_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aRadius;     // visual radius in scene units
attribute float aPulse;
attribute float aFocus;
uniform float uPx;
uniform float uFovScale;     // resolution.y / (2 * tan(fov / 2)), in device px
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
varying float vPulse;
varying float vFocus;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.001);
  float pxR = aRadius / dist * uFovScale;                  // planet radius on screen
  float hide = 1.0 - smoothstep(5.0, 22.0, pxR);           // fade out once the disc is big
  vColor = aColor;
  vPulse = aPulse;
  vFocus = aFocus;
  vAlpha = hide * uOpacity;
  gl_PointSize = (30.0 + 26.0 * aPulse) * uPx;
}
`;
const MARKER_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vPulse;
varying float vFocus;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  if (d > 1.0) discard;
  float dot_ = smoothstep(0.16, 0.0, d) * 1.4;
  float ringR = 0.46 + 0.5 * vPulse;
  float ring = smoothstep(0.045, 0.0, abs(d - ringR)) * (0.55 + 0.45 * vFocus) * (1.0 - vPulse * 0.7);
  float glow = smoothstep(1.0, 0.0, d) * 0.12;
  float a = (dot_ + ring + glow) * vAlpha;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

export class System {
  constructor() {
    this.shared = {
      uTime: { value: 0 },
      uOct: { value: 6 },
      uPx: { value: 1 },
      uSunColor: { value: new THREE.Color(1.0, 0.72, 0.52).multiplyScalar(2.4) },
      uAtmoSun: { value: new THREE.Color(1.0, 0.84, 0.70).multiplyScalar(2.3) },
    };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.exag = { planet: 5, star: 2.5 };
    this.hidden = -1; // planet index hidden in surface-sky mode

    this.sky = createSky(this.shared);
    this.scene.add(this.sky.group);
    this.scene.add(this.sky.dust);

    this.star = createStar(this.shared, STAR.radius * this.exag.star);
    this.scene.add(this.star.group);

    const surfGeo = new THREE.SphereGeometry(1, 128, 96);
    this.planets = PLANETS.map((p) => this._makePlanet(p, surfGeo));

    this._buildMarkers();
    this.earthLine = createEarthLine(1750);
    this.scene.add(this.earthLine);
    // Mercury's orbit (0.387 AU) at the same scale: the whole system fits well inside it.
    this.mercury = createOrbit(9090, '#a9bdd6', 720);
    this.mercury.material.uniforms.uTail.value = 0;
    this.mercury.material.uniforms.uBase.value = 1;
    this.mercury.renderOrder = 1;
    this.scene.add(this.mercury);
    this.mercuryOpacity = 0;
    this.flareTimer = 14;

    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._starUV = new THREE.Vector2(0.5, 0.5);
    this.starVisibility = 0;
    this.minSurfaceDist = 1000;
    this.orbitOpacity = 0.6;
    this.markerOpacity = 1;
    this.focusIndex = -1;
    this.setExaggeration(this.exag.planet, this.exag.star);
  }

  _makePlanet(p, surfGeo) {
    const group = new THREE.Group();
    group.name = `planet-${p.id}`;
    const spin = new THREE.Group();
    group.add(spin);

    const mesh = new THREE.Mesh(surfGeo, createPlanetMaterial(p.id, this.shared));
    mesh.frustumCulled = false;
    spin.add(mesh);

    let cloud = null;
    if (CLOUDS[p.id]) {
      const c = CLOUDS[p.id];
      cloud = new THREE.Mesh(
        new THREE.SphereGeometry(c.height, 96, 64),
        createCloudMaterial(this.shared, { cover: c.cover, substellar: c.substellar }),
      );
      cloud.renderOrder = 3;
      cloud.frustumCulled = false;
      spin.add(cloud);
    }

    let atmo = null;
    if (ATMOSPHERES[p.id]) {
      const cfg = ATMOSPHERES[p.id];
      atmo = new THREE.Mesh(new THREE.SphereGeometry(1 + cfg.thick, 96, 64), createAtmosphereMaterial(this.shared, cfg));
      atmo.renderOrder = 4;
      atmo.frustumCulled = false;
      spin.add(atmo);
    }

    const orbit = createOrbit(p.orbit, p.hue);
    this.scene.add(orbit);
    this.scene.add(group);

    return { data: p, group, spin, mesh, cloud, atmo, orbit, visRadius: p.radius, pulse: 0, angle: 0, pos: new THREE.Vector3() };
  }

  _buildMarkers() {
    const n = this.planets.length;
    const g = new THREE.BufferGeometry();
    this._mPos = new Float32Array(n * 3);
    this._mCol = new Float32Array(n * 3);
    this._mRad = new Float32Array(n);
    this._mPulse = new Float32Array(n);
    this._mFocus = new Float32Array(n);
    const c = new THREE.Color();
    this.planets.forEach((pl, i) => {
      c.set(pl.data.hue);
      this._mCol.set([c.r, c.g, c.b], i * 3);
    });
    g.setAttribute('position', new THREE.BufferAttribute(this._mPos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this._mCol, 3));
    g.setAttribute('aRadius', new THREE.BufferAttribute(this._mRad, 1));
    g.setAttribute('aPulse', new THREE.BufferAttribute(this._mPulse, 1));
    g.setAttribute('aFocus', new THREE.BufferAttribute(this._mFocus, 1));
    this.markerMat = new THREE.ShaderMaterial({
      uniforms: {
        uPx: this.shared.uPx,
        uFovScale: { value: 800 },
        uOpacity: { value: 1 },
      },
      vertexShader: MARKER_VERT,
      fragmentShader: MARKER_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.markers = new THREE.Points(g, this.markerMat);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 10;
    this.scene.add(this.markers);
  }

  setExaggeration(planet, star) {
    this.exag.planet = planet;
    this.exag.star = star;
    this.star.setRadius(STAR.radius * star);
    for (const pl of this.planets) {
      pl.visRadius = pl.data.radius * planet;
      pl.spin.scale.setScalar(pl.visRadius);
    }
  }

  setQuality({ octaves }) {
    this.shared.uOct.value = octaves;
  }

  setPixelScale(px) {
    this.shared.uPx.value = px;
  }

  /** Focus ring emphasis for the marker of planet `i` (or -1). */
  setFocus(i) {
    this.focusIndex = i;
  }

  ping(i, strength = 1) {
    this.planets[i].pulse = Math.max(this.planets[i].pulse, strength);
  }

  setVisible({ orbits, markers, mercury } = {}) {
    if (orbits !== undefined) this.orbitOpacity = orbits;
    if (markers !== undefined) this.markerOpacity = markers;
    if (mercury !== undefined) this.mercuryOpacity = mercury;
  }

  triggerFlare(camera) {
    this.star.triggerFlare(camera);
  }

  planetPosition(i, out = new THREE.Vector3()) {
    return out.copy(this.planets[i].pos);
  }

  /** Advance the simulation. simDays: simulation time in days. */
  update(simDays, seconds, dt, camera, viewportHeight) {
    this.shared.uTime.value = seconds;

    const camPos = camera.position;
    let minDist = Math.max(0, camPos.length() - STAR.radius * this.exag.star);

    for (let i = 0; i < this.planets.length; i++) {
      const pl = this.planets[i];
      const p = pl.data;
      const th = orbitAngle(p, simDays);
      pl.angle = th;
      pl.pos.set(Math.cos(th) * p.orbit, 0, Math.sin(th) * p.orbit);
      pl.group.position.copy(pl.pos);
      // Tidal lock: local +X faces the star
      pl.spin.rotation.y = Math.PI - th;
      pl.group.updateMatrixWorld(true); // parent first: the spin matrix must see this frame's position

      const hidden = this.hidden === i;
      pl.group.visible = !hidden;

      // camera position in the planet's unit frame, for the raymarched atmosphere
      if (pl.atmo) {
        this._v.copy(camPos);
        pl.spin.worldToLocal(this._v);
        pl.atmo.material.uniforms.uCamObj.value.copy(this._v);
        pl.pulse = Math.max(0, pl.pulse - dt * 1.4);
        pl.atmo.material.uniforms.uPulse.value = pl.pulse * 0.9;
      } else {
        pl.pulse = Math.max(0, pl.pulse - dt * 1.4);
      }

      const dSurf = camPos.distanceTo(pl.pos) - pl.visRadius * 1.08;
      if (!hidden) minDist = Math.min(minDist, dSurf);

      pl.orbit.material.uniforms.uPhase.value = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      pl.orbit.material.uniforms.uOpacity.value = this.orbitOpacity;
      pl.orbit.visible = this.orbitOpacity > 0.001;

      this._mPos[i * 3] = pl.pos.x;
      this._mPos[i * 3 + 1] = pl.pos.y;
      this._mPos[i * 3 + 2] = pl.pos.z;
      this._mRad[i] = pl.visRadius;
      this._mPulse[i] = pl.pulse;
      this._mFocus[i] = this.focusIndex === i ? 1 : 0;
      if (hidden) this._mRad[i] = 1e9;
    }
    const ga = this.markers.geometry.attributes;
    ga.position.needsUpdate = true;
    ga.aRadius.needsUpdate = true;
    ga.aPulse.needsUpdate = true;
    ga.aFocus.needsUpdate = true;
    this.markerMat.uniforms.uOpacity.value = this.markerOpacity;
    this.markerMat.uniforms.uFovScale.value = (viewportHeight ?? 800) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.markers.visible = this.markerOpacity > 0.001;
    this.earthLine.material.uniforms.uOpacity.value = this.orbitOpacity * 0.9;
    this.earthLine.visible = this.orbitOpacity > 0.001;

    this.star.face(camera);
    this.flareTimer -= dt;
    if (this.flareTimer <= 0) {
      this.flareTimer = 26 + Math.random() * 30;
      this.star.triggerFlare(camera);
    }
    this.star.updateFlare(dt, camera);
    this.mercury.visible = this.mercuryOpacity > 0.002;
    this.mercury.material.uniforms.uOpacity.value = this.mercuryOpacity * 0.42;
    this.sky.follow(camera, Math.max(120, Math.min(900, minDist * 6 + 60)));
    this.minSurfaceDist = minDist;

    // near/far track the nearest surface so depth precision holds from 3 units to 3000.
    camera.near = THREE.MathUtils.clamp(minDist * 0.07, 0.02, 300);
    camera.far = 60000;
    camera.updateProjectionMatrix();

    this._computeStarScreen(camera);
  }

  /** Projected star position and how unobstructed it is (planets can cover it). */
  _computeStarScreen(camera) {
    const cam = camera.position;
    const v = this._v.set(0, 0, 0).project(camera);
    this._starUV.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    let vis = v.z < 1 && Math.abs(v.x) < 1.6 && Math.abs(v.y) < 1.6 ? 1 : 0;
    // fade near the screen edge so the flare never pops
    const edge = Math.max(Math.abs(v.x), Math.abs(v.y));
    vis *= 1 - THREE.MathUtils.smoothstep(edge, 1.0, 1.6);

    const toStar = this._w.set(0, 0, 0).sub(cam);
    const len = toStar.length();
    if (len > 1e-3) {
      toStar.divideScalar(len);
      for (const pl of this.planets) {
        if (this.hidden === pl.data.index) continue;
        const rel = pl.pos.clone().sub(cam);
        const t = rel.dot(toStar);
        if (t <= 0 || t >= len) continue;
        const perp = rel.addScaledVector(toStar, -t).length();
        const r = pl.visRadius * (pl.atmo ? 1 + ATMOSPHERES[pl.data.id].thick * 0.6 : 1);
        vis *= THREE.MathUtils.smoothstep(perp, r * 0.92, r * 1.25);
      }
    }
    this.starVisibility = vis;
  }

  get starUV() {
    return this._starUV;
  }
}
