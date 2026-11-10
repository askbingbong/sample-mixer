// Persistence (IndexedDB) + in-memory caches for the library.
import { int16ToFloat, floatToInt16 } from './dsp.js';
import { makeBuffer } from './audio.js';

const NAME = 'sample-mixer-db';
let dbp;
function open() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => { for (const s of ['sources', 'samples', 'pcm', 'projects']) r.result.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out; const rq = fn(t.objectStore(store));
    if (rq) rq.onsuccess = () => { out = rq.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const getAll = (s) => tx(s, 'readonly', (o) => o.getAll());
const get = (s, id) => tx(s, 'readonly', (o) => o.get(id));
const put = (s, v) => tx(s, 'readwrite', (o) => o.put(v));
const del = (s, id) => tx(s, 'readwrite', (o) => o.delete(id));

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---- tiny event bus ----
const listeners = {};
export const on = (evt, fn) => { (listeners[evt] ||= new Set()).add(fn); };
export const emit = (evt, ...a) => (listeners[evt] || []).forEach((f) => f(...a));

export const samples = new Map(); // id -> metadata (incl. peaks)
export const sources = new Map(); // id -> {id,name,blob,duration,size,created}
const buffers = new Map();        // id -> AudioBuffer

export async function loadAll() {
  (await getAll('samples')).forEach((s) => samples.set(s.id, s));
  (await getAll('sources')).forEach((s) => sources.set(s.id, s));
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
}

export async function saveSource(rec) { sources.set(rec.id, rec); await put('sources', rec); emit('library'); }
export async function deleteSource(id) { sources.delete(id); await del('sources', id); emit('library'); }

export async function saveSample(meta, channels) {
  samples.set(meta.id, meta);
  buffers.delete(meta.id);
  await put('pcm', { id: meta.id, data: channels.map(floatToInt16) });
  await put('samples', meta);
  emit('library'); emit('sample-changed', meta.id);
}
export async function deleteSample(id) {
  samples.delete(id); buffers.delete(id);
  await del('samples', id); await del('pcm', id);
  emit('library');
}
export async function getSamplePcm(id) {
  const rec = await get('pcm', id);
  return rec ? rec.data.map(int16ToFloat) : null;
}
export async function getBuffer(id) {
  if (buffers.has(id)) return buffers.get(id);
  const meta = samples.get(id); if (!meta) return null;
  const pcm = await getSamplePcm(id); if (!pcm) return null;
  const b = makeBuffer(pcm, meta.sr);
  buffers.set(id, b);
  return b;
}

// ---- projects ----
export const listProjects = async () => (await getAll('projects')).sort((a, b) => b.updated - a.updated);
export const getProject = (id) => get('projects', id);
export const saveProject = (p) => { p.updated = Date.now(); return put('projects', p); };
export const deleteProject = (id) => del('projects', id);
