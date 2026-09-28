import * as THREE from 'three';

// Hairline orbit rings with a comet-tail: bright just behind the planet, fading round the loop.

const VERT = /* glsl */ `
attribute float aAng;
varying float vAng;
void main(){
  vAng = aAng;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const FRAG = /* glsl */ `
varying float vAng;
uniform float uPhase;
uniform vec3 uColor;
uniform float uBase;
uniform float uTail;
uniform float uOpacity;
void main(){
  const float TAU = 6.28318530718;
  float d = mod(uPhase - vAng, TAU);          // radians behind the planet
  float tail = exp(-d * uTail);
  float a = (uBase + (1.0 - uBase) * tail) * uOpacity;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

export function createOrbit(radius, color, segments = 512) {
  const pos = new Float32Array(segments * 3);
  const ang = new Float32Array(segments);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * radius;
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = Math.sin(a) * radius;
    ang[i] = a;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uPhase: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uBase: { value: 0.16 },
      uTail: { value: 0.9 },
      uOpacity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.LineLoop(g, m);
  line.frustumCulled = false;
  line.renderOrder = 2;
  return line;
}

// The line of sight to Earth. Every planet here transits: it crosses this ray once per orbit.
const EL_FRAG = /* glsl */ `
varying float vAng;
uniform float uOpacity;
void main(){
  float t = vAng;                       // 0 at the star, 1 at the far end
  float dash = step(0.5, fract(t * 90.0));
  float a = mix(0.55, 0.06, t) * uOpacity * (0.35 + 0.65 * dash);
  gl_FragColor = vec4(vec3(1.0, 0.86, 0.72) * a, 1.0);
}
`;

export function createEarthLine(length) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, length, 0, 0], 3));
  g.setAttribute('aAng', new THREE.Float32BufferAttribute([0, 1], 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 1 } },
    vertexShader: VERT,
    fragmentShader: EL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(g, m);
  line.frustumCulled = false;
  line.renderOrder = 2;
  return line;
}
