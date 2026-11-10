import { h, icon, nav } from './ui.js';
import * as ST from './store.js';
import { initLibrary, installState, leaveLibrary } from './library.js';
import { initSampleEditor, leaveSampleEditor, togglePlayShortcut } from './sampleEditor.js';
import { initTrackEditor, leaveTrackEditor } from './trackEditor.js';

const VIEWS = [
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'sample', label: 'Sample editor', icon: 'scissors' },
  { id: 'track', label: 'Track editor', icon: 'tracks' },
];
let current = null;

function go(id) {
  if (!VIEWS.some((v) => v.id === id)) id = 'library';
  if (current === id) return;
  if (current === 'library') leaveLibrary();
  if (current === 'sample') leaveSampleEditor();
  if (current === 'track') leaveTrackEditor();
  current = id;
  VIEWS.forEach((v) => {
    document.getElementById('view-' + v.id).classList.toggle('active', v.id === id);
    document.querySelector(`#tabbar [data-view="${v.id}"]`).classList.toggle('on', v.id === id);
  });
  document.getElementById('main').scrollTop = 0;
  history.replaceState(null, '', '#' + id);
}
nav.go = go;

async function boot() {
  const bar = document.getElementById('tabbar');
  VIEWS.forEach((v) => bar.append(h('button', { class: 'tab-btn', 'data-view': v.id, type: 'button', onclick: () => go(v.id) },
    h('span', { html: icon(v.icon, 24) }), h('span', {}, v.label))));
  try {
    await ST.loadAll();
  } catch (err) {
    console.error(err);
    document.getElementById('view-library').textContent = 'Storage is unavailable in this browser mode (private window?). Saving will not work.';
  }
  initLibrary(document.getElementById('view-library'));
  initSampleEditor(document.getElementById('view-sample'));
  await initTrackEditor(document.getElementById('view-track'));
  go(location.hash.slice(1) || 'library');
  window.addEventListener('keydown', (e) => {
    if (current === 'sample' && e.code === 'Space' && !/input|textarea|select|button/i.test(e.target.tagName)) { e.preventDefault(); togglePlayShortcut(); }
  });

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installState.prompt = e; window.dispatchEvent(new Event('install-available')); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
  document.documentElement.dataset.ready = '1';
}
boot();
