import { PLANETS, chordHz, orbitAngle } from './data.js';

// Generative score. Nothing is sampled: a drone on the seven notes of the resonance chord
// (frequency ∝ 1 / orbital period, 55 … 660 Hz), a pluck every time a world crosses the
// line of sight to Earth (a transit), a bed of filtered noise, and a whoosh that follows
// scroll speed. Reverb is a convolution with an impulse generated at start-up.

const BASE_GAIN = { b: 0.02, c: 0.028, d: 0.042, e: 0.062, f: 0.088, g: 0.096, h: 0.108 };
const STORY_AUDIO_RATE = 0.6; // simulated days per second used for pings while in story mode
const TAU = Math.PI * 2;

function makeImpulse(ctx, seconds = 4.6, decay = 3.1) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const x = Math.random() * 2 - 1;
      lp += (x - lp) * (0.92 - 0.86 * t); // darker as the tail decays
      d[i] = lp * Math.pow(1 - t, decay) * (i < 400 ? i / 400 : 1);
    }
  }
  return buf;
}

function makeNoise(ctx, seconds = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046; // pink-ish
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
  }
  return buf;
}

export class Sound {
  constructor({ engine, clock, onPing }) {
    this.engine = engine;
    this.clock = clock;
    this.onPing = onPing;
    this.ctx = null;
    this.enabled = false;
    this.voices = [];
    this.audioDays = 0;
    this.prevAngle = PLANETS.map(() => 0);
    this.lastPing = PLANETS.map(() => -1);
    this.sPrev = 0;
    this.whoosh = 0;
    this.time = 0;
    this.focus = null; // set by main each frame: { weights[7], sub }
  }

  get supported() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'playback' }));

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20;
    this.comp.knee.value = 26;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.012;
    this.comp.release.value = 0.35;
    this.master.connect(this.comp).connect(ctx.destination);

    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx);
    this.send = ctx.createGain();
    this.send.gain.value = 0.55;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.9;
    this.send.connect(this.reverb).connect(this.wet).connect(this.master);
    this.bus.connect(this.send);

    // drone: one voice per planet
    const hasPan = typeof ctx.createStereoPanner === 'function';
    PLANETS.forEach((p, i) => {
      const f = chordHz(p.id);
      const base = BASE_GAIN[p.id];
      const o1 = ctx.createOscillator();
      o1.type = f < 130 ? 'triangle' : 'sine';
      o1.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 1.0038;
      const o3 = ctx.createOscillator();
      o3.type = 'sine';
      o3.frequency.value = f * 2;
      const g3 = ctx.createGain();
      g3.gain.value = f < 200 ? 0.35 : 0.12;
      const g2 = ctx.createGain();
      g2.gain.value = 0.6;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(3400, Math.max(700, f * 6));
      lp.Q.value = 0.4;
      const g = ctx.createGain();
      g.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + Math.random() * 0.09;
      const lfoG = ctx.createGain();
      lfoG.gain.value = base * 0.3;
      lfo.connect(lfoG).connect(g.gain);
      o1.connect(lp);
      o2.connect(g2).connect(lp);
      o3.connect(g3).connect(lp);
      lp.connect(g);
      let out = g;
      if (hasPan) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = ((i - 3) / 3) * 0.55;
        g.connect(pan);
        out = pan;
      }
      out.connect(this.bus);
      [o1, o2, o3, lfo].forEach((o) => o.start());
      this.voices.push({ g, base });
    });

    // noise bed + whoosh
    const nb = makeNoise(ctx);
    const src = ctx.createBufferSource();
    src.buffer = nb;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 320;
    bp.Q.value = 0.6;
    const bedG = ctx.createGain();
    bedG.gain.value = 0.05;
    const bedLfo = ctx.createOscillator();
    bedLfo.frequency.value = 0.045;
    const bedLfoG = ctx.createGain();
    bedLfoG.gain.value = 180;
    bedLfo.connect(bedLfoG).connect(bp.frequency);
    src.connect(bp).connect(bedG).connect(this.bus);
    src.start();
    bedLfo.start();

    const src2 = ctx.createBufferSource();
    src2.buffer = nb;
    src2.loop = true;
    this.whooshBp = ctx.createBiquadFilter();
    this.whooshBp.type = 'bandpass';
    this.whooshBp.frequency.value = 500;
    this.whooshBp.Q.value = 1.1;
    this.whooshG = ctx.createGain();
    this.whooshG.gain.value = 0;
    src2.connect(this.whooshBp).connect(this.whooshG).connect(this.bus);
    src2.start(0, 1.1);
  }

  async enable() {
    if (!this.supported) return false;
    if (!this.ctx) this._init();
    try {
      await this.ctx.resume();
    } catch {}
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
      if (!this.enabled && this.ctx) this.ctx.suspend().catch(() => {});
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
    const btn = document.getElementById('btn-sound');
    if (btn) btn.setAttribute('aria-pressed', String(this.enabled));
    document.querySelectorAll('[data-act="listen"]').forEach((b) => {
      b.setAttribute('aria-pressed', String(this.enabled));
      b.classList.toggle('is-playing', this.enabled);
    });
    document.body.classList.toggle('sound-on', this.enabled);
  }

  /** A pluck on world i. vel 0..1 */
  ping(i, vel = 1) {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const p = PLANETS[i];
    const f = chordHz(p.id);
    const t = ctx.currentTime + 0.015;
    const oct = Math.log2(f / 55);
    const peak = 0.17 * vel * Math.pow(0.86, oct);
    const dur = 3.0 - 0.28 * oct;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const mk = (type, mult, amp) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const a = ctx.createGain();
      a.gain.value = amp;
      o.connect(a).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    mk('sine', 1, 1);
    mk('sine', 2, 0.28);
    mk('triangle', 3, 0.06);
    let out = g;
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      pan.pan.value = ((i - 3) / 3) * 0.6;
      g.connect(pan);
      out = pan;
    }
    out.connect(this.bus);
  }

  /**
   * Per frame. exploreState: null in story mode, otherwise { paused, rate, focus }.
   * story: the Story instance (for the scroll coordinate).
   */
  update(dt, clock, story, exploreState) {
    if (!this.enabled || !this.ctx) return;
    this.time += dt;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // ---- drone balance follows what the camera is looking at ----
    const w = new Array(7).fill(0.45);
    let sub = 0;
    if (exploreState) {
      if (exploreState.focus >= 0) w.fill(0.28), (w[exploreState.focus] = 1.4);
    } else if (story) {
      const s = story.s;
      for (let i = 0; i < 7; i++) w[i] = 0.3 + Math.max(0, 1 - Math.abs(s - (i + 2)) * 1.8) * 1.5;
      if (s >= 8.7) w.fill(0.85);
      if (s < 2) sub = 1 - Math.abs(s - 1) * 0.8;
      if (s < 1.2) for (let i = 0; i < 7; i++) w[i] = 0.5 + (i > 4 ? sub * 0.7 : 0);
    }
    for (let i = 0; i < 7; i++) {
      const v = this.voices[i];
      v.g.gain.setTargetAtTime(v.base * w[i], now, 0.5);
    }

    // ---- whoosh: scroll velocity ----
    if (story && !exploreState) {
      const ds = Math.abs(story.s - this.sPrev) / Math.max(dt, 1e-3);
      this.sPrev = story.s;
      const target = Math.min(1, ds * 0.9);
      this.whoosh += (target - this.whoosh) * Math.min(1, dt * 6);
    } else {
      this.whoosh *= 0.9;
    }
    this.whooshG.gain.setTargetAtTime(this.whoosh * 0.16, now, 0.08);
    this.whooshBp.frequency.setTargetAtTime(350 + this.whoosh * 1900, now, 0.1);

    // ---- transits: a world crossing the line of sight to Earth (angle 0) ----
    let d0;
    let d1;
    if (exploreState) {
      d0 = this._lastDays ?? clock.days;
      d1 = clock.days;
      this._lastDays = d1;
      if (exploreState.paused || Math.abs(d1 - d0) > 8) return;
    } else {
      this._lastDays = clock.days;
      d0 = this.audioDays;
      d1 = this.audioDays + STORY_AUDIO_RATE * dt;
      this.audioDays = d1;
    }
    for (let i = 0; i < PLANETS.length; i++) {
      const p = PLANETS[i];
      const n0 = Math.floor(orbitAngle(p, d0) / TAU);
      const n1 = Math.floor(orbitAngle(p, d1) / TAU);
      if (n1 > n0 && this.time - this.lastPing[i] > 0.11) {
        this.lastPing[i] = this.time;
        const vel = exploreState ? (exploreState.focus >= 0 ? (exploreState.focus === i ? 1 : 0.5) : 0.75) : 0.28 + (w[i] - 0.3) * 0.6;
        this.ping(i, Math.min(1, Math.max(0.15, vel)));
        this.onPing?.(i, vel);
      }
    }
  }
}
