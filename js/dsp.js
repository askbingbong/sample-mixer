// Pure audio-processing functions (no DOM / Web Audio) so they can be unit-tested in Node.
// All audio is passed around as arrays of Float32Array (one per channel).

export const DEFAULT_PARAMS = Object.freeze({
  start: 0,            // seconds into the source
  end: null,           // seconds into the source (null = end of file)
  vocalMode: 'off',    // 'off' | 'remove' | 'isolate'
  vocalAmount: 1,      // 0..1
  keepBass: true,      // when removing: leave bass + cymbals alone
  hp: 0,               // high-pass cutoff in Hz (0 = off)
  lp: 0,               // low-pass cutoff in Hz (0 = off)
  eqLow: 0, eqMid: 0, eqHigh: 0, // dB
  pitch: 0,            // semitones (changes speed too, like a record)
  reverse: false,
  gain: 0,             // dB
  normalize: true,
  fadeIn: 0, fadeOut: 0, // seconds
  mono: false,
});

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- Biquad filters (RBJ cookbook) ----------
export function biquad(type, f0, sr, Q = Math.SQRT1_2, gainDb = 0) {
  const w0 = 2 * Math.PI * Math.min(f0, sr * 0.49) / sr;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sin / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
    case 'lowshelf': case 'highshelf': {
      const beta = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
      if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cos + beta); b1 = 2 * A * ((A - 1) - (A + 1) * cos);
        b2 = A * ((A + 1) - (A - 1) * cos - beta);
        a0 = (A + 1) + (A - 1) * cos + beta; a1 = -2 * ((A - 1) + (A + 1) * cos);
        a2 = (A + 1) + (A - 1) * cos - beta;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cos + beta); b1 = -2 * A * ((A - 1) + (A + 1) * cos);
        b2 = A * ((A + 1) + (A - 1) * cos - beta);
        a0 = (A + 1) - (A - 1) * cos + beta; a1 = 2 * ((A - 1) - (A + 1) * cos);
        a2 = (A + 1) - (A - 1) * cos - beta;
      }
      break;
    }
    default: throw new Error('unknown filter ' + type);
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function applyBiquad(data, [b0, b1, b2, a1, a2]) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
}

// 4th-order Butterworth (24 dB/oct) = two cascaded biquads
const butter4 = (type, f, sr) => [biquad(type, f, sr, 0.5412), biquad(type, f, sr, 1.3066)];
function filt(data, coeffs) { for (const c of coeffs) applyBiquad(data, c); }

// ---------- Stages ----------
function vocalStage([L, R], sr, p) {
  const n = L.length, a = clamp(p.vocalAmount, 0, 1);
  const mid = new Float32Array(n);
  for (let i = 0; i < n; i++) mid[i] = (L[i] + R[i]) * 0.5;

  if (p.vocalMode === 'remove') {
    // Voices are usually mixed dead-centre, so they're identical in L and R.
    // Subtracting the centre from each side cancels them out.
    if (p.keepBass) { // only cancel the "voice" range so kick/bass and hi-hats survive
      filt(mid, butter4('highpass', 150, sr));
      filt(mid, butter4('lowpass', 9000, sr));
    }
    const oL = new Float32Array(n), oR = new Float32Array(n);
    for (let i = 0; i < n; i++) { oL[i] = L[i] - a * mid[i]; oR[i] = R[i] - a * mid[i]; }
    // At 100% the two channels are exact opposites of each other in the side
    // signal and would vanish on a mono speaker (phones!), so output mono.
    if (a >= 0.999) return [oL, oL.slice()];
    return [oL, oR];
  }
  // isolate: keep only the centre, restricted to the typical voice range
  filt(mid, butter4('highpass', 120, sr));
  filt(mid, butter4('lowpass', 8000, sr));
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) { oL[i] = (1 - a) * L[i] + a * mid[i]; oR[i] = (1 - a) * R[i] + a * mid[i]; }
  return [oL, oR];
}

// Cubic (Catmull-Rom) resampling. ratio > 1 = faster/higher.
export function resample(x, ratio, sr = 44100) {
  if (Math.abs(ratio - 1) < 1e-6) return x;
  let src = x;
  if (ratio > 1) { // avoid aliasing when speeding up
    src = x.slice();
    filt(src, butter4('lowpass', Math.min(0.45 * sr / ratio, sr * 0.45), sr));
  }
  const len = src.length, n = Math.max(1, Math.floor((len - 1) / ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), t = pos - i0;
    const p0 = src[Math.max(i0 - 1, 0)], p1 = src[i0];
    const p2 = src[Math.min(i0 + 1, len - 1)], p3 = src[Math.min(i0 + 2, len - 1)];
    y[i] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}

const peakOf = (chs) => { let m = 0; for (const c of chs) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > m) m = v; } return m; };
const scaleAll = (chs, g) => { for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g; };

/**
 * Turn the source audio + a set of edit parameters into the final sample.
 * Never mutates `src`.
 */
export function renderSample(src, sr, params) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const total = src[0].length;
  const s0 = clamp(Math.round(p.start * sr), 0, Math.max(0, total - 1));
  const e = p.end == null ? total : Math.round(p.end * sr);
  const s1 = clamp(e, s0 + 1, total);
  let ch = src.slice(0, 2).map((c) => c.slice(s0, s1));

  if (p.vocalMode !== 'off' && ch.length === 2) ch = vocalStage(ch, sr, p);
  if (p.pitch) ch = ch.map((c) => resample(c, Math.pow(2, p.pitch / 12), sr));

  if (p.hp >= 20) ch.forEach((c) => filt(c, butter4('highpass', p.hp, sr)));
  if (p.lp > 0 && p.lp < 19000) ch.forEach((c) => filt(c, butter4('lowpass', p.lp, sr)));
  if (p.eqLow) ch.forEach((c) => applyBiquad(c, biquad('lowshelf', 200, sr, 0.7, p.eqLow)));
  if (p.eqMid) ch.forEach((c) => applyBiquad(c, biquad('peaking', 1000, sr, 0.8, p.eqMid)));
  if (p.eqHigh) ch.forEach((c) => applyBiquad(c, biquad('highshelf', 4000, sr, 0.7, p.eqHigh)));

  if (p.mono && ch.length === 2) {
    const m = new Float32Array(ch[0].length);
    for (let i = 0; i < m.length; i++) m[i] = (ch[0][i] + ch[1][i]) * 0.5;
    ch = [m];
  }
  if (p.reverse) ch.forEach((c) => c.reverse());

  let g = Math.pow(10, p.gain / 20);
  if (p.normalize) { const pk = peakOf(ch); if (pk > 1e-6) g *= 0.891 / pk; }
  if (g !== 1) scaleAll(ch, g);

  // fades (always at least 4 ms so cuts never click)
  const n = ch[0].length;
  const fi = Math.min(n, Math.round(Math.max(p.fadeIn, 0.004) * sr));
  const fo = Math.min(n, Math.round(Math.max(p.fadeOut, 0.004) * sr));
  for (const c of ch) {
    for (let i = 0; i < fi; i++) c[i] *= i / fi;
    for (let i = 0; i < fo; i++) c[n - 1 - i] *= i / fo;
  }
  const pk = peakOf(ch);
  if (pk > 0.999) scaleAll(ch, 0.999 / pk); // safety: never clip
  return { channels: ch, sampleRate: sr };
}

// ---------- Helpers ----------
/** Absolute-peak envelope with `n` buckets (for thumbnails). */
export function computePeaks(channels, n = 300) {
  const len = channels[0].length, out = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    const a = Math.floor((b * len) / n), z = Math.max(a + 1, Math.floor(((b + 1) * len) / n));
    let m = 0;
    for (const c of channels) for (let i = a; i < z; i++) { const v = Math.abs(c[i]); if (v > m) m = v; }
    out[b] = m;
  }
  return out;
}

export function floatToInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) o[i] = Math.round(clamp(f[i], -1, 1) * 32767);
  return o;
}
export function int16ToFloat(s) {
  const o = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s[i] / 32767;
  return o;
}

/** 16-bit PCM WAV file as an ArrayBuffer. */
export function encodeWav(channels, sr) {
  const nCh = channels.length, len = channels[0].length;
  const buf = new ArrayBuffer(44 + len * nCh * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * nCh * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nCh * 2, true); v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, len * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++) {
    v.setInt16(o, Math.round(clamp(channels[c][i], -1, 1) * 32767), true); o += 2;
  }
  return buf;
}
