// Tiny DOM helpers + shared UI widgets (sheets, toasts, sliders...)
export const $ = (s, r = document) => r.querySelector(s);
export const nav = { go: () => {} }; // set by app.js

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'hidden', 'textContent'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) k.forEach(add);
    else e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return e;
}

const P = {
  play: '<polygon points="7 4 20 12 7 20" fill="currentColor"/>',
  pause: '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  loop: '<path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/>',
  rewind: '<polygon points="19 20 9 12 19 4" fill="currentColor"/><path d="M5 19V5"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  split: '<path d="M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5"/>',
  library: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  wave: '<path d="M2 12h3l2-7 4 14 3-10 2 5 2-2h4"/>',
  tracks: '<rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  save: '<path d="M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
};
export function icon(name, size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
export const iconBtn = (name, label, onclick, cls = '') =>
  h('button', { class: 'icon-btn ' + cls, type: 'button', 'aria-label': label, title: label, onclick, html: icon(name) });

let toastTimer;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function sheet(title, build, { full = false, onClose } = {}) {
  const root = $('#overlay-root');
  const back = h('div', { class: 'backdrop' });
  let closed = false;
  const close = () => { if (closed) return; closed = true; back.remove(); onClose && onClose(); };
  const box = h('div', { class: 'sheet' + (full ? ' full' : ''), role: 'dialog', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h3', {}, title), iconBtn('x', 'Close', close)));
  box.append(build(close));
  back.append(box);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  root.append(back);
  return close;
}

export function confirmBox(title, message, okLabel = 'OK', danger = false) {
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; res(v); } };
    sheet(title, (c) => h('div', { class: 'sheet-body' },
      h('p', { class: 'muted' }, message),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => { fin(false); c(); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { fin(true); c(); } }, okLabel))),
    { onClose: () => fin(false) });
  });
}

export function promptBox(title, value = '', okLabel = 'Save') {
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; res(v); } };
    sheet(title, (c) => {
      const input = h('input', { class: 'text', type: 'text', value, maxlength: 60 });
      const ok = () => { fin(input.value.trim() || null); c(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      setTimeout(() => { input.focus(); input.select(); }, 50);
      return h('div', { class: 'sheet-body' }, input,
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => { fin(null); c(); } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: ok }, okLabel)));
    }, { onClose: () => fin(null) });
  });
}

export function busy(message) {
  const el = h('div', { class: 'busy' }, h('div', { class: 'spinner' }), h('div', {}, message));
  const wrap = h('div', { class: 'backdrop center' }, el);
  $('#overlay-root').append(wrap);
  return { set: (m) => { el.lastChild.textContent = m; }, done: () => wrap.remove() };
}

// ---- form widgets ----
export function slider({ label, min, max, step = 1, value, fmt = (v) => v, onInput, hint }) {
  const out = h('output', {}, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  input.addEventListener('input', () => { const v = +input.value; out.textContent = fmt(v); onInput(v); });
  const el = h('label', { class: 'field' },
    h('span', { class: 'field-top' }, h('span', {}, label), out), input, hint && h('small', { class: 'muted' }, hint));
  return { el, set(v) { input.value = v; out.textContent = fmt(+input.value); } };
}
export function toggle({ label, checked, onChange, hint }) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  input.addEventListener('change', () => onChange(input.checked));
  return {
    el: h('label', { class: 'toggle' }, h('span', {}, h('b', {}, label), hint && h('small', { class: 'muted' }, hint)), input, h('i', { class: 'knob' })),
    set(v) { input.checked = !!v; },
  };
}
export function chips({ options, value, onChange }) {
  const wrap = h('div', { class: 'chips' });
  const render = (v) => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === String(v)));
  options.forEach((o) => wrap.append(h('button', { type: 'button', class: 'chip', 'data-id': o.id, title: o.title || '', onclick: () => { render(o.id); onChange(o.id); } }, o.label)));
  render(value);
  return { el: wrap, set: render };
}

// ---- misc ----
export function fmtTime(t, frac = 2) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(frac).padStart(frac ? 3 + frac : 2, '0')}`;
}
export const fmtDur = (t) => (t < 10 ? t.toFixed(2) : t < 60 ? t.toFixed(1) : fmtTime(t, 0)) + (t < 60 ? ' s' : '');
export function debounce(fn, ms) { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; return d; }
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export const safeName = (s) => (s || 'untitled').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'untitled';
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
