// Web Audio plumbing: shared AudioContext, decoding, preview playback.
let ctx;
export function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}
export async function resume() {
  const c = getCtx();
  if (c.state !== 'running') { try { await c.resume(); } catch { /* ignore */ } }
  return c;
}
export function decodeFile(blob) {
  return blob.arrayBuffer().then((ab) => new Promise((res, rej) => {
    const p = getCtx().decodeAudioData(ab, res, rej);
    if (p && p.catch) p.catch(rej);
  }));
}
export function makeBuffer(channels, sr) {
  const b = getCtx().createBuffer(channels.length, channels[0].length, sr);
  channels.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}

/** Plays one AudioBuffer at a time (used for auditioning). */
export class Preview {
  constructor() { this.node = null; this.gain = null; }
  get playing() { return !!this.node; }
  async play(buffer, { loop = false, offset = 0, onended } = {}) {
    this.stop();
    const c = await resume();
    const src = c.createBufferSource();
    src.buffer = buffer; src.loop = loop;
    const g = c.createGain();
    src.connect(g).connect(c.destination);
    const when = c.currentTime + 0.02;
    src.start(when, Math.min(offset, Math.max(0, buffer.duration - 0.001)));
    src.onended = () => { if (this.node === src) { this.node = null; onended && onended(); } };
    Object.assign(this, { node: src, gain: g, t0: when - offset, dur: buffer.duration, loop });
  }
  stop() {
    const n = this.node; if (!n) return;
    this.node = null; n.onended = null;
    const c = getCtx(), now = c.currentTime;
    try { this.gain.gain.setTargetAtTime(0, now, 0.004); n.stop(now + 0.03); } catch { /* ignore */ }
  }
  /** playback position as 0..1 of the buffer, or null when idle */
  fraction() {
    if (!this.node) return null;
    let t = getCtx().currentTime - this.t0;
    if (this.loop) t = ((t % this.dur) + this.dur) % this.dur;
    return Math.min(Math.max(t, 0), this.dur) / this.dur;
  }
}
