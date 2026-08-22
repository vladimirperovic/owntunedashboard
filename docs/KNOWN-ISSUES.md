# Known issues — owntunedashboard

Review 2026-08-21. Items marked FIXED are deployed; others are tracked.

## Playback source / view-mode logic

1. **`state.mode` never returns to `music` through playback paths** — FIXED 2026-08-21
   - Only `toggleMode()` (manual) and the demo branch set `mode='music'`.
     Album/playlist/search/history/folder playback while stuck in radio view kept
     the radio presentation (LIVE NOW kicker, ON AIR panel showing the song as a
     station, disabled seek, hero station label).
   - Fix: `playUri()` syncs mode from URI kind (radio playlist vs everything
     else); `OWNTONE_PLAY_URI` no longer forces radio; history drawer and folder
     browser call `OWNTONE_SYNC_PLAYBACK_MODE` after starting playback.

2. **`renderLiveText` showed any current item as a "station" while browsing
   radio view** — FIXED 2026-08-21
   - Panel now keys off `isRadioCurrent(item)` (actual stream) instead of view mode.

3. **Progress/seek gated on view mode instead of content** — FIXED 2026-08-21
   - `progressRange.disabled` and `seekTo()` now use `directRadio` /
     `isRadioCurrent(item)` so a local file is seekable even in radio view.

4. **Stale `currentSource` (sessionStorage `owntone-playing-source`) showed
   "Playing from a radio station" over local files** — FIXED 2026-08-21
   - `inferSource()` ignores a cached radio kind when the playing item is not
     live; live detection runs before the cache return.
   - Remaining nit: paths that bypass `writeSource` (history drawer, folder
     browser) can still leave a stale non-radio label (e.g. "Search"). Cosmetic.

5. **`live-playback-polish` else-branch respected `radio-mode` for the kicker**
   — FIXED 2026-08-21 (earlier)
   - Kicker is now always `NOW PLAYING` when the current item is not a stream.

## Smaller tracked issues (not yet fixed)

6. **Double night-cap fetch wrappers** — `playback-tools.js` and
   `context-multiroom.js` both wrap `window.fetch` for `playback=start`; during
   night hours two redundant volume PUTs fire per playback start. Chain order
   depends on script load order. Harmless but fragile; merge into one wrapper.

7. **`outputName` label fight** — `app.js renderPlayer` writes the single
   selected output name; `context-multiroom syncGroupLabel` (1.8 s interval)
   writes "N outputs" for the same multi-room case. Cosmetic flicker.

8. **Radio cards are born "LIVE"** — `renderRadio` template hardcodes
   `data-status="live">LIVE<` before `radio-dnd` replaces it with CHECKING.
   Brief false LIVE flash on load.

9. **`/scheduler/` API is unauthenticated on the LAN** (port 3690 via nginx).
   Anyone on the LAN can create/delete schedules and start playback; scheduler
   playback intentionally bypasses the night cap. Add auth if ever exposed
   beyond the home LAN.

10. **`manifest.webmanifest` theme_color (#f0e8de) differs from the HTML
    meta theme-color (#f2ece4)**. Cosmetic.

11. **`probe_radio` reads only 768 bytes with `Connection: close`** — some
    servers hold the connection until the 5 s timeout, inflating reported
    latency. Cosmetic.

12. **Queue swipe-to-delete lacks `setPointerCapture`** — FIXED 2026-08-21
    — swipe now captures the pointer so moving off the row no longer
    aborts the gesture.

13. **Kicker flicker** — `renderMode` sets the kicker from view mode; the
    live-polish interval corrects it within 500 ms when a file is playing.
    One-frame flicker possible after mode toggles.
