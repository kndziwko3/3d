// Small shared helpers. The rest comes straight from THREE.MathUtils.
import * as THREE from 'three';

export const UP = Object.freeze(new THREE.Vector3(0, 1, 0));
export const D2R = THREE.MathUtils.DEG2RAD;
export const TAU = Math.PI * 2;
export const { clamp, lerp } = THREE.MathUtils;

/** smoothstep with the argument order used in GLSL: smooth(edge0, edge1, x). */
export const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Geometric interpolation, for quantities that scale multiplicatively (exaggeration, distance). */
export const glerp = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));

/** Frame-rate independent exponential approach factor: 1 - e^(-rate·dt). */
export const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
