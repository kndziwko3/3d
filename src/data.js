// Physical data for TRAPPIST-1 from Agol et al. 2021 (PSJ 2, 1). Masses, radii, densities, gravities
// and semi-major axes were checked against the paper's own tables; internal consistency is
// g = M / R^2 (e.g. d: 0.388 / 0.788^2 = 0.625). Flux and Teq follow the NASA Exoplanet Archive listing.
// Scene units: 1 unit = 1 Earth radius (6371 km). Everything is true scale
// until a rig asks for exaggeration (see EXAG in story.js / orrery.js).

export const AU_KM = 149597870.7;
export const R_EARTH_KM = 6371.0084;
export const R_SUN_KM = 695700;
export const R_JUP_KM = 69911;
export const MOON_ANGULAR_DEG = 0.52; // mean apparent diameter of the Moon from Earth

export const STAR = {
  name: 'TRAPPIST-1',
  radiusSun: 0.1192,
  massSun: 0.0898,
  teff: 2325,
  lumSun: 5.66e-4,
  distLy: 40.66,
  ageGyr: 7.6,
  rotDays: 3.3015,
  spectral: 'M8 V',
};
STAR.radius = (STAR.radiusSun * R_SUN_KM) / R_EARTH_KM; // ≈ 13.02 Earth radii
STAR.radiusJup = (STAR.radiusSun * R_SUN_KM) / R_JUP_KM;

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

// Period ratio to the next planet outward, as reported (mean-motion resonance chain).
const RESONANCE = ['8:5', '5:3', '3:2', '3:2', '4:3', '3:2'];

export const PLANETS = RAW.map((p, i) => {
  const orbit = (p.a * AU_KM) / R_EARTH_KM; // scene units
  return {
    ...p,
    index: i,
    orbit,
    orbitKm: p.a * AU_KM,
    density: p.mass / p.radius ** 3, // relative to Earth (5.51 g/cm³)
    escapeKms: Math.sqrt(p.mass / p.radius) * 11.186,
    yearHours: p.period * 24,
    resonanceOut: RESONANCE[i] ?? null,
    // fraction of the star's disc as seen from the planet, degrees
    starAngularDeg: (2 * Math.asin(STAR.radius / orbit) * 180) / Math.PI,
  };
});

export const byId = Object.fromEntries(PLANETS.map((p) => [p.id, p]));

/** Angular diameter (deg) of body of radius r (Earth radii) at distance d. */
export function angularDiameterDeg(r, d) {
  return (2 * Math.atan(r / d) * 180) / Math.PI;
}

/**
 * Closest approach angular size of planet `b` as seen from planet `a`
 * (circular coplanar orbits: separation = |a_b - a_a|).
 */
export function closestApproachDeg(from, to) {
  const d = Math.abs(to.orbit - from.orbit);
  return angularDiameterDeg(to.radius, d);
}

/**
 * Resonance chord. Orbital frequency ∝ 1/period; the near-exact period ratios
 * (8:5, 5:3, 3:2, 3:2, 4:3, 3:2) make the frequency ratios simple integers:
 * h:g:f:e:d:c:b = 2 : 3 : 4 : 6 : 9 : 15 : 24, i.e. 1 : 3/2 : 2 : 3 : 9/2 : 15/2 : 12.
 * Anchor h on 55 Hz (A1). Returns Hz per planet index.
 */
export const CHORD_BASE_HZ = 55;
export const CHORD_RATIOS = { h: 1, g: 1.5, f: 2, e: 3, d: 4.5, c: 7.5, b: 12 };
export const chordHz = (id) => CHORD_BASE_HZ * CHORD_RATIOS[id];

/** Orbital angle (rad) of planet p at simulation time tDays. */
export const orbitAngle = (p, tDays) => p.phase0 + (2 * Math.PI * tDays) / p.period;
