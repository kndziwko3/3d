import * as THREE from 'three';
import { PLANETS, STAR, MERCURY_ORBIT, orbitAngle, orbitPosition } from '../data.js';
import { TAU, clamp, smooth } from '../math.js';
import { createPlanetMaterial, createCloudMaterial, createAtmosphereMaterial, ATMOSPHERES, CLOUDS } from './planets.js';
import { createStar } from './star.js';
import { createSky } from './sky.js';
import { createOrbit, createEarthLine } from './orbits.js';
import { createHorizon } from './horizon.js';

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

/** Unit-sphere-ish geometry with only the attribute the shaders read. */
function sphere(radius, w, h) {
  const g = new THREE.SphereGeometry(radius, w, h);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

const LOD_PIXELS = 60; // switch to the coarse mesh below this apparent radius

export class System {
  constructor(renderer) {
    this.shared = {
      uTime: { value: 0 },
      uOct: { value: 6 },
      uPx: { value: 1 },
      uSunColor: { value: new THREE.Color(1.0, 0.72, 0.52).multiplyScalar(2.4) },
      uAtmoSun: { value: new THREE.Color(1.0, 0.84, 0.70).multiplyScalar(2.3) },
    };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.exag = { planet: 1, star: 1 };
    this.hidden = -1; // planet the camera stands on (surface view), hidden from the scene

    this.sky = createSky(this.shared, renderer);
    this.scene.add(this.sky.group);
    this.scene.add(this.sky.dust);

    this.star = createStar(this.shared);
    this.scene.add(this.star.group);

    this.horizon = createHorizon(this.shared);
    this.scene.add(this.horizon.mesh);

    const surfaceGeo = [sphere(1, 128, 96), sphere(1, 48, 32)];
    this.planets = PLANETS.map((p) => this._makePlanet(p, surfaceGeo));

    this._buildMarkers();
    this.earthLine = createEarthLine(1750);
    this.scene.add(this.earthLine);
    // Mercury's orbit at the same scale: the whole system fits well inside it.
    this.mercury = createOrbit(MERCURY_ORBIT, '#a9bdd6', 720);
    this.mercury.material.uniforms.uTail.value = 0;
    this.mercury.material.uniforms.uBase.value = 1;
    this.mercury.renderOrder = 1;
    this.scene.add(this.mercury);

    this.orbitOpacity = 0;
    this.markerOpacity = 0;
    this.mercuryOpacity = 0;
    this.focusIndex = -1;
    this.flareTimer = 14;
    this.starVisibility = 0;
    this._starUV = new THREE.Vector2(0.5, 0.5);
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._rel = new THREE.Vector3();
    this.setExaggeration(5, 2.5);
  }

  _makePlanet(p, surfaceGeo) {
    const group = new THREE.Group();
    group.name = `planet-${p.id}`;
    const spin = new THREE.Group();
    group.add(spin);

    const mesh = new THREE.Mesh(surfaceGeo[0], createPlanetMaterial(p.index, this.shared));
    spin.add(mesh);
    const lods = [{ mesh, geo: surfaceGeo }];

    let cloud = null;
    if (CLOUDS[p.id]) {
      const c = CLOUDS[p.id];
      cloud = new THREE.Mesh(sphere(c.height, 96, 64), createCloudMaterial(this.shared, { cover: c.cover, substellar: c.substellar }));
      cloud.renderOrder = 3;
      spin.add(cloud);
      lods.push({ mesh: cloud, geo: [cloud.geometry, sphere(c.height, 40, 28)] });
    }

    let atmo = null;
    if (ATMOSPHERES[p.id]) {
      const cfg = ATMOSPHERES[p.id];
      atmo = new THREE.Mesh(sphere(1 + cfg.thick, 96, 64), createAtmosphereMaterial(this.shared, cfg));
      atmo.renderOrder = 4;
      spin.add(atmo);
      lods.push({ mesh: atmo, geo: [atmo.geometry, sphere(1 + cfg.thick, 40, 28)] });
    }

    const orbit = createOrbit(p.orbit, p.hue);
    this.scene.add(orbit);
    this.scene.add(group);

    return { data: p, group, spin, cloud, atmo, lods, lod: 0, orbit, visRadius: p.radius, pulse: 0, angle: 0, pos: new THREE.Vector3() };
  }

  _buildMarkers() {
    const n = this.planets.length;
    const g = new THREE.BufferGeometry();
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    this.planets.forEach((pl, i) => {
      c.set(pl.data.hue).toArray(col, i * 3);
    });
    this._mPos = new Float32Array(n * 3);
    this._mRad = new Float32Array(n);
    this._mPulse = new Float32Array(n);
    this._mFocus = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(this._mPos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRadius', new THREE.BufferAttribute(this._mRad, 1));
    g.setAttribute('aPulse', new THREE.BufferAttribute(this._mPulse, 1));
    g.setAttribute('aFocus', new THREE.BufferAttribute(this._mFocus, 1));
    this.markerMat = new THREE.ShaderMaterial({
      uniforms: { uPx: this.shared.uPx, uFovScale: { value: 800 }, uOpacity: { value: 1 } },
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
    if (planet === this.exag.planet && star === this.exag.star) return;
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

  setVisible(orbits, markers, mercury) {
    this.orbitOpacity = orbits;
    this.markerOpacity = markers;
    this.mercuryOpacity = mercury;
  }

  /** Stand on planet i (hide it, show the ground and haze) or, with -1, return to space. */
  setSurfaceWorld(i) {
    if (i === this.hidden) return;
    this.hidden = i;
    if (i >= 0) this.horizon.setWorld(PLANETS[i].id, 3.1 + i * 5.7);
    this.horizon.setVisible(i >= 0);
  }

  triggerFlare(camera) {
    this.star.triggerFlare(camera);
  }

  /**
   * Place every world for simDays. Needs no camera, so a mode can read fresh positions before it moves
   * the camera (following a world with last frame's position makes it drift off-centre at high speed).
   */
  updateBodies(simDays, seconds, dt) {
    this.shared.uTime.value = seconds;
    for (let i = 0; i < this.planets.length; i++) {
      const pl = this.planets[i];
      pl.angle = orbitAngle(pl.data, simDays);
      orbitPosition(pl.data, simDays, pl.pos);
      pl.group.position.copy(pl.pos);
      pl.spin.rotation.y = Math.PI - pl.angle; // tidal lock: local +X faces the star
      pl.group.updateMatrixWorld(true); // parent first: the spin matrix must see this frame's position
      pl.group.visible = this.hidden !== i;
      pl.pulse = Math.max(0, pl.pulse - dt * 1.4);
    }
  }

  /** Everything that depends on where the camera is. Call after updateBodies and after the camera moved. */
  update(dt, camera, viewportHeight) {
    const camPos = camera.position;
    const fovScale = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    let minDist = Math.max(0, camPos.length() - STAR.radius * this.exag.star);
    let posDirty = false;
    let radDirty = false;
    let pulseDirty = false;
    let focusDirty = false;

    for (let i = 0; i < this.planets.length; i++) {
      const pl = this.planets[i];
      const hidden = this.hidden === i;
      const dist = camPos.distanceTo(pl.pos);
      if (!hidden) minDist = Math.min(minDist, dist - pl.visRadius * 1.08);

      // camera in the planet's unit frame: the raymarched atmosphere, clouds and surface shade in it
      this._v.copy(camPos);
      pl.spin.worldToLocal(this._v);
      for (const { mesh } of pl.lods) mesh.material.uniforms.uCamObj.value.copy(this._v);
      if (pl.atmo) pl.atmo.material.uniforms.uPulse.value = pl.pulse * 0.9;

      // coarse meshes for worlds that are only a few dozen pixels wide
      const lod = (pl.visRadius / Math.max(dist, 1e-3)) * fovScale > LOD_PIXELS ? 0 : 1;
      if (lod !== pl.lod) {
        pl.lod = lod;
        for (const l of pl.lods) l.mesh.geometry = l.geo[lod];
      }

      pl.orbit.material.uniforms.uPhase.value = ((pl.angle % TAU) + TAU) % TAU;
      pl.orbit.material.uniforms.uOpacity.value = this.orbitOpacity;
      pl.orbit.visible = this.orbitOpacity > 0.001;

      // marker attributes: upload only what changed
      const o = i * 3;
      if (this._mPos[o] !== pl.pos.x || this._mPos[o + 2] !== pl.pos.z) {
        this._mPos[o] = pl.pos.x;
        this._mPos[o + 2] = pl.pos.z;
        posDirty = true;
      }
      const rad = hidden ? 1e9 : pl.visRadius;
      if (this._mRad[i] !== rad) (this._mRad[i] = rad), (radDirty = true);
      if (this._mPulse[i] !== pl.pulse) (this._mPulse[i] = pl.pulse), (pulseDirty = true);
      const foc = this.focusIndex === i ? 1 : 0;
      if (this._mFocus[i] !== foc) (this._mFocus[i] = foc), (focusDirty = true);
    }
    const ga = this.markers.geometry.attributes;
    if (posDirty) ga.position.needsUpdate = true;
    if (radDirty) ga.aRadius.needsUpdate = true;
    if (pulseDirty) ga.aPulse.needsUpdate = true;
    if (focusDirty) ga.aFocus.needsUpdate = true;
    this.markerMat.uniforms.uOpacity.value = this.markerOpacity;
    this.markerMat.uniforms.uFovScale.value = fovScale;
    this.markers.visible = this.markerOpacity > 0.001;
    this.earthLine.material.uniforms.uOpacity.value = this.orbitOpacity * 0.9;
    this.earthLine.visible = this.orbitOpacity > 0.001;
    this.mercury.visible = this.mercuryOpacity > 0.002;
    this.mercury.material.uniforms.uOpacity.value = this.mercuryOpacity * 0.42;

    this.star.setCamera(camera);
    this.flareTimer -= dt;
    if (this.flareTimer <= 0) {
      this.flareTimer = 26 + Math.random() * 30;
      this.star.triggerFlare(camera);
    }
    this.star.updateFlare(dt, camera);
    this.sky.follow(camera, clamp(minDist * 6 + 60, 120, 900));

    // near/far track the nearest surface so depth precision holds from 3 units to 3000.
    camera.near = clamp(minDist * 0.07, 0.02, 300);
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
    vis *= 1 - smooth(1.0, 1.6, Math.max(Math.abs(v.x), Math.abs(v.y)));

    const toStar = this._w.copy(cam).negate();
    const len = toStar.length();
    if (len > 1e-3) {
      toStar.divideScalar(len);
      for (const pl of this.planets) {
        if (this.hidden === pl.data.index) continue;
        const rel = this._rel.copy(pl.pos).sub(cam);
        const t = rel.dot(toStar);
        if (t <= 0 || t >= len) continue;
        const perp = rel.addScaledVector(toStar, -t).length();
        const r = pl.visRadius * (pl.atmo ? 1 + ATMOSPHERES[pl.data.id].thick * 0.6 : 1);
        vis *= smooth(r * 0.92, r * 1.25, perp);
      }
    }
    this.starVisibility = vis;
  }

  get starUV() {
    return this._starUV;
  }
}
