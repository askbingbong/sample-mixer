# Sample Mixer

A mobile-friendly, installable, **offline-capable** web app for chopping samples out of songs and arranging them into your own tracks. No server, no accounts, no build step: everything runs and is stored on your device.

## The three parts

| Tab | What it does |
| --- | --- |
| **Library** | Your saved samples (play, rename, duplicate, download as WAV, delete) and the songs you imported. Tap a sample to re-edit it any time. |
| **Sample editor** | Load a song, select a slice, and shape it, then save it to the library. |
| **Track editor** | A multi-track timeline: drop samples on tracks, move/loop/split them, set tempo, mute/solo, then export your song as a WAV. |

### Sample editor tools
- **Trim** – draggable handles, pinch/scroll zoom, overview strip, nudge buttons, quick lengths.
- **Filter** – low-cut / high-cut, 3-band EQ, one-tap presets (bass only, telephone, lo-fi…).
- **Vocals** – *Remove vocals* (centre-channel cancellation) or *Keep only the middle*, with optional bass/cymbal protection. This is a stereo trick, not AI separation: expect leftovers, and use the Filter tab to clean up.
- **Volume** – fades, auto-loudness, gain, reverse, mono.
- **Pitch** – pitch/speed like a record (±12 semitones).
- **A/B** button to compare with the original, **Loop** preview, and a live playhead.

Samples keep a link to their source song and all their settings, so you can reopen one and change *any* setting later (non-destructive). Updating a sample also updates every track that uses it.

### Track editor tips
- Select a track, press **Add**, pick a sample: it lands at the playhead.
- Drag a clip to move it (also between tracks). Drag its **right edge** to trim or make it loop.
- Tap the ruler to move the playhead; **Split** cuts the selected clip at the playhead.
- Changing the BPM moves clips on the grid but keeps each sample's real length (samples aren't time-stretched).
- Undo/redo, multiple projects, autosave. Desktop: `Space` play/pause, `Del` delete, `Ctrl/⌘+Z` undo, `Ctrl/⌘+D` duplicate.

## Run it

It's static files. Any static server works, e.g.:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Service workers (offline mode + installing as an app) need **HTTPS or localhost**. To use it on your phone, host the folder anywhere with HTTPS (GitHub Pages, Netlify, Cloudflare Pages…), open it once while online, then use *Add to Home Screen* / *Install app*. After that it works fully offline.

## Develop

```bash
npm test                    # unit tests for the audio processing (Node 18+, no dependencies)
node tools/make-icons.mjs   # regenerate the PNG icons
```

Layout: `js/dsp.js` (pure DSP: trim, vocal removal, filters, pitch, WAV), `js/store.js` (IndexedDB), `js/mixer.js` (project model + scheduler shared by playback and export), `js/sampleEditor.js`, `js/trackEditor.js`, `js/library.js`, `js/waveform.js`, `sw.js` (offline cache — bump `CACHE` when shipping changes).

## Ideas for later
Tempo detection / beat grid in the sample editor, key-preserving time-stretch, per-clip pitch, a drum step sequencer, mic recording, AI stem separation (e.g. via an on-device model), project import/export.
