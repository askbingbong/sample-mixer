// Track editor: arrange library samples on a multi-track timeline.
import { h, icon, iconBtn, sheet, toast, busy, slider, chips, confirmBox, promptBox, debounce, download, safeName, fmtDur, clamp, nav } from './ui.js';
import { encodeWav } from './dsp.js';
import * as A from './audio.js';
import * as ST from './store.js';
import { newProject, newTrack, scheduleProject, updateTrackGains, songEndBeat, TRACK_COLORS } from './mixer.js';
import { editSample } from './sampleEditor.js';

const HEAD_W = 96, LANE_H = 72, RULER_H = 28, MIN_LEN = 0.25;
const SNAPS = [['1/4 beat', 0.25], ['1/2 beat', 0.5], ['1 beat', 1], ['1 bar', 4], ['Off', 0]];

const T = {
  project: null, sel: null, selTrack: null, beat: 0, playing: false,
  ppb: 40, snap: 0.5, undo: [], redo: [], sched: null, master: null, base: 0, startBeat: 0,
};
let root, scroller, inner, detail, timeEl, bpmInput, playBtn, undoBtn, redoBtn, projBtn, raf;
const previewer = new A.Preview();

const save = debounce(() => ST.saveProject(T.project), 500);
const snapB = (v) => (T.snap ? Math.round(v / T.snap) * T.snap : v);
const spb = () => 60 / T.project.bpm;
const totalBeats = () => Math.max(64, Math.ceil((songEndBeat(T.project) + 16) / 4) * 4);

// ============ init ============
export async function initTrackEditor(el) {
  root = el;
  const lastId = localStorage.getItem('sm.project');
  let p = lastId && (await ST.getProject(lastId));
  if (!p) { p = (await ST.listProjects())[0] || newProject(); await ST.saveProject(p); }
  T.project = p; T.selTrack = p.tracks[0].id;
  build(); renderAll();
  ST.on('sample-changed', () => { if (T.playing) reschedule(); renderTimeline(); });
  ST.on('library', () => { renderTimeline(); });
  window.addEventListener('keydown', onKey);
}
export function leaveTrackEditor() { pause(); }
export function trackEditorVisible() { return root && root.classList.contains('active'); }

function build() {
  projBtn = h('button', { class: 'btn proj', type: 'button', onclick: projectMenu });
  undoBtn = iconBtn('undo', 'Undo', undo); redoBtn = iconBtn('redo', 'Redo', redo);
  bpmInput = h('input', { class: 'text bpm', type: 'number', min: 40, max: 240, inputmode: 'numeric', 'aria-label': 'Tempo (BPM)', onchange: () => setBpm(+bpmInput.value) });
  const snapSel = h('select', { class: 'select', 'aria-label': 'Snap to grid', onchange: (e) => { T.snap = +e.target.value; } },
    SNAPS.map(([l, v]) => h('option', { value: v, selected: v === T.snap }, 'Snap: ' + l)));
  playBtn = h('button', { class: 'btn primary play', type: 'button', onclick: togglePlay });
  timeEl = h('span', { class: 'time' }, '0:00.0');
  const loopBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Loop song', title: 'Loop', 'aria-pressed': 'false', onclick: () => { T.project.loop = !T.project.loop; loopBtn.classList.toggle('on', T.project.loop); save(); }, html: icon('loop') });
  T.loopBtn = loopBtn;
  scroller = h('div', { class: 'tl-scroll' });
  inner = h('div', { class: 'tl-inner' });
  scroller.append(inner);
  detail = h('div', { class: 'te-detail' });
  const tools = h('div', { class: 'tl-tools' }, loopBtn, snapSel, iconBtn('zoomOut', 'Zoom out', () => zoom(1 / 1.4)), iconBtn('zoomIn', 'Zoom in', () => zoom(1.4)));
  root.append(
    h('div', { class: 'te-bar' }, projBtn, undoBtn, redoBtn,
      h('div', { class: 'bpm-wrap' }, iconBtn('minus', 'Slower', () => setBpm(T.project.bpm - 1)), bpmInput, h('small', { class: 'muted' }, 'BPM'), iconBtn('plus', 'Faster', () => setBpm(T.project.bpm + 1)))),
    h('div', { class: 'te-bar' },
      iconBtn('rewind', 'Back to start', () => { seek(0); scroller.scrollLeft = 0; }), playBtn, timeEl,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: addSampleSheet, html: icon('plus', 18) + ' Add' }),
      iconBtn('download', 'Export track as WAV', exportMix)),
    h('div', { class: 'tl-wrap' }, scroller, tools), detail);
  updatePlayBtn();
}

function renderAll() {
  projBtn.textContent = T.project.name + ' ▾';
  bpmInput.value = Math.round(T.project.bpm);
  T.loopBtn.classList.toggle('on', !!T.project.loop);
  renderTimeline(); renderDetail(); updateUndo();
}

// ============ history ============
const snapshot = () => JSON.stringify({ bpm: T.project.bpm, tracks: T.project.tracks, clips: T.project.clips });
function pushUndo() { T.undo.push(snapshot()); if (T.undo.length > 60) T.undo.shift(); T.redo = []; updateUndo(); }
function restore(s) { Object.assign(T.project, JSON.parse(s)); if (!T.project.clips.some((c) => c.id === T.sel)) T.sel = null; if (!T.project.tracks.some((t) => t.id === T.selTrack)) T.selTrack = T.project.tracks[0]?.id; changed(true); }
function undo() { if (!T.undo.length) return; T.redo.push(snapshot()); restore(T.undo.pop()); }
function redo() { if (!T.redo.length) return; T.undo.push(snapshot()); restore(T.redo.pop()); }
function updateUndo() { undoBtn.disabled = !T.undo.length; redoBtn.disabled = !T.redo.length; }
/** call after mutating the project */
function changed(rebuildHeader = false) {
  save(); updateUndo();
  if (rebuildHeader) { projBtn.textContent = T.project.name + ' ▾'; bpmInput.value = Math.round(T.project.bpm); }
  renderTimeline(); renderDetail();
  if (T.playing) reschedule();
}
const mutate = (fn) => { pushUndo(); fn(); changed(); };

// ============ timeline rendering ============
function renderTimeline() {
  if (!inner) return;
  const P = T.project, total = totalBeats(), laneW = total * T.ppb;
  inner.style.width = HEAD_W + laneW + 'px';
  inner.style.setProperty('--ppb', T.ppb);
  inner.style.setProperty('--head', HEAD_W + 'px');
  inner.style.setProperty('--lane', LANE_H + 'px');
  const kids = [];
  // ruler
  const step = [1, 2, 4, 8, 16].find((s) => s * 4 * T.ppb >= 44) || 16;
  const ruler = h('div', { class: 'ruler-track', style: { width: laneW + 'px' } });
  for (let b = 0; b * 4 < total; b += step) ruler.append(h('span', { class: 'tick', style: { left: b * 4 * T.ppb + 'px' } }, String(b + 1)));
  const scrub = (e) => { const r = ruler.getBoundingClientRect(); seek(clamp((e.clientX - r.left) / T.ppb, 0, total)); };
  ruler.style.touchAction = 'none';
  ruler.addEventListener('pointerdown', (e) => { ruler.setPointerCapture(e.pointerId); T.scrub = true; scrub(e); });
  ruler.addEventListener('pointermove', (e) => { if (T.scrub) scrub(e); });
  ruler.addEventListener('pointerup', () => { T.scrub = false; });
  kids.push(h('div', { class: 'tl-ruler' }, h('div', { class: 'corner' }), ruler));

  // tracks
  for (const t of P.tracks) {
    const lane = h('div', { class: 'tl-lane', style: { width: laneW + 'px' }, 'data-track': t.id });
    lane.addEventListener('click', (e) => {
      if (e.target !== lane) return;
      T.selTrack = t.id; T.sel = null;
      seek(snapB((e.clientX - lane.getBoundingClientRect().left) / T.ppb));
      renderTimeline(); renderDetail();
    });
    for (const c of P.clips) if (c.trackId === t.id) lane.append(clipEl(c, t));
    kids.push(h('div', { class: 'tl-row' + (T.selTrack === t.id ? ' sel' : ''), 'data-track': t.id, style: { '--c': t.color } }, trackHead(t), lane));
  }
  kids.push(h('div', { class: 'tl-row addrow' }, h('div', { class: 'tl-head add' },
    h('button', { class: 'btn small', type: 'button', onclick: () => mutate(() => { const t = newTrack(P.tracks.length); P.tracks.push(t); T.selTrack = t.id; }), html: icon('plus', 16) + ' Track' }))));
  kids.push(h('div', { class: 'playhead', style: { left: HEAD_W + T.beat * T.ppb + 'px' } }));
  inner.replaceChildren(...kids);
  T.phEl = inner.lastChild;
}

function trackHead(t) {
  const btn = (txt, on, cls, fn, label) => h('button', { class: 'mini ' + cls + (on ? ' on' : ''), type: 'button', 'aria-label': label, 'aria-pressed': String(!!on), onclick: (e) => { e.stopPropagation(); fn(); } }, txt);
  return h('div', { class: 'tl-head', onclick: () => { T.selTrack = t.id; renderTimeline(); } },
    h('div', { class: 'tname' }, h('i', { class: 'dot' }), h('span', {}, t.name)),
    h('div', { class: 'tbtns' },
      btn('M', t.mute, 'm', () => { t.mute = !t.mute; liveGains(); save(); renderTimeline(); }, 'Mute ' + t.name),
      btn('S', t.solo, 's', () => { t.solo = !t.solo; liveGains(); save(); renderTimeline(); }, 'Solo ' + t.name),
      h('button', { class: 'mini', type: 'button', 'aria-label': 'Track settings for ' + t.name, onclick: (e) => { e.stopPropagation(); trackSheet(t); }, html: icon('more', 16) })));
}
const liveGains = () => { if (T.playing && T.sched) updateTrackGains(T.project, T.sched.trackGain); };

function clipEl(c, t) {
  const sample = ST.samples.get(c.sampleId);
  const el = h('div', { class: 'clip' + (T.sel === c.id ? ' sel' : '') + (sample ? '' : ' missing'), 'data-clip': c.id, style: { left: c.start * T.ppb + 'px', width: Math.max(6, c.len * T.ppb) + 'px' } });
  const cv = h('canvas', { class: 'clip-wave' });
  el.append(cv, h('span', { class: 'clip-name' }, sample ? sample.name : 'Missing sample'), h('i', { class: 'grip' }));
  if (sample) drawClip(cv, c, sample, t.color);
  attachDrag(el, c);
  return el;
}

function drawClip(cv, c, sample, color) {
  const w = Math.min(4096, Math.max(1, Math.ceil(c.len * T.ppb))), hh = LANE_H - 10;
  cv.width = w; cv.height = hh;
  const g = cv.getContext('2d'); g.fillStyle = color;
  const peaks = sample.peaks, n = peaks.length, sb = sample.duration / spb(), ob = (c.off || 0) / spb();
  const k = (c.len * T.ppb) / w;
  for (let x = 0; x < w; x++) {
    const beat = (x * k) / T.ppb, p = ((ob + beat) % sb) / sb;
    const a = peaks[Math.min(n - 1, Math.floor(p * n))];
    const bh = Math.max(1.5, a * hh * 0.9);
    g.fillRect(x, (hh - bh) / 2, 1, bh);
  }
  g.fillStyle = 'rgba(255,255,255,.45)'; // loop boundaries
  for (let b = sb - ob; b < c.len - 0.01; b += sb) g.fillRect(Math.floor((b * T.ppb) / k), 0, 1, hh);
}

// ============ clip dragging ============
function attachDrag(el, c) {
  let st = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    st = { x0: e.clientX, y0: e.clientY, start: c.start, len: c.len, track: c.trackId, resize: e.clientX > r.right - Math.min(22, r.width * 0.3), moved: false, snap: null };
    if (T.sel !== c.id) { T.sel = c.id; T.selTrack = c.trackId; inner.querySelectorAll('.clip.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); renderDetail(); }
  });
  el.addEventListener('pointermove', (e) => {
    if (!st) return;
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
    if (!st.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    if (!st.moved) { st.moved = true; st.snap = snapshot(); el.classList.add('dragging'); }
    const db = dx / T.ppb;
    if (st.resize) {
      const end = Math.max(st.start + MIN_LEN, snapB(st.start + st.len + db));
      c.len = end - st.start; el.style.width = c.len * T.ppb + 'px';
    } else {
      c.start = Math.max(0, snapB(st.start + db));
      const rows = [...inner.querySelectorAll('.tl-row[data-track]')], cur = rows.findIndex((r) => r.dataset.track === st.track);
      let idx = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return e.clientY >= b.top && e.clientY < b.bottom; });
      if (idx < 0) idx = e.clientY < rows[0].getBoundingClientRect().top ? 0 : rows.length - 1;
      c.trackId = rows[idx].dataset.track;
      el.style.transform = `translate(${(c.start - st.start) * T.ppb}px, ${(idx - cur) * LANE_H}px)`;
    }
  });
  const end = () => {
    if (!st) return;
    const s = st; st = null;
    if (!s.moved) return;
    T.undo.push(s.snap); T.redo = []; T.selTrack = c.trackId; changed();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { if (st && st.moved) { c.start = st.start; c.len = st.len; c.trackId = st.track; } st = null; renderTimeline(); });
}

// ============ selected-clip bar ============
function renderDetail() {
  const c = T.project.clips.find((x) => x.id === T.sel);
  detail.replaceChildren();
  if (!c) { detail.append(h('span', { class: 'muted small' }, T.project.clips.length ? 'Tap a clip to edit it · drag its right edge to loop or trim · tap an empty lane to move the playhead.' : 'Tap “+ Add” to drop a sample from your library onto the timeline.')); return; }
  const s = ST.samples.get(c.sampleId);
  const vol = slider({ label: s ? s.name : 'Missing sample', min: 0, max: 150, value: Math.round((c.gain ?? 1) * 100), fmt: (v) => v + '%', onInput: (v) => { c.gain = v / 100; save(); }, });
  vol.el.querySelector('input').addEventListener('change', () => { if (T.playing) reschedule(); });
  vol.el.querySelector('input').addEventListener('pointerdown', () => pushUndo());
  detail.append(vol.el, h('div', { class: 'row gap' },
    iconBtn('split', 'Split at playhead', splitClip), iconBtn('copy', 'Duplicate clip', dupClip),
    s && iconBtn('scissors', 'Edit this sample', () => editSample(c.sampleId)),
    iconBtn('trash', 'Delete clip', () => mutate(() => { T.project.clips = T.project.clips.filter((x) => x.id !== c.id); T.sel = null; }), 'danger')));
}
function dupClip() {
  const c = T.project.clips.find((x) => x.id === T.sel); if (!c) return;
  mutate(() => { const n = { ...c, id: ST.uid(), start: c.start + c.len }; T.project.clips.push(n); T.sel = n.id; });
}
function splitClip() {
  const c = T.project.clips.find((x) => x.id === T.sel); if (!c) return;
  const at = snapB(T.beat);
  if (at <= c.start + 0.1 || at >= c.start + c.len - 0.1) { toast('Move the playhead inside the clip first (tap the ruler)'); return; }
  const dur = ST.samples.get(c.sampleId)?.duration || 1;
  mutate(() => {
    const n = { ...c, id: ST.uid(), start: at, len: c.start + c.len - at, off: ((c.off || 0) + (at - c.start) * spb()) % dur };
    c.len = at - c.start; T.project.clips.push(n); T.sel = n.id;
  });
}

// ============ add sample / track / project sheets ============
function addSampleSheet() {
  const list = [...ST.samples.values()].sort((a, b) => b.updated - a.updated);
  sheet('Add a sample', (close) => {
    if (!list.length) return h('div', { class: 'sheet-body' }, h('p', { class: 'muted' }, 'Your library is empty. Make a sample first!'),
      h('button', { class: 'btn primary', onclick: () => { close(); nav.go('sample'); } }, 'Open sample editor'));
    return h('div', { class: 'sheet-body list' }, h('p', { class: 'muted small' }, 'It will be placed at the playhead on the selected track.'),
      list.map((s) => h('div', { class: 'row-item' },
        h('button', { class: 'icon-btn round', 'aria-label': 'Preview ' + s.name, onclick: async () => { if (previewer.playing) { previewer.stop(); return; } const b = await ST.getBuffer(s.id); b && previewer.play(b); }, html: icon('play') }),
        h('button', { class: 'ri-main link', onclick: () => { previewer.stop(); close(); addClip(s); } }, h('b', {}, s.name), h('small', { class: 'muted' }, fmtDur(s.duration))),
        iconBtn('plus', 'Add ' + s.name, () => { previewer.stop(); close(); addClip(s); }))));
  }, { onClose: () => previewer.stop() });
}
function addClip(s) {
  const P = T.project;
  mutate(() => {
    const trackId = T.selTrack || P.tracks[0].id;
    let start = Math.max(0, snapB(T.beat)), hit;
    while ((hit = P.clips.find((c) => c.trackId === trackId && c.start <= start + 1e-6 && start < c.start + c.len - 1e-6))) start = hit.start + hit.len;
    const clip = { id: ST.uid(), trackId, sampleId: s.id, start, len: Math.max(MIN_LEN, s.duration / spb()), off: 0, gain: 1 };
    P.clips.push(clip); T.sel = clip.id;
  });
  const x = HEAD_W + (P.clips.find((c) => c.id === T.sel)?.start ?? T.beat) * T.ppb;
  if (x < scroller.scrollLeft + HEAD_W || x > scroller.scrollLeft + scroller.clientWidth - 60) scroller.scrollLeft = Math.max(0, x - HEAD_W - 20);
  toast('Added “' + s.name + '” – drag to move, drag the right edge to loop');
}

function trackSheet(t) {
  sheet('Track settings', (close) => {
    const P = T.project, idx = P.tracks.indexOf(t);
    const name = h('input', { class: 'text', type: 'text', value: t.name, maxlength: 24, 'aria-label': 'Track name', oninput: () => { t.name = name.value || 'Track'; save(); } });
    name.addEventListener('change', () => renderTimeline());
    const vol = slider({ label: 'Volume', min: 0, max: 120, value: Math.round(t.vol * 100), fmt: (v) => v + '%', onInput: (v) => { t.vol = v / 100; liveGains(); save(); } });
    const col = chips({ options: TRACK_COLORS.map((c) => ({ id: c, label: '●' })), value: t.color, onChange: (c) => { t.color = c; save(); renderTimeline(); } });
    col.el.querySelectorAll('button').forEach((b) => { b.style.color = b.dataset.id; });
    return h('div', { class: 'sheet-body stack' }, name, vol.el, col.el,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn', disabled: idx === 0, onclick: () => { mutate(() => { P.tracks.splice(idx, 1); P.tracks.splice(idx - 1, 0, t); }); close(); } }, 'Move up'),
        h('button', { class: 'btn', disabled: idx === P.tracks.length - 1, onclick: () => { mutate(() => { P.tracks.splice(idx, 1); P.tracks.splice(idx + 1, 0, t); }); close(); } }, 'Move down')),
      h('button', { class: 'btn danger', disabled: P.tracks.length < 2, onclick: async () => {
        const n = P.clips.filter((c) => c.trackId === t.id).length;
        if (n && !(await confirmBox('Delete track', `This track has ${n} clip${n > 1 ? 's' : ''}. Delete them too?`, 'Delete', true))) return;
        mutate(() => { P.tracks = P.tracks.filter((x) => x !== t); P.clips = P.clips.filter((c) => c.trackId !== t.id); T.selTrack = P.tracks[0].id; });
        close();
      } }, 'Delete track'));
  });
}

async function projectMenu() {
  const projects = await ST.listProjects();
  sheet('Projects', (close) => h('div', { class: 'sheet-body stack' },
    h('div', { class: 'list' }, projects.map((p) => h('div', { class: 'row-item' },
      h('button', { class: 'ri-main link', onclick: async () => { close(); await openProject(p.id); } }, h('b', {}, p.name + (p.id === T.project.id ? '  ✓' : '')), h('small', { class: 'muted' }, `${p.clips.length} clips · ${Math.round(p.bpm)} BPM`)),
      p.id !== T.project.id && iconBtn('trash', 'Delete project ' + p.name, async () => { if (await confirmBox('Delete project', `Delete “${p.name}”?`, 'Delete', true)) { await ST.deleteProject(p.id); close(); projectMenu(); } })))),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn', onclick: async () => { const n = await promptBox('Rename project', T.project.name); if (n) { T.project.name = n; save(); projBtn.textContent = n + ' ▾'; } close(); } }, 'Rename'),
      h('button', { class: 'btn', onclick: async () => { await ST.saveProject(T.project); const copy = JSON.parse(JSON.stringify(T.project)); copy.id = ST.uid(); copy.name += ' copy'; await ST.saveProject(copy); close(); await openProject(copy.id); } }, 'Duplicate'),
      h('button', { class: 'btn primary', onclick: async () => { close(); await ST.saveProject(T.project); const p = newProject('Track ' + (projects.length + 1)); await ST.saveProject(p); await openProject(p.id); } }, 'New project'))));
}
async function openProject(id) {
  pause(); await ST.saveProject(T.project);
  const p = await ST.getProject(id); if (!p) return;
  T.project = p; T.sel = null; T.selTrack = p.tracks[0].id; T.beat = 0; T.undo = []; T.redo = [];
  localStorage.setItem('sm.project', id);
  scroller.scrollLeft = 0; renderAll();
}

// ============ tempo / zoom ============
function setBpm(v) {
  v = clamp(Math.round(v) || T.project.bpm, 40, 240);
  if (v === T.project.bpm) { bpmInput.value = v; return; }
  mutate(() => {
    const f = v / T.project.bpm; // keep each clip's real length: samples are not time-stretched
    T.project.clips.forEach((c) => { c.len = Math.max(MIN_LEN, c.len * f); });
    T.project.bpm = v;
  });
  bpmInput.value = v;
}
function zoom(f) {
  const centre = (scroller.scrollLeft + scroller.clientWidth / 2 - HEAD_W) / T.ppb;
  T.ppb = clamp(T.ppb * f, 10, 200);
  renderTimeline();
  scroller.scrollLeft = Math.max(0, centre * T.ppb + HEAD_W - scroller.clientWidth / 2);
}

// ============ transport ============
function updatePlayBtn() { playBtn.innerHTML = icon(T.playing ? 'pause' : 'play', 20) + '<span>' + (T.playing ? 'Pause' : 'Play') + '</span>'; }
function updateTime() {
  const b = T.beat;
  timeEl.textContent = fmtSecs(b * spb());
  timeEl.title = `Bar ${Math.floor(b / 4) + 1}, beat ${Math.floor(b % 4) + 1}`;
  if (T.phEl) T.phEl.style.left = HEAD_W + b * T.ppb + 'px';
}
const fmtSecs = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
function seek(beat) {
  T.beat = Math.max(0, beat); updateTime();
  if (T.playing) reschedule();
}
async function usedBuffers() {
  const map = new Map();
  for (const id of new Set(T.project.clips.map((c) => c.sampleId))) { const b = await ST.getBuffer(id); if (b) map.set(id, b); }
  return map;
}
async function play() {
  if (!T.project.clips.length) { toast('Add a sample to the timeline first'); return; }
  previewer.stop();
  const ctx = await A.resume();
  const buffers = await usedBuffers();
  if (T.playing) return;
  T.master = ctx.createGain(); T.master.gain.value = 0.9; T.master.connect(ctx.destination);
  T.base = ctx.currentTime + 0.06; T.startBeat = T.beat;
  T.sched = scheduleProject(ctx, T.master, T.project, buffers, T.beat, T.base);
  T.playing = true; updatePlayBtn(); loop();
}
function halt() {
  if (T.sched) {
    const ctx = A.getCtx(), m = T.master, nodes = T.sched.nodes;
    try { m.gain.setTargetAtTime(0, ctx.currentTime, 0.006); } catch { /* ignore */ }
    setTimeout(() => { nodes.forEach((n) => { try { n.stop(); } catch { /* already ended */ } n.disconnect(); }); m.disconnect(); }, 60);
  }
  T.sched = null; T.master = null;
}
function pause() {
  if (!T.playing) return;
  T.playing = false; cancelAnimationFrame(raf); halt(); updatePlayBtn();
}
function togglePlay() { T.playing ? pause() : play(); }
async function reschedule() {
  if (!T.playing) return;
  const was = T.beat; // T.beat is kept current by the loop()
  T.playing = false; halt(); T.beat = was;
  await play();
}
function loop() {
  cancelAnimationFrame(raf);
  const ctx = A.getCtx();
  const frame = () => {
    if (!T.playing) return;
    T.beat = T.startBeat + Math.max(0, ctx.currentTime - T.base) / spb();
    const end = songEndBeat(T.project);
    if (T.beat >= end + 0.02) {
      if (T.project.loop) { T.beat = 0; reschedule(); return; }
      pause(); T.beat = 0; updateTime(); scroller.scrollLeft = 0; return;
    }
    updateTime();
    const x = HEAD_W + T.beat * T.ppb;
    if (x > scroller.scrollLeft + scroller.clientWidth - 30 || x < scroller.scrollLeft + HEAD_W) scroller.scrollLeft = Math.max(0, x - HEAD_W - 40);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

// ============ export ============
async function exportMix() {
  const P = T.project;
  if (!P.clips.length) { toast('Nothing to export yet'); return; }
  const b = busy('Rendering your track…');
  try {
    const buffers = await usedBuffers();
    const sr = A.getCtx().sampleRate, secs = songEndBeat(P) * spb() + 0.4;
    const off = new OfflineAudioContext(2, Math.ceil(secs * sr), sr);
    const master = off.createGain(); master.gain.value = 0.9; master.connect(off.destination);
    scheduleProject(off, master, P, buffers, 0, 0);
    const out = await off.startRendering();
    const chans = [out.getChannelData(0), out.getChannelData(1)];
    let pk = 0; for (const c of chans) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
    if (pk > 0.99) { const g = 0.99 / pk; for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g; }
    download(new Blob([encodeWav(chans, sr)], { type: 'audio/wav' }), safeName(P.name) + '.wav');
    toast('Exported ' + safeName(P.name) + '.wav');
  } catch (err) { console.error(err); toast('Export failed'); } finally { b.done(); }
}

// ============ keyboard (desktop) ============
function onKey(e) {
  if (!trackEditorVisible() || /input|textarea|select/i.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && T.sel) { mutate(() => { T.project.clips = T.project.clips.filter((x) => x.id !== T.sel); T.sel = null; }); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); dupClip(); }
}
