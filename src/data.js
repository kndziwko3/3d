// Physical data for TRAPPIST-1 from Agol et al. 2021 (PSJ 2, 1). Masses, radii, densities, gravities
// and semi-major axes were checked against the paper's own tables; internal consistency is
// g = M / R^2 (e.g. d: 0.388 / 0.788^2 = 0.625). Flux and Teq follow the NASA Exoplanet Archive listing.
// Scene units: 1 unit = 1 Earth radius (6371 km). Everything is true scale until a camera rig
// asks for exaggeration (see EXAG below).

export const AU_KM = 149597870.7;
export const R_EARTH_KM = 6371.0084;
export const R_SUN_KM = 695700;
export const MOON_ANGULAR_DEG = 0.52; // mean apparent diameter of the Moon from Earth
export const SUN_ANGULAR_DEG = 0.533; // mean apparent diameter of the Sun from Earth

export const STAR = {
  radiusSun: 0.1192,
  teff: 2325,
  distLy: 40.66,
  spectral: 'M8 V',
  hue: '#ff7a45',
};
STAR.radius = (STAR.radiusSun * R_SUN_KM) / R_EARTH_KM; // ≈ 13.02 Earth radii

/** Mercury's orbit around the Sun (0.387 AU) in scene units, for the scale comparison. */
export const MERCURY_ORBIT = (0.3871 * AU_KM) / R_EARTH_KM;

/**
 * How much bigger than life the bodies are drawn. Planets and star are exaggerated so they can be seen;
 * the HUD always states the factor. `scale` is the true-scale view.
 */
export const EXAG = {
  story: { p: 5, s: 2.5 },
  readable: { p: 20, s: 4 },
  scale: { p: 1, s: 1 },
};

// hue = accent used in HUD and chapter styling. phase0 = illustrative start longitude (rad).
const RAW = [
  { id: 'b', mass: 1.374, a: 0.01154, period: 1.510826, radius: 1.116, flux: 4.153, teq: 397.6, g: 1.102, hue: '#e0623a', phase0: -0.62 },
  { id: 'c', mass: 1.308, a: 0.0158, period: 2.421937, radius: 1.097, flux: 2.214, teq: 339.7, g: 1.086, hue: '#dca24a', phase0: 0.62 },
  { id: 'd', mass: 0.388, a: 0.02227, period: 4.049219, radius: 0.788, flux: 1.115, teq: 286.2, g: 0.624, hue: '#efcf9a', phase0: 1.0 },
  { id: 'e', mass: 0.692, a: 0.02925, period: 6.101013, radius: 0.92, flux: 0.646, teq: 249.7, g: 0.817, hue: '#56b8d6', phase0: 0.18 },
  { id: 'f', mass: 1.039, a: 0.03849, period: 9.20754, radius: 1.045, flux: 0.373, teq: 217.7, g: 0.951, hue: '#a6def0', phase0: -0.4 },
  { id: 'g', mass: 1.321, a: 0.04683, period: 12.352446, radius: 1.129, flux: 0.252, teq: 197.3, g: 1.035, hue: '#c0aef5', phase0: 0.78 },
  { id: 'h', mass: 0.326, a: 0.06189, period: 18.772866, radius: 0.755, flux: 0.144, teq: 171.7, g: 0.57, hue: '#c98a80', phase0: -0.7 },
];

/** Period ratios between neighbours, inner to outer: the mean-motion resonance chain. */
export const RESONANCE_CHAIN = ['8:5', '5:3', '3:2', '3:2', '4:3', '3:2'];

const RAD2DEG = 180 / Math.PI;

/** Angular diameter (deg) of a sphere of radius r seen from distance d (exact for any d > r). */
export const sphereAngularDeg = (r, d) => 2 * Math.asin(Math.min(1, r / d)) * RAD2DEG;

/** Angular diameter (deg) of a distant body of radius r at distance d (small-angle tangent form). */
export const angularDiameterDeg = (r, d) => 2 * Math.atan(r / d) * RAD2DEG;

export const PLANETS = RAW.map((p, i) => {
  const orbit = (p.a * AU_KM) / R_EARTH_KM; // scene units
  return {
    ...p,
    index: i,
    orbit,
    orbitKm: p.a * AU_KM,
    escapeKms: Math.sqrt(p.mass / p.radius) * 11.186,
    // the star's disc as seen from the planet, degrees
    starAngularDeg: sphereAngularDeg(STAR.radius, orbit),
  };
});

/**
 * Resonance chord. Orbital frequency ∝ 1/period; the near-exact period ratios
 * (8:5, 5:3, 3:2, 3:2, 4:3, 3:2) make the frequency ratios simple integers:
 * h:g:f:e:d:c:b = 2 : 3 : 4 : 6 : 9 : 15 : 24, i.e. 1 : 3/2 : 2 : 3 : 9/2 : 15/2 : 12.
 * Anchor h on 55 Hz (A1).
 */
export const CHORD_BASE_HZ = 55;
const CHORD_RATIOS = { h: 1, g: 1.5, f: 2, e: 3, d: 4.5, c: 7.5, b: 12 };
export const chordHz = (id) => CHORD_BASE_HZ * CHORD_RATIOS[id];

const TAU = Math.PI * 2;

/** Orbital angle (rad) of planet p at simulation time tDays. */
export const orbitAngle = (p, tDays) => p.phase0 + (TAU * tDays) / p.period;

/** World position of planet p at tDays, written into `out` (anything with .set(x, y, z)). */
export function orbitPosition(p, tDays, out) {
  const th = orbitAngle(p, tDays);
  return out.set(Math.cos(th) * p.orbit, 0, Math.sin(th) * p.orbit);
}
