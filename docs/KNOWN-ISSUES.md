# Known issues — OwnTone Dashboard

Reviewed 2026-08-24. Everything below is either open or explains a decision.
Items fixed in the cleanup pass are listed at the bottom for reference.

## Open

1. **`/scheduler/` is unauthenticated on the LAN** (port 3690 via nginx).
   Anyone on the network can create or delete schedules and start playback, and
   scheduler playback intentionally bypasses the night cap. The service itself
   binds to `127.0.0.1:3691`; nginx is what exposes it. Deliberate for a home
   network — add `auth_basic` or an `allow`/`deny` block to the site config
   before exposing it any further.

2. **No CSRF protection on the companion service.** `_body()` parses JSON
   without checking `Content-Type`, so a POST from any page the browser happens
   to be on is a "simple request" and skips the CORS preflight. Practical
   effect: a website could start radio in the house. `PUT` and `DELETE` are
   protected by preflight. The fix is small — require
   `Content-Type: application/json` and check `Origin` — and belongs with the
   authentication work above.

3. **Stream health probes follow redirects.** `stream_alive()` and
   `probe_radio()` fetch URLs read from playlist files, and `urlopen` follows
   3xx, so a station URL can point the server at an internal address. Bounded by
   `URL_RE` (http/https only) and by the station having to exist in OwnTone.

4. **`probe_radio` reads only 768 bytes with `Connection: close`.** Some servers
   hold the connection until the 5 s timeout, which inflates the reported
   latency. Cosmetic.

5. **`outputName` label fight.** `app.js renderPlayer` writes the selected
   output name; `context-multiroom syncGroupLabel` (1.8 s interval) writes
   "N outputs" for the same multi-room case. Cosmetic flicker.

6. **Kicker flicker.** `renderMode` sets the kicker from the view mode; the
   live-polish interval corrects it within 500 ms when a file is playing. One
   frame after a mode toggle.

7. **Ten independent timers**, from 500 ms to 120 s, with no shared schedule.
   Only `app.js`, `live-playback-polish.js` and `screensaver.js` check
   `document.hidden`, so the rest keep running — and a few keep fetching — while
   the tab is in the background.

## Fixed in the 2026-08-24 cleanup

Kept here so the history is legible; see the commits for detail.

- `renderQueue` read `current` from `loadQueue`'s scope. Under `'use strict'`
  that threw, and the catch turned it into "Queue unavailable — current is not
  defined". The "Queue is empty" branch was unreachable.
- Favourite stations duplicated on every Refresh, because `renderRadio` rebuilt
  only `#radioGrid` while `#radioFavoritesGrid` kept the previous render's nodes.
- Night safety existed four times over, and the two `window.fetch` patches did
  not cover the history drawer, which built its requests on a pre-patch copy of
  `fetch`. One of the copies raised the volume instead of capping it. There is
  one rule and one playback entry point now.
- The sidebar's "Recently played" played "Random 500".
- The output `<select>` was rebuilt on every 3 s poll, which closes a native
  picker under the user's finger on iOS.
- Demo mode rescheduled a no-op poll every 3 s for the lifetime of the tab.
- The HomeKit switch state lived in memory: wrong after a restart, and never
  updated by a scheduled run. It is read from OwnTone's live state now.
- The scheduler loop wrote a fifteen-second-old copy of the runtime state back,
  dropping activity entries and the sleep output id.
- Schedules were built on a fixed UTC offset, so they shifted by an hour across
  a DST change.
- `do_GET` had no error handling; one malformed `schedules.json` closed the
  connection with no response.
- `deploy.sh` printed "Packaging HEAD" while tarring the working tree, and ran
  `rm -rf` on a path taken unchecked from a config file.
- On a phone the sleep button rendered 296×290, and the topbar pushed `<body>`
  to 433px inside a 390px viewport.
- 752 `!important` declarations, replaced by cascade layers.
- Station names, time zone and library paths were hardcoded in shared code.
