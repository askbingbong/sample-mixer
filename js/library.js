// Library: your samples and imported songs.
import { h, icon, iconBtn, sheet, toast, confirmBox, promptBox, fmtDur, download, safeName } from './ui.js';
import { encodeWav } from './dsp.js';
import * as A from './audio.js';
import * as ST from './store.js';
import { importFile, editSample, editSource } from './sampleEditor.js';

const preview = new A.Preview();
let root, playingId = null;
export const installState = { prompt: null };

export function initLibrary(el) {
  root = el;
  ST.on('library', render);
  window.addEventListener('install-available', render);
  render();
}
export function leaveLibrary() { preview.stop(); playingId = null; }

function peaksCanvas(peaks) {
  const c = h('canvas', { class: 'thumb', width: 120, height: 44 });
  const g = c.getContext('2d');
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim() || '#7c5cff';
  const n = peaks.length, bars = 60;
  for (let i = 0; i < bars; i++) {
    let m = 0; for (let j = Math.floor((i * n) / bars); j < Math.floor(((i + 1) * n) / bars); j++) m = Math.max(m, peaks[j]);
    const hh = Math.max(2, m * 40); g.fillRect(i * 2, 22 - hh / 2, 1.4, hh);
  }
  return c;
}

async function togglePlay(id, btn) {
  if (playingId === id) { preview.stop(); playingId = null; render(); return; }
  const buf = await ST.getBuffer(id); if (!buf) return;
  playingId = id; render();
  await preview.play(buf, { onended: () => { if (playingId === id) { playingId = null; render(); } } });
}

function pickFile() {
  const input = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.mp4' });
  input.onchange = () => { const f = input.files[0]; if (f) importFile(f); };
  input.click();
}

function render() {
  if (!root) return;
  const samples = [...ST.samples.values()].sort((a, b) => b.updated - a.updated);
  const songs = [...ST.sources.values()].sort((a, b) => b.created - a.created);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const page = h('div', { class: 'page' },
    h('div', { class: 'row between' }, h('h1', {}, 'Library'),
      installState.prompt && h('button', { class: 'btn', onclick: async () => { installState.prompt.prompt(); await installState.prompt.userChoice; installState.prompt = null; render(); } }, 'Install app')),
    ios && !standalone && h('div', { class: 'card small' }, 'Tip: tap the Share button in Safari, then “Add to Home Screen” to install this as an app.'),
    h('button', { class: 'btn primary big block', onclick: () => pickFile() , html: icon('upload', 20) + ' Import a song' }));

  if (!samples.length && !songs.length) {
    page.append(h('div', { class: 'card steps' },
      h('h2', {}, 'How it works'),
      h('ol', {},
        h('li', {}, h('b', {}, 'Import a song'), ' from your phone or computer.'),
        h('li', {}, h('b', {}, 'Sample editor:'), ' select a slice, filter it, remove vocals, change pitch… then save it here.'),
        h('li', {}, h('b', {}, 'Track editor:'), ' arrange your samples on a timeline to build your own song.')),
      h('p', { class: 'muted small' }, 'Everything is stored on this device and works without internet.')));
  }

  page.append(h('h2', { class: 'sec' }, `Samples (${samples.length})`));
  if (samples.length) {
    page.append(h('div', { class: 'list' }, samples.map((s) => {
      const playing = playingId === s.id;
      return h('div', { class: 'row-item' },
        h('button', { class: 'icon-btn round' + (playing ? ' on' : ''), 'aria-label': playing ? 'Stop' : 'Play ' + s.name, onclick: () => togglePlay(s.id), html: icon(playing ? 'stop' : 'play') }),
        peaksCanvas(s.peaks),
        h('button', { class: 'ri-main link', onclick: () => editSample(s.id) }, h('b', {}, s.name), h('small', { class: 'muted' }, fmtDur(s.duration) + (s.channels === 1 ? ' · mono' : ''))),
        iconBtn('more', 'More actions for ' + s.name, () => menu(s)));
    })));
  } else page.append(h('p', { class: 'muted' }, 'No samples yet. Import a song and save a slice of it.'));

  if (songs.length) {
    page.append(h('h2', { class: 'sec' }, `Songs (${songs.length})`),
      h('div', { class: 'list' }, songs.map((s) => h('div', { class: 'row-item' },
        h('span', { class: 'round-ic', html: icon('library') }),
        h('button', { class: 'ri-main link', onclick: () => editSource(s.id) }, h('b', {}, s.name), h('small', { class: 'muted' }, fmtDur(s.duration) + ' · ' + (s.size / 1048576).toFixed(1) + ' MB · tap to sample')),
        iconBtn('trash', 'Delete song ' + s.name, () => delSong(s))))));
  }
  root.replaceChildren(page);
}

function menu(s) {
  sheet(s.name, (close) => {
    const mk = (ic, label, fn, cls = '') => { const b = h('button', { class: 'menu-item ' + cls, type: 'button', onclick: () => { close(); fn(); } }); b.innerHTML = icon(ic, 20) + '<span></span>'; b.lastChild.textContent = label; return b; };
    return h('div', { class: 'sheet-body menu' },
      mk('scissors', 'Edit sample', () => editSample(s.id)),
      mk('edit', 'Rename', async () => { const n = await promptBox('Rename sample', s.name); if (n) { await ST.saveSample({ ...s, name: n, updated: Date.now() }, await ST.getSamplePcm(s.id)); } }),
      mk('copy', 'Duplicate', async () => { const pcm = await ST.getSamplePcm(s.id); await ST.saveSample({ ...s, id: ST.uid(), name: s.name + ' copy', created: Date.now(), updated: Date.now() }, pcm); toast('Duplicated'); }),
      mk('download', 'Download as WAV', async () => { const pcm = await ST.getSamplePcm(s.id); download(new Blob([encodeWav(pcm, s.sr)], { type: 'audio/wav' }), safeName(s.name) + '.wav'); }),
      mk('trash', 'Delete', () => delSample(s), 'danger'));
  });
}

async function usedIn(sampleId) {
  return (await ST.listProjects()).filter((p) => p.clips.some((c) => c.sampleId === sampleId));
}
async function delSample(s) {
  const used = await usedIn(s.id);
  const msg = used.length ? `“${s.name}” is used in ${used.length} track project${used.length > 1 ? 's' : ''} (${used.map((p) => p.name).join(', ')}). Those clips will become silent.` : `Delete “${s.name}”? This cannot be undone.`;
  if (!(await confirmBox('Delete sample', msg, 'Delete', true))) return;
  if (playingId === s.id) { preview.stop(); playingId = null; }
  await ST.deleteSample(s.id);
  toast('Deleted');
}
async function delSong(s) {
  const n = [...ST.samples.values()].filter((x) => x.sourceId === s.id).length;
  const msg = n ? `${n} sample${n > 1 ? 's were' : ' was'} made from this song. They will stay in your library, but you won’t be able to re-edit them from the original song.` : 'Delete this song from the app? Your original file is not touched.';
  if (!(await confirmBox('Delete song', msg, 'Delete', true))) return;
  await ST.deleteSource(s.id);
}
