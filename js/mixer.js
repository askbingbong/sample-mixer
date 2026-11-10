// Project model + audio scheduling. The same scheduler drives live playback
// (AudioContext) and the WAV export (OfflineAudioContext).
import { uid } from './store.js';

export const TRACK_COLORS = ['#7c5cff', '#2ee6a6', '#ff6b8b', '#ffb84d', '#4dc3ff', '#c778ff', '#9be15d', '#ff8a5c'];

export function newProject(name = 'My first track') {
  return {
    id: uid(), name, bpm: 100, loop: false, updated: Date.now(),
    tracks: Array.from({ length: 4 }, (_, i) => newTrack(i)),
    clips: [], // {id, trackId, sampleId, start(beats), len(beats), off(seconds into sample), gain}
  };
}
export const newTrack = (i) => ({ id: uid(), name: 'Track ' + (i + 1), color: TRACK_COLORS[i % TRACK_COLORS.length], vol: 0.9, mute: false, solo: false });

export const songEndBeat = (p) => p.clips.reduce((m, c) => Math.max(m, c.start + c.len), 0);
export const trackAudible = (p, t) => !t.mute && (!p.tracks.some((x) => x.solo) || t.solo);

/**
 * Schedule every clip on `ctx`, routed into `dest`.
 * `base` = ctx time at which `fromBeat` is heard.
 * Returns {nodes, trackGain} so callers can stop playback / change mutes live.
 */
export function scheduleProject(ctx, dest, project, buffers, fromBeat, base) {
  const spb = 60 / project.bpm, fromSec = fromBeat * spb;
  const trackGain = new Map(), nodes = [];
  for (const t of project.tracks) {
    const g = ctx.createGain();
    g.gain.value = trackAudible(project, t) ? t.vol : 0;
    g.connect(dest); trackGain.set(t.id, g);
  }
  for (const clip of project.clips) {
    const buf = buffers.get(clip.sampleId), tg = trackGain.get(clip.trackId);
    if (!buf || !tg || buf.duration < 0.005) continue;
    const cs = clip.start * spb, cd = clip.len * spb;
    if (cs + cd <= fromSec + 1e-6) continue;
    const vol = clip.gain ?? 1;
    let t = Math.max(0, fromSec - cs);
    const startAt = base + (cs + t - fromSec), endAt = base + (cs + cd - fromSec);
    const g = ctx.createGain(); g.connect(tg);
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(vol, startAt + 0.003);
    g.gain.setValueAtTime(vol, Math.max(startAt + 0.003, endAt - 0.004));
    g.gain.linearRampToValueAtTime(0, endAt);
    while (t < cd - 1e-4) {
      const pos = ((clip.off || 0) + t) % buf.duration;
      const run = Math.min(buf.duration - pos, cd - t);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(g);
      src.start(base + (cs + t - fromSec), pos, run);
      nodes.push(src); t += run;
    }
  }
  return { nodes, trackGain };
}

export function updateTrackGains(project, trackGain) {
  for (const t of project.tracks) { const g = trackGain.get(t.id); if (g) g.gain.value = trackAudible(project, t) ? t.vol : 0; }
}
