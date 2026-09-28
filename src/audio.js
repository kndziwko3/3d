import { PLANETS, CHORD_BASE_HZ, chordHz, orbitAngle } from './data.js';
import { TAU, clamp } from './math.js';

// Generative score. Nothing is sampled: a drone on the seven notes of the resonance chord
// (frequency ∝ 1 / orbital period, 55 … 660 Hz), a pluck every time a world crosses the
// line of sight to Earth (a transit), a bed of filtered noise, and a whoosh that follows
// scroll speed. Reverb is a convolution with an impulse generated at start-up.

const N = PLANETS.length;
const BASE_GAIN = { b: 0.02, c: 0.028, d: 0.042, e: 0.062, f: 0.088, g: 0.096, h: 0.108 };
const STORY_AUDIO_RATE = 0.6; // simulated days per second used for pings while in story mode
const MAX_LIVE_PINGS = 24; // each ping is 3 oscillators; a fast clock must not pile up hundreds
const GAIN_STEP = 0.08; // seconds between drone/whoosh automation updates (the smoothing is 0.5 s anyway)

function makeImpulse(ctx, seconds = 4.6, decay = 3.1) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (0.92 - 0.86 * t); // darker as the tail decays
      d[i] = lp * Math.pow(1 - t, decay) * (i < 400 ? i / 400 : 1);
    }
  }
  return buf;
}

function makeNoise(ctx, seconds = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046; // pink-ish
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
  }
  return buf;
}

// The three partials of a drone voice: type, frequency multiple, gain (bass voices get more octave).
const DRONE_PARTIALS = (f) => [
  [f < 130 ? 'triangle' : 'sine', 1, 1],
  ['sine', 1.0038, 0.6], // slow beating against the fundamental
  ['sine', 2, f < 200 ? 0.35 : 0.12],
];

export class Sound {
  constructor({ clock, onPing }) {
    this.clock = clock;
    this.onPing = onPing;
    this.ctx = null;
    this.enabled = false;
    this.voices = [];
    this.weights = new Float32Array(N);
    this.audioDays = 0;
    this.lastDays = 0;
    this.lastPing = new Float32Array(N).fill(-1);
    this.livePings = [];
    this.sPrev = 0;
    this.whoosh = 0;
    this.time = 0;
    this.gainClock = 0;
  }

  get supported() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  /** Optional stereo placement: returns the node to connect onward. */
  _panned(node, i, width) {
    if (typeof this.ctx.createStereoPanner !== 'function') return node;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = ((i - (N - 1) / 2) / ((N - 1) / 2)) * width;
    node.connect(pan);
    return pan;
  }

  _noiseChain(buffer, filterType, freq, q, offset = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.bus);
    src.start(0, offset);
    return { filter, gain };
  }

  _init() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' }));

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 26;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.012;
    comp.release.value = 0.35;
    this.master.connect(comp).connect(ctx.destination);

    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx);
    const send = ctx.createGain();
    send.gain.value = 0.55;
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.bus.connect(send).connect(reverb).connect(wet).connect(this.master);

    // drone: one voice per planet
    PLANETS.forEach((p, i) => {
      const f = chordHz(p.id);
      const base = BASE_GAIN[p.id];
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(f * 6, 700, 3400);
      lp.Q.value = 0.4;
      const g = ctx.createGain();
      g.gain.value = 0;
      const lfo = ctx.createOscillator(); // slow swell
      lfo.frequency.value = 0.03 + Math.random() * 0.09;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = base * 0.3;
      lfo.connect(lfoGain).connect(g.gain);
      lfo.start();
      for (const [type, mult, amp] of DRONE_PARTIALS(f)) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mult;
        const a = ctx.createGain();
        a.gain.value = amp;
        o.connect(a).connect(lp);
        o.start();
      }
      lp.connect(g);
      this._panned(g, i, 0.55).connect(this.bus);
      this.voices.push({ g, base, target: 0 });
    });

    // noise bed (slowly sweeping band) and the scroll whoosh share one buffer
    const noise = makeNoise(ctx);
    const bed = this._noiseChain(noise, 'bandpass', 320, 0.6);
    bed.gain.gain.value = 0.05;
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.045;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 180;
    sweep.connect(sweepDepth).connect(bed.filter.frequency);
    sweep.start();
    this.whooshChain = this._noiseChain(noise, 'bandpass', 500, 1.1, 1.1);
  }

  async enable() {
    if (!this.supported) return false;
    if (!this.ctx) this._init();
    try {
      await this.ctx.resume();
    } catch {
      // resume can be refused outside a user gesture; the next click retries
    }
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.85, t + 2.2);
    this.enabled = true;
    this.syncUi();
    return true;
  }

  disable() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0, t + 0.5);
    this.enabled = false;
    setTimeout(() => {
      if (!this.enabled) this.ctx.suspend().catch(() => {});
    }, 700);
    this.syncUi();
  }

  async toggle(forceOn = false) {
    if (this.enabled && !forceOn) this.disable();
    else await this.enable();
  }

  visibility(hidden) {
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend().catch(() => {});
    else if (this.enabled) this.ctx.resume().catch(() => {});
  }

  syncUi() {
    document.getElementById('btn-sound')?.setAttribute('aria-pressed', String(this.enabled));
    document.querySelectorAll('[data-act="listen"]').forEach((b) => {
      b.setAttribute('aria-pressed', String(this.enabled));
      b.classList.toggle('is-playing', this.enabled);
    });
  }

  /** A pluck on world i. vel 0..1 */
  ping(i, vel = 1) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.015;
    this.livePings = this.livePings.filter((end) => end > t);
    if (this.livePings.length >= MAX_LIVE_PINGS) return;
    const f = chordHz(PLANETS[i].id);
    const oct = Math.log2(f / CHORD_BASE_HZ);
    const peak = 0.17 * vel * Math.pow(0.86, oct);
    const dur = 3.0 - 0.28 * oct;
    this.livePings.push(t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [type, mult, amp] of [['sine', 1, 1], ['sine', 2, 0.28], ['triangle', 3, 0.06]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const a = ctx.createGain();
      a.gain.value = amp;
      o.connect(a).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    this._panned(g, i, 0.6).connect(this.bus);
  }

  /**
   * Per frame. cue is null in story mode, otherwise { paused, focus } from Explore.
   * story supplies the drone balance and scroll speed while it is in charge.
   */
  update(dt, clock, story, cue) {
    if (!this.enabled) return;
    this.time += dt;
    const now = this.ctx.currentTime;
    const w = this.weights;

    // ---- what the camera is looking at decides the drone balance ----
    if (cue) {
      w.fill(cue.focus >= 0 ? 0.28 : 0.45);
      if (cue.focus >= 0) w[cue.focus] = 1.4;
    } else {
      story.audioMix(w);
    }

    // ---- whoosh follows scroll speed ----
    if (cue) {
      this.whoosh *= 0.9;
    } else {
      const speed = Math.abs(story.s - this.sPrev) / Math.max(dt, 1e-3);
      this.sPrev = story.s;
      this.whoosh += (Math.min(1, speed * 0.9) - this.whoosh) * Math.min(1, dt * 6);
    }

    // automation is smoothed over 0.5 s on the audio thread, so a few updates per second are plenty
    this.gainClock += dt;
    if (this.gainClock >= GAIN_STEP) {
      this.gainClock = 0;
      for (let i = 0; i < N; i++) {
        const v = this.voices[i];
        const target = v.base * w[i];
        if (Math.abs(target - v.target) > v.base * 0.02) {
          v.target = target;
          v.g.gain.setTargetAtTime(target, now, 0.5);
        }
      }
      this.whooshChain.gain.gain.setTargetAtTime(this.whoosh * 0.16, now, 0.08);
      this.whooshChain.filter.frequency.setTargetAtTime(350 + this.whoosh * 1900, now, 0.1);
    }

    // ---- transits: a world crossing the line of sight to Earth (angle 0) ----
    let d0;
    let d1;
    if (cue) {
      d0 = this.lastDays;
      d1 = clock.days;
      this.lastDays = d1;
      if (cue.paused || Math.abs(d1 - d0) > 8) return;
    } else {
      this.lastDays = clock.days;
      d0 = this.audioDays;
      d1 = d0 + STORY_AUDIO_RATE * dt;
      this.audioDays = d1;
    }
    for (let i = 0; i < N; i++) {
      const p = PLANETS[i];
      if (Math.floor(orbitAngle(p, d1) / TAU) <= Math.floor(orbitAngle(p, d0) / TAU) || this.time - this.lastPing[i] <= 0.11) continue;
      this.lastPing[i] = this.time;
      const vel = cue ? (cue.focus === i ? 1 : cue.focus >= 0 ? 0.5 : 0.75) : 0.28 + (w[i] - 0.3) * 0.6;
      const level = clamp(vel, 0.15, 1);
      this.ping(i, level);
      this.onPing?.(i, level);
    }
  }
}
