import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSample, computePeaks, encodeWav, resample, DEFAULT_PARAMS } from '../js/dsp.js';

const SR = 44100;
const sine = (f, n, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));
const rms = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / (to - from)); };
const add = (a, b) => a.map((v, i) => v + b[i]);

test('trim returns the requested slice length', () => {
  const x = sine(440, SR * 2);
  const { channels } = renderSample([x, x], SR, { start: 0.5, end: 1.0, normalize: false });
  assert.equal(channels[0].length, Math.round(0.5 * SR));
});

test('vocal removal cancels centre content and keeps side content', () => {
  const n = SR; // 1s
  const voice = sine(440, n), guitar = sine(2000, n);
  const L = add(voice, guitar), R = voice;
  const out = renderSample([L, R], SR, { vocalMode: 'remove', keepBass: false, normalize: false }).channels[0];
  const mid = [Math.floor(n * 0.2), Math.floor(n * 0.8)];
  // 440 Hz (centre) gone, 2 kHz (left only) remains at ~half amplitude
  const withVoice = rms(L, ...mid), after = rms(out, ...mid);
  assert.ok(after < withVoice * 0.6, `after=${after} before=${withVoice}`);
  // check that the remaining energy is the 2 kHz part: compare to pure guitar/2
  assert.ok(Math.abs(after - rms(guitar, ...mid) / 2) < 0.02);
});

test('keepBass leaves low frequencies alone when removing', () => {
  const bass = sine(60, SR);
  const out = renderSample([bass, bass], SR, { vocalMode: 'remove', keepBass: true, normalize: false }).channels[0];
  assert.ok(rms(out, 8000, 30000) > 0.9 * rms(bass, 8000, 30000));
});

test('isolate keeps centre, drops hard-panned', () => {
  const voice = sine(440, SR), guitar = sine(2000, SR);
  const out = renderSample([add(voice, guitar), voice], SR, { vocalMode: 'isolate', normalize: false }).channels[0];
  const seg = [8000, 30000];
  assert.ok(rms(out, ...seg) > 0.3 * rms(voice, ...seg));
  assert.ok(rms(out, ...seg) < 0.4);
});

test('low-pass removes highs, high-pass removes lows', () => {
  const hi = sine(8000, SR), lo = sine(100, SR);
  const lp = renderSample([hi, hi], SR, { lp: 500, normalize: false }).channels[0];
  assert.ok(rms(lp, 5000, 30000) < 0.01);
  const hp = renderSample([lo, lo], SR, { hp: 2000, normalize: false }).channels[0];
  assert.ok(rms(hp, 5000, 30000) < 0.01);
});

test('pitch +12 semitones halves the length', () => {
  const x = sine(440, SR);
  const out = renderSample([x], SR, { pitch: 12, normalize: false }).channels[0];
  assert.ok(Math.abs(out.length - SR / 2) < 4);
});

test('reverse flips samples; normalize hits target; never clips', () => {
  const x = Float32Array.from({ length: 1000 }, (_, i) => (i / 1000) * 0.1);
  const out = renderSample([x], SR, { reverse: true, normalize: true, fadeIn: 0, fadeOut: 0 }).channels[0];
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak > 0.5 && peak < 1);
  const sn = renderSample([sine(440, SR, 0.1)], SR, { normalize: true }).channels[0];
  assert.ok(Math.abs(Math.max(...sn.map(Math.abs)) - 0.891) < 0.01);
  assert.ok(out[300] > out[700]);
  const loud = renderSample([x.map((v) => v * 100)], SR, { normalize: false, gain: 20 }).channels[0];
  assert.ok(Math.max(...loud.map(Math.abs)) <= 1);
});

test('mono downmix and fades', () => {
  const x = sine(300, SR, 0.5);
  const out = renderSample([x, x], SR, { mono: true, fadeIn: 0.1, fadeOut: 0.1, normalize: false });
  assert.equal(out.channels.length, 1);
  assert.equal(out.channels[0][0], 0);
  assert.ok(Math.abs(out.channels[0][out.channels[0].length - 1]) < 0.01);
});

test('does not mutate the source', () => {
  const x = sine(440, 5000), copy = x.slice();
  renderSample([x, x], SR, { vocalMode: 'remove', hp: 300, reverse: true, pitch: 3 });
  assert.deepEqual(x, copy);
});

test('wav encoding header + peaks', () => {
  const w = new DataView(encodeWav([sine(440, 100), sine(440, 100)], SR));
  assert.equal(String.fromCharCode(w.getUint8(0), w.getUint8(1), w.getUint8(2), w.getUint8(3)), 'RIFF');
  assert.equal(w.getUint16(22, true), 2);
  assert.equal(w.getUint32(24, true), SR);
  assert.equal(w.byteLength, 44 + 100 * 4);
  const p = computePeaks([sine(440, 1000, 0.5)], 10);
  assert.equal(p.length, 10);
  assert.ok(p.every((v) => v > 0.4 && v <= 0.5));
  assert.equal(resample(new Float32Array(10), 1).length, 10);
  assert.ok(DEFAULT_PARAMS.normalize);
});
