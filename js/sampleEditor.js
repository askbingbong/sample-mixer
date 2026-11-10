// Sample editor: load a song, pick a slice, shape it, save it to the library.
import { h, $, icon, iconBtn, toast, busy, slider, toggle, chips, fmtTime, fmtDur, debounce, download, safeName, nav, confirmBox } from './ui.js';
import { DEFAULT_PARAMS, renderSample, computePeaks, encodeWav } from './dsp.js';
import { WaveView } from './waveform.js';
import * as A from './audio.js';
import * as ST from './store.js';

const S = {
  chans: null, sr: 44100, dur: 0,
  source: null,        // stored song record (or null when editing a baked sample)
  sampleId: null,      // library sample being edited (null = new)
  name: '',
  params: { ...DEFAULT_PARAMS },
  bypass: false,       // A/B: audition without effects
  loop: false,
  out: null,           // last rendered {channels, sampleRate}
  outBuf: null,
  tab: 'trim',
  dirty: false,
};
const preview = new A.Preview();
let root, wave, emptyEl, editorEl, panelEl, nameInput, infoEl, playBtn, readout, raf;

const FILE_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.mp4';
const hzFromPos = (pos) => Math.round(20 * Math.pow(1000, pos / 100));
const posFromHz = (hz) => Math.round(100 * Math.log(hz / 20) / Math.log(1000));
const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 0 : 1) + ' kHz' : hz + ' Hz');
const fmtDb = (v) => (v > 0 ? '+' : '') + v + ' dB';

// ============ public API ============
export function initSampleEditor(el) {
  root = el;
  emptyEl = h('div', { class: 'page' });
  editorEl = h('div', { class: 'page', hidden: true });
  root.append(emptyEl, editorEl);
  buildEmpty();
  buildEditor();
  ST.on('library', () => { if (!S.chans) buildEmpty(); });
}
export function leaveSampleEditor() { stopPreview(); }
export function togglePlayShortcut() { if (S.chans) togglePlay(); }

export async function importFile(file) {
  const b = busy('Reading ' + file.name + '…');
  try {
    const buf = await A.decodeFile(file);
    const rec = { id: ST.uid(), name: file.name.replace(/\.[^.]+$/, ''), blob: file, duration: buf.duration, size: file.size, created: Date.now() };
    await ST.saveSource(rec);
    load({ chans: chansOf(buf), sr: buf.sampleRate, source: rec, name: rec.name + ' clip', params: { ...DEFAULT_PARAMS, start: 0, end: Math.min(buf.duration, 8) } });
  } catch (err) {
    console.error(err);
    toast('Could not read that file. Try an MP3, WAV, M4A, OGG or FLAC.', 4000);
  } finally { b.done(); }
}

export async function editSource(id) {
  const rec = ST.sources.get(id); if (!rec) return;
  const b = busy('Opening ' + rec.name + '…');
  try {
    const buf = await A.decodeFile(rec.blob);
    load({ chans: chansOf(buf), sr: buf.sampleRate, source: rec, name: rec.name + ' clip', params: { ...DEFAULT_PARAMS, start: 0, end: Math.min(buf.duration, 8) } });
  } catch (err) { console.error(err); toast('Could not open that song.'); } finally { b.done(); }
}

export async function editSample(id) {
  const meta = ST.samples.get(id); if (!meta) return;
  const b = busy('Opening ' + meta.name + '…');
  try {
    const src = meta.sourceId && ST.sources.get(meta.sourceId);
    if (src) {
      const buf = await A.decodeFile(src.blob);
      load({ chans: chansOf(buf), sr: buf.sampleRate, source: src, sampleId: id, name: meta.name, params: { ...DEFAULT_PARAMS, ...meta.params } });
    } else {
      // original song was deleted: edit the saved audio itself
      const pcm = await ST.getSamplePcm(id);
      load({ chans: pcm, sr: meta.sr, source: null, sampleId: id, name: meta.name, params: { ...DEFAULT_PARAMS } });
      toast('The original song is gone, so you are editing the saved sample itself.', 4000);
    }
  } catch (err) { console.error(err); toast('Could not open that sample.'); } finally { b.done(); }
}

const chansOf = (buf) => Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i));

function load({ chans, sr, source, sampleId = null, name, params }) {
  stopPreview();
  Object.assign(S, { chans, sr, dur: chans[0].length / sr, source, sampleId, name, params, bypass: false, tab: 'trim', dirty: false });
  if (S.params.end == null || S.params.end > S.dur) S.params.end = S.dur;
  emptyEl.hidden = true; editorEl.hidden = false;
  nameInput.value = name;
  $('#save-btn', editorEl).textContent = sampleId ? 'Update sample' : 'Save to library';
  $('#savenew-btn', editorEl).hidden = !sampleId;
  wave.setSource(chans, sr);
  wave.setSelection(S.params.start, S.params.end);
  wave.zoomToSelection();
  setTab('trim');
  refresh(true);
  nav.go('sample');
}

// ============ empty state ============
function buildEmpty() {
  emptyEl.replaceChildren();
  const input = h('input', { type: 'file', accept: FILE_ACCEPT, hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); } });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => input.click() },
    h('div', { class: 'drop-icon', html: icon('upload', 40) }),
    h('h2', {}, 'Pick a song to sample'),
    h('p', { class: 'muted' }, 'Tap here to choose an audio file (MP3, WAV, M4A, OGG, FLAC). It stays on your device.'),
    h('button', { class: 'btn primary big', type: 'button' }, 'Choose song'));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) importFile(f); });
  emptyEl.append(h('h1', {}, 'Sample editor'), drop, input);
  if (ST.sources.size) {
    emptyEl.append(h('h2', { class: 'sec' }, 'Or reuse a song you already imported'),
      h('div', { class: 'list' }, [...ST.sources.values()].sort((a, b) => b.created - a.created).map((s) =>
        h('button', { class: 'row-item', onclick: () => editSource(s.id) },
          h('span', { class: 'ri-main' }, h('b', {}, s.name), h('small', { class: 'muted' }, fmtDur(s.duration))), h('span', { html: icon('scissors') })))));
  }
}

// ============ editor ============
function buildEditor() {
  nameInput = h('input', { class: 'text name', type: 'text', maxlength: 60, 'aria-label': 'Sample name', oninput: () => { S.name = nameInput.value; } });
  wave = new WaveView({ onSelect: (s, e) => { S.params.start = s; S.params.end = e; S.dirty = true; updateReadout(); schedule(); } });
  readout = h('div', { class: 'readout' });
  infoEl = h('div', { class: 'muted small center' });
  playBtn = h('button', { class: 'btn primary play', type: 'button', onclick: togglePlay });
  const loopBtn = toggleBtn('loop', 'Loop', () => S.loop, (v) => { S.loop = v; if (preview.playing) restartPreview(); });
  const abBtn = h('button', { class: 'btn', type: 'button', title: 'Hear the clip without any effects, to compare', onclick: () => { S.bypass = !S.bypass; abBtn.classList.toggle('on', S.bypass); abBtn.textContent = S.bypass ? 'Original' : 'With effects'; refresh(true); } }, 'With effects');
  panelEl = h('div', { class: 'panel' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['trim', 'Trim'], ['filter', 'Filter'], ['vocals', 'Vocals'], ['shape', 'Volume'], ['pitch', 'Pitch']].map(([id, label]) =>
    h('button', { class: 'tab', role: 'tab', 'data-tab': id, type: 'button', onclick: () => setTab(id) }, label)));
  editorEl.append(
    h('div', { class: 'row gap' }, nameInput, iconBtn('x', 'Close editor', closeEditor)),
    wave.el,
    readout,
    h('div', { class: 'row gap center-x wrap' }, playBtn, loopBtn, abBtn),
    infoEl, tabs, panelEl,
    h('div', { class: 'row gap wrap actions' },
      h('button', { id: 'save-btn', class: 'btn primary grow', type: 'button', onclick: () => save(false) }, 'Save to library'),
      h('button', { id: 'savenew-btn', class: 'btn grow', type: 'button', hidden: true, onclick: () => save(true) }, 'Save as new'),
      h('button', { class: 'btn', type: 'button', title: 'Download as WAV', onclick: exportWav, html: icon('download') + ' WAV' })));
  updatePlayBtn();
}

function toggleBtn(ic, label, get, set) {
  const b = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', html: icon(ic, 18) + ' ' + label });
  b.onclick = () => { const v = !get(); set(v); b.classList.toggle('on', v); b.setAttribute('aria-pressed', v); };
  return b;
}

async function closeEditor() {
  stopPreview();
  if (S.dirty && !(await confirmBox('Close editor?', 'Your unsaved changes will be lost.', 'Close', true))) return;
  S.chans = null; S.out = null; S.outBuf = null;
  editorEl.hidden = true; emptyEl.hidden = false; buildEmpty();
}

function setTab(id) {
  S.tab = id;
  editorEl.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === id));
  panelEl.replaceChildren(panels[id]());
}

function updateReadout() {
  const { start, end } = S.params;
  readout.textContent = '';
  readout.append(
    h('span', {}, h('small', {}, 'Start'), fmtTime(start, 2)),
    h('span', {}, h('small', {}, 'Length'), fmtTime(end - start, 2)),
    h('span', {}, h('small', {}, 'End'), fmtTime(end, 2)));
}

// ============ rendering / preview ============
const schedule = debounce(() => refresh(false), 140);
function render() {
  const p = S.bypass ? { start: S.params.start, end: S.params.end } : S.params;
  return renderSample(S.chans, S.sr, p);
}
function refresh(restart) {
  if (!S.chans) return;
  updateReadout();
  const t0 = performance.now();
  S.out = render();
  S.outBuf = A.makeBuffer(S.out.channels, S.out.sampleRate);
  const ms = Math.round(performance.now() - t0);
  const secs = S.out.channels[0].length / S.out.sampleRate;
  infoEl.textContent = `Result: ${fmtDur(secs)} · ${S.out.channels.length === 1 ? 'mono' : 'stereo'}` + (ms > 400 ? ` (processing took ${ms} ms – try a shorter clip)` : '');
  if (preview.playing) { const f = preview.fraction() ?? 0; playBuffer(restart ? 0 : f); }
}
async function playBuffer(fraction = 0) {
  await preview.play(S.outBuf, { loop: S.loop, offset: fraction * S.outBuf.duration, onended: () => { updatePlayBtn(); wave.setPlayhead(null); } });
  updatePlayBtn(); tick();
}
function restartPreview() { playBuffer(preview.fraction() ?? 0); }
function togglePlay() {
  if (preview.playing) { stopPreview(); return; }
  schedule.flush(); // make sure the buffer reflects the latest edits
  playBuffer(0);
}
function stopPreview() { preview.stop(); cancelAnimationFrame(raf); updatePlayBtn(); wave && wave.setPlayhead(null); }
function updatePlayBtn() {
  if (!playBtn) return;
  const on = preview.playing;
  playBtn.innerHTML = icon(on ? 'stop' : 'play', 20) + '<span>' + (on ? 'Stop' : 'Play') + '</span>';
}
function tick() {
  cancelAnimationFrame(raf);
  const f = preview.fraction();
  if (f == null) { wave.setPlayhead(null); return; }
  const { start, end, reverse } = S.params;
  const t = S.bypass ? start + f * (end - start) : (reverse ? end - f * (end - start) : start + f * (end - start));
  wave.setPlayhead(t);
  if (wave.span < wave.dur * 0.98) wave.follow(t);
  raf = requestAnimationFrame(tick);
}

// ============ saving ============
async function save(asNew) {
  if (!S.chans) return;
  stopPreview();
  const b = busy('Saving…');
  try {
    const out = renderSample(S.chans, S.sr, S.params); // always save with effects
    const existing = !asNew && S.sampleId ? ST.samples.get(S.sampleId) : null;
    const name = (S.name || '').trim() || 'Untitled sample';
    const meta = {
      id: existing ? existing.id : ST.uid(), name, sourceId: S.source ? S.source.id : null,
      params: { ...S.params }, sr: out.sampleRate, length: out.channels[0].length, channels: out.channels.length,
      duration: out.channels[0].length / out.sampleRate, peaks: computePeaks(out.channels, 300),
      created: existing ? existing.created : Date.now(), updated: Date.now(),
    };
    await ST.saveSample(meta, out.channels);
    S.sampleId = meta.id; S.dirty = false;
    $('#save-btn', editorEl).textContent = 'Update sample'; $('#savenew-btn', editorEl).hidden = false;
    toast(existing ? 'Sample updated – tracks using it have changed too' : 'Saved to your library ✓', 3000);
  } catch (err) { console.error(err); toast('Could not save (storage full?)', 4000); } finally { b.done(); }
}
function exportWav() {
  if (!S.chans) return;
  const out = renderSample(S.chans, S.sr, S.params);
  download(new Blob([encodeWav(out.channels, out.sampleRate)], { type: 'audio/wav' }), safeName(S.name) + '.wav');
}

// ============ tool panels ============
function set(patch) { Object.assign(S.params, patch); S.dirty = true; schedule(); }
function help(txt) { const p = h('p', { class: 'hint' }); p.innerHTML = icon('info', 16) + '<span></span>'; p.lastChild.textContent = txt; return p; }

const panels = {
  trim() {
    const w = h('div', { class: 'stack' });
    w.append(help('Drag the green handles to choose the part of the song you want. Drag inside the highlighted area to slide it. Pinch or use the buttons to zoom in for precise cuts.'));
    w.append(h('div', { class: 'row gap center-x wrap' },
      iconBtn('zoomIn', 'Zoom in', () => wave.zoomBy(0.5)), iconBtn('zoomOut', 'Zoom out', () => wave.zoomBy(2)),
      h('button', { class: 'btn', type: 'button', onclick: () => wave.zoomToSelection(), html: icon('fit', 18) + ' Selection' }),
      h('button', { class: 'btn', type: 'button', onclick: () => wave.zoomAll() }, 'Whole song')));
    const nudge = (label, key) => {
      const step = () => Math.max(0.001, wave.span / 400);
      return h('div', { class: 'nudge' }, h('span', {}, label),
        iconBtn('left', label + ' earlier', () => move(key, -step())), iconBtn('right', label + ' later', () => move(key, step())));
    };
    const move = (key, d) => {
      let { start, end } = S.params;
      if (key === 'start') start = Math.min(Math.max(0, start + d), end - 0.004); else end = Math.max(Math.min(S.dur, end + d), start + 0.004);
      wave.setSelection(start, end); set({ start, end }); updateReadout();
    };
    w.append(h('div', { class: 'row gap center-x wrap' }, nudge('Start', 'start'), nudge('End', 'end')));
    w.append(h('div', {}, h('small', { class: 'muted' }, 'Quick length from the start handle'),
      h('div', { class: 'chips' }, [0.25, 0.5, 1, 2, 4, 8].map((l) => h('button', { class: 'chip', type: 'button', onclick: () => {
        const start = S.params.start, end = Math.min(S.dur, start + l); wave.setSelection(start, end); set({ end }); updateReadout();
      } }, l + ' s')))));
    w.append(h('button', { class: 'btn', type: 'button', onclick: () => { wave.setSelection(0, S.dur); set({ start: 0, end: S.dur }); wave.zoomAll(); } }, 'Select whole song'));
    return w;
  },

  filter() {
    const w = h('div', { class: 'stack' });
    w.append(help('Filters remove parts of the sound. “Low-cut” removes deep sounds (bass, kick), “High-cut” removes bright sounds (hi-hats, hiss). Start with a preset, then tweak.'));
    const presets = [
      { id: 'none', label: 'None', p: { hp: 0, lp: 0, eqLow: 0, eqMid: 0, eqHigh: 0 } },
      { id: 'bass', label: 'Bass only', p: { hp: 0, lp: 200, eqLow: 0, eqMid: 0, eqHigh: 0 } },
      { id: 'nobass', label: 'No bass', p: { hp: 250, lp: 0, eqLow: 0, eqMid: 0, eqHigh: 0 } },
      { id: 'voice', label: 'Voice range', p: { hp: 200, lp: 5000, eqLow: 0, eqMid: 3, eqHigh: 0 } },
      { id: 'phone', label: 'Telephone', p: { hp: 450, lp: 3200, eqLow: 0, eqMid: 4, eqHigh: 0 } },
      { id: 'muffled', label: 'Muffled', p: { hp: 0, lp: 1200, eqLow: 0, eqMid: 0, eqHigh: 0 } },
      { id: 'lofi', label: 'Lo-fi', p: { hp: 120, lp: 4500, eqLow: 2, eqMid: 0, eqHigh: -3 } },
      { id: 'bright', label: 'Bright', p: { hp: 0, lp: 0, eqLow: -2, eqMid: 0, eqHigh: 6 } },
    ];
    const ctl = {};
    const sync = () => {
      ctl.hp.set(S.params.hp ? posFromHz(S.params.hp) : 0); ctl.lp.set(S.params.lp ? posFromHz(S.params.lp) : 100);
      ctl.low.set(S.params.eqLow); ctl.mid.set(S.params.eqMid); ctl.high.set(S.params.eqHigh);
    };
    const pc = chips({ options: presets, value: '', onChange: (id) => { set(presets.find((x) => x.id === id).p); sync(); } });
    w.append(h('small', { class: 'muted' }, 'Presets'), pc.el);
    ctl.hp = slider({ label: 'Low-cut (remove bass below)', min: 0, max: 100, value: S.params.hp ? posFromHz(S.params.hp) : 0, fmt: (v) => (v < 2 ? 'Off' : fmtHz(hzFromPos(v))), onInput: (v) => { set({ hp: v < 2 ? 0 : hzFromPos(v) }); pc.set(''); } });
    ctl.lp = slider({ label: 'High-cut (remove treble above)', min: 0, max: 100, value: S.params.lp ? posFromHz(S.params.lp) : 100, fmt: (v) => (v > 98 ? 'Off' : fmtHz(hzFromPos(v))), onInput: (v) => { set({ lp: v > 98 ? 0 : hzFromPos(v) }); pc.set(''); } });
    w.append(ctl.hp.el, ctl.lp.el, h('small', { class: 'muted' }, 'Tone (EQ)'));
    ctl.low = slider({ label: 'Bass', min: -12, max: 12, value: S.params.eqLow, fmt: fmtDb, onInput: (v) => { set({ eqLow: v }); pc.set(''); } });
    ctl.mid = slider({ label: 'Mids', min: -12, max: 12, value: S.params.eqMid, fmt: fmtDb, onInput: (v) => { set({ eqMid: v }); pc.set(''); } });
    ctl.high = slider({ label: 'Treble', min: -12, max: 12, value: S.params.eqHigh, fmt: fmtDb, onInput: (v) => { set({ eqHigh: v }); pc.set(''); } });
    w.append(ctl.low.el, ctl.mid.el, ctl.high.el);
    return w;
  },

  vocals() {
    const w = h('div', { class: 'stack' });
    const mono = S.chans.length < 2;
    w.append(help('Singers are usually mixed in the exact middle of a stereo song, while many instruments are spread left/right. These tools subtract or keep the “middle”. It is a trick, not magic: you will often still hear echoes or ghosts of the voice, and drums or bass in the centre can get affected too. Combine with the Filter tab for better results.'));
    if (mono) { w.append(h('div', { class: 'warn' }, 'This song is mono (same sound in both ears), so the trick cannot work on it.')); }
    const amount = slider({ label: 'Strength', min: 0, max: 100, value: Math.round(S.params.vocalAmount * 100), fmt: (v) => v + '%', onInput: (v) => set({ vocalAmount: v / 100 }) });
    const keep = toggle({ label: 'Protect bass & cymbals', hint: 'Only works on the middle of the voice range, so kick and bass keep their punch.', checked: S.params.keepBass, onChange: (v) => set({ keepBass: v }) });
    const opts = [{ id: 'off', label: 'Off' }, { id: 'remove', label: 'Remove vocals' }, { id: 'isolate', label: 'Keep only the middle' }];
    const c = chips({ options: opts, value: S.params.vocalMode, onChange: (id) => { if (mono && id !== 'off') { toast('Mono song – not possible'); c.set('off'); return; } set({ vocalMode: id }); upd(); } });
    const upd = () => { const on = S.params.vocalMode !== 'off'; amount.el.style.display = on ? '' : 'none'; keep.el.style.display = S.params.vocalMode === 'remove' ? '' : 'none'; desc.textContent = { off: 'No vocal processing.', remove: 'Cancels whatever is exactly in the centre (usually the singer). Great for instrumentals.', isolate: 'Keeps only what is in the centre and cuts the sides. Often brings the voice forward – but also centred drums and bass.' }[S.params.vocalMode]; };
    const desc = h('p', { class: 'muted small' });
    w.append(c.el, desc, amount.el, keep.el); upd();
    return w;
  },

  shape() {
    const w = h('div', { class: 'stack' });
    w.append(help('Fades smooth the start and end so the sample doesn’t click. “Auto-loudness” makes every sample about the same volume.'));
    w.append(slider({ label: 'Fade in', min: 0, max: 100, value: Math.round(S.params.fadeIn * 100), fmt: (v) => (v ? (v / 100).toFixed(2) + ' s' : 'None'), onInput: (v) => set({ fadeIn: v / 100 }) }).el);
    w.append(slider({ label: 'Fade out', min: 0, max: 100, value: Math.round(S.params.fadeOut * 100), fmt: (v) => (v ? (v / 100).toFixed(2) + ' s' : 'None'), onInput: (v) => set({ fadeOut: v / 100 }) }).el);
    w.append(toggle({ label: 'Auto-loudness (normalize)', checked: S.params.normalize, onChange: (v) => set({ normalize: v }) }).el);
    w.append(slider({ label: 'Extra volume', min: -24, max: 12, value: S.params.gain, fmt: fmtDb, onInput: (v) => set({ gain: v }) }).el);
    w.append(toggle({ label: 'Reverse', hint: 'Play the sample backwards', checked: S.params.reverse, onChange: (v) => set({ reverse: v }) }).el);
    w.append(toggle({ label: 'Make mono', hint: 'Same sound in both ears – smaller and punchier', checked: S.params.mono, onChange: (v) => set({ mono: v }) }).el);
    return w;
  },

  pitch() {
    const w = h('div', { class: 'stack' });
    w.append(help('Like speeding up or slowing down a record: higher pitch is also faster, lower pitch is also slower. 12 steps = one octave.'));
    const sl = slider({ label: 'Pitch / speed', min: -12, max: 12, step: 0.5, value: S.params.pitch, fmt: (v) => (v > 0 ? '+' : '') + v + ' st  (' + Math.round(Math.pow(2, v / 12) * 100) + '% speed)', onInput: (v) => set({ pitch: v }) });
    w.append(sl.el, h('button', { class: 'btn', type: 'button', onclick: () => { sl.set(0); set({ pitch: 0 }); } }, 'Reset'));
    return w;
  },
};
