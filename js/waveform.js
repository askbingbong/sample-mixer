// Interactive waveform: zoom/pan, draggable selection, overview strip, playhead.
import { h, clamp, fmtTime } from './ui.js';

const BLOCK = 128;
const MIN_SPAN = 0.004;
const HIT = 24; // px: touch radius for grabbing a selection handle

export class WaveView {
  /** onSelect(start,end) is called while the user changes the selection */
  constructor({ onSelect, height = 190 } = {}) {
    this.onSelect = onSelect || (() => {});
    this.canvas = h('canvas', { class: 'wave-main', style: { height: height + 'px' } });
    this.over = h('canvas', { class: 'wave-over' });
    this.el = h('div', { class: 'wave' }, this.canvas, this.over);
    this.chans = null; this.sr = 44100; this.dur = 0;
    this.sel = { s: 0, e: 0 };
    this.view = { s: 0, e: 1 };
    this.playhead = null;
    this.mins = null; this.maxs = null;
    this.pointers = new Map();
    this.drag = null;
    new ResizeObserver(() => this.render()).observe(this.el);
    this._bindMain();
    this._bindOver();
  }

  setSource(chans, sr) {
    this.chans = chans; this.sr = sr; this.dur = chans[0].length / sr;
    const n = Math.ceil(chans[0].length / BLOCK);
    this.mins = new Float32Array(n); this.maxs = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1, hi = -1;
      const a = b * BLOCK, z = Math.min(chans[0].length, a + BLOCK);
      for (const c of chans) for (let i = a; i < z; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      this.mins[b] = lo; this.maxs[b] = hi;
    }
    this.view = { s: 0, e: this.dur };
    this.render();
  }
  setSelection(s, e, silent = true) {
    this.sel = { s: clamp(s, 0, this.dur), e: clamp(e, 0, this.dur) };
    if (!silent) this.onSelect(this.sel.s, this.sel.e);
    this.render();
  }
  setPlayhead(t) { this.playhead = t; this.render(); }

  // ---- view helpers ----
  get span() { return this.view.e - this.view.s; }
  _w() { return this.canvas.clientWidth || 300; }
  tToX(t) { return ((t - this.view.s) / this.span) * this._w(); }
  xToT(x) { return this.view.s + (x / this._w()) * this.span; }
  setView(s, e) {
    let span = clamp(e - s, Math.min(MIN_SPAN, this.dur), this.dur);
    s = clamp(s, 0, this.dur - span);
    this.view = { s, e: s + span };
    this.render();
  }
  zoomBy(f, centre = (this.view.s + this.view.e) / 2) {
    const span = this.span * f, k = (centre - this.view.s) / this.span;
    this.setView(centre - k * span, centre - k * span + span);
  }
  zoomToSelection() {
    const pad = Math.max((this.sel.e - this.sel.s) * 0.15, 0.01);
    this.setView(this.sel.s - pad, this.sel.e + pad);
  }
  zoomAll() { this.setView(0, this.dur); }
  /** keep the playhead visible while following playback */
  follow(t) { if (t < this.view.s || t > this.view.e) this.setView(t - this.span * 0.1, t + this.span * 0.9); }

  // ---- interaction ----
  _bindMain() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    const px = (e) => e.clientX - c.getBoundingClientRect().left;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: px(e) });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.drag = { mode: 'pinch', d0: Math.abs(a.x - b.x) || 1, v0: { ...this.view }, mid0: this.xToT((a.x + b.x) / 2), midX0: (a.x + b.x) / 2 };
        return;
      }
      const x = px(e), sx = this.tToX(this.sel.s), ex = this.tToX(this.sel.e);
      const ds = Math.abs(x - sx), de = Math.abs(x - ex);
      if (Math.min(ds, de) < HIT) this.drag = { mode: ds <= de ? 's' : 'e' };
      else if (x > sx && x < ex) this.drag = { mode: 'move', t0: this.xToT(x), s0: this.sel.s, e0: this.sel.e };
      else this.drag = { mode: 'new', t0: this.xToT(x), x0: x, started: false };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) { c.style.cursor = this._cursor(px(e)); return; }
      this.pointers.get(e.pointerId).x = px(e);
      const d = this.drag; if (!d) return;
      const t = this.xToT(px(e));
      if (d.mode === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const f = d.d0 / (Math.abs(a.x - b.x) || 1), mx = (a.x + b.x) / 2;
        const span = d.v0.e - d.v0.s, ns = span * f;
        const s = d.mid0 - (mx / this._w()) * ns;
        this.setView(s, s + ns);
      } else if (d.mode === 's') this._set(Math.min(t, this.sel.e - MIN_SPAN), this.sel.e);
      else if (d.mode === 'e') this._set(this.sel.s, Math.max(t, this.sel.s + MIN_SPAN));
      else if (d.mode === 'move') {
        const len = d.e0 - d.s0, s = clamp(d.s0 + (t - d.t0), 0, this.dur - len);
        this._set(s, s + len);
      } else if (d.mode === 'new') {
        if (!d.started && Math.abs(px(e) - d.x0) < 4) return;
        d.started = true;
        const a = clamp(d.t0, 0, this.dur), b = clamp(t, 0, this.dur);
        this._set(Math.min(a, b), Math.max(a, b + (a === b ? MIN_SPAN : 0)));
      }
    });
    const up = (e) => { this.pointers.delete(e.pointerId); if (this.pointers.size < 2 && this.drag?.mode === 'pinch') this.drag = null; if (!this.pointers.size) this.drag = null; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const x = px(e);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const dt = ((e.deltaX || e.deltaY) / this._w()) * this.span; this.setView(this.view.s + dt, this.view.e + dt);
      } else this.zoomBy(e.deltaY > 0 ? 1.25 : 0.8, this.xToT(x));
    }, { passive: false });
  }
  _cursor(x) {
    const near = Math.min(Math.abs(x - this.tToX(this.sel.s)), Math.abs(x - this.tToX(this.sel.e))) < HIT;
    return near ? 'ew-resize' : (x > this.tToX(this.sel.s) && x < this.tToX(this.sel.e)) ? 'grab' : 'crosshair';
  }
  _set(s, e) { this.sel = { s: clamp(s, 0, this.dur), e: clamp(e, 0, this.dur) }; this.onSelect(this.sel.s, this.sel.e); this.render(); }

  _bindOver() {
    const o = this.over; o.style.touchAction = 'none';
    let grab = null;
    const t = (e) => ((e.clientX - o.getBoundingClientRect().left) / o.clientWidth) * this.dur;
    o.addEventListener('pointerdown', (e) => {
      o.setPointerCapture(e.pointerId);
      const tt = t(e);
      if (tt >= this.view.s && tt <= this.view.e) grab = tt - this.view.s;
      else { grab = this.span / 2; this.setView(tt - grab, tt - grab + this.span); }
    });
    o.addEventListener('pointermove', (e) => { if (grab != null) { const s = t(e) - grab; this.setView(s, s + this.span); } });
    const up = () => { grab = null; };
    o.addEventListener('pointerup', up); o.addEventListener('pointercancel', up);
  }

  // ---- drawing ----
  _extent(i0, i1) {
    // min/max across [i0,i1) samples using block summaries when zoomed out
    let lo = 1, hi = -1;
    if (i1 - i0 >= BLOCK * 2) {
      const b0 = Math.floor(i0 / BLOCK), b1 = Math.min(this.mins.length, Math.ceil(i1 / BLOCK));
      for (let b = b0; b < b1; b++) { if (this.mins[b] < lo) lo = this.mins[b]; if (this.maxs[b] > hi) hi = this.maxs[b]; }
    } else {
      for (const c of this.chans) for (let i = Math.max(0, i0); i < Math.min(c.length, Math.max(i1, i0 + 1)); i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    return lo > hi ? [0, 0] : [lo, hi];
  }
  _fit(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, hh = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [g, w, hh];
  }
  render() {
    if (!this.chans) return;
    const css = getComputedStyle(this.el);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    const wave = col('--wave', '#7c5cff'), accent = col('--accent2', '#2ee6a6'), grid = col('--line', '#2b313c'), dim = col('--dim', '#8b93a1');
    // ---- main ----
    const [g, w, hh] = this._fit(this.canvas);
    g.clearRect(0, 0, w, hh);
    const top = 18, mid = top + (hh - top) / 2, amp = (hh - top) / 2 - 4;
    // ruler
    const raw = this.span / Math.max(2, w / 80), pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw) || raw;
    g.font = '10px system-ui'; g.fillStyle = dim; g.strokeStyle = grid; g.lineWidth = 1; g.textBaseline = 'top';
    for (let t = Math.ceil(this.view.s / step) * step; t < this.view.e; t += step) {
      const x = Math.round(this.tToX(t)) + 0.5;
      g.beginPath(); g.moveTo(x, top - 4); g.lineTo(x, hh); g.stroke();
      g.fillText(fmtTime(t, step < 0.1 ? 3 : step < 1 ? 2 : step < 10 ? 1 : 0), x + 3, 2);
    }
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
    // waveform
    const spp = (this.span * this.sr) / w;
    g.fillStyle = wave;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((this.view.s * this.sr) + x * spp), i1 = Math.floor((this.view.s * this.sr) + (x + 1) * spp);
      if (i0 >= this.chans[0].length) break;
      const [lo, hi] = this._extent(i0, i1);
      const y0 = mid - hi * amp, y1 = mid - lo * amp;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    // dim outside selection
    const sx = this.tToX(this.sel.s), ex = this.tToX(this.sel.e);
    g.fillStyle = 'rgba(8,10,14,.62)';
    g.fillRect(0, top, Math.max(0, Math.min(w, sx)), hh - top);
    if (ex < w) g.fillRect(Math.max(0, ex), top, w - Math.max(0, ex), hh - top);
    // handles
    g.fillStyle = accent; g.strokeStyle = accent; g.lineWidth = 2;
    for (const [x, dir] of [[sx, 1], [ex, -1]]) {
      if (x < -20 || x > w + 20) continue;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, hh); g.stroke();
      g.beginPath(); g.roundRect(x - (dir > 0 ? 0 : 14), mid - 20, 14, 40, 4); g.fill();
      g.fillStyle = '#0b0d11'; g.fillRect(x + dir * 7 - 1, mid - 8, 2, 16); g.fillStyle = accent;
    }
    if (this.playhead != null) {
      const x = this.tToX(this.playhead);
      if (x >= 0 && x <= w) { g.fillStyle = '#fff'; g.fillRect(x - 1, top, 2, hh - top); }
    }
    // ---- overview ----
    const [o, ow, oh] = this._fit(this.over);
    o.clearRect(0, 0, ow, oh);
    o.fillStyle = grid; o.globalAlpha = 0.5; o.fillRect(0, 0, ow, oh); o.globalAlpha = 1;
    const ospp = (this.dur * this.sr) / ow;
    o.fillStyle = dim;
    for (let x = 0; x < ow; x++) {
      const [lo, hi] = this._extent(Math.floor(x * ospp), Math.floor((x + 1) * ospp));
      o.fillRect(x, oh / 2 - hi * (oh / 2 - 2), 1, Math.max(1, (hi - lo) * (oh / 2 - 2)));
    }
    o.fillStyle = 'rgba(46,230,166,.35)';
    o.fillRect((this.sel.s / this.dur) * ow, 0, Math.max(2, ((this.sel.e - this.sel.s) / this.dur) * ow), oh);
    o.strokeStyle = '#fff'; o.lineWidth = 2;
    o.strokeRect((this.view.s / this.dur) * ow + 1, 1, Math.max(4, (this.span / this.dur) * ow - 2), oh - 2);
  }
}
