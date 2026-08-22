# Deploy / upgrade checklist for the Plex + OwnTone LXC

Target host is the existing Plex/OwnTone LXC (`<your-owntone-lxc>`). Do not create a new container and do not modify Plex media, Plex database, OwnTone library paths, or the existing `/media/music` mount unless a test proves something is broken.

## 1. Update dashboard code

The dashboard checkout is expected at `/opt/owntunedashboard`.

```bash
cd /opt/owntunedashboard
git fetch origin
git checkout main
git pull --ff-only origin main
git log -1 --oneline
```

Do not redeploy an older cached copy. The current UI is cache-busted from `config.js` and should include at least:

- `design-system.css`
- `design-enhancements.js`
- `premium-experience.css` / `premium-experience.js`
- `station-logos/`
- `scheduler/scheduler_server.py`
- `scheduler-ui.js` / `scheduler-ui.css`
- `library-browser.js` / `library-browser.css`
- `radio-dnd.js` / `radio-polish.css` / `radio-features.css`
- `playback-tools.js` / `playback-tools.css`
- `night-safety-history.js`
- `mute-control.js` / `mute-control.css`
- `deploy/owntone-dashboard-scheduler.service`

`package.json`, Playwright and Node are test/CI dependencies only. Do **not** install Node/npm on the production LXC.

## 2. Companion scheduler service

The companion remains Python standard-library only. It runs on `127.0.0.1:3691` and provides schedules, persistent Now Playing history and server-side radio health probes. Data is stored under `/var/lib/owntune-dashboard/`.

```bash
install -m 0644 /opt/owntunedashboard/deploy/owntone-dashboard-scheduler.service \
  /etc/systemd/system/owntone-dashboard-scheduler.service
systemctl daemon-reload
systemctl enable owntone-dashboard-scheduler.service
systemctl restart owntone-dashboard-scheduler.service
systemctl --no-pager --full status owntone-dashboard-scheduler.service
curl -fsS http://127.0.0.1:3691/health
```

Expected health response contains `"ok": true`, `"service": "owntone-dashboard-companion"`, a `history_count` field and no fatal `last_error`.

## 3. Nginx / dashboard HTTP

The dashboard is served on port `3690`. Preserve the working server block and the `/scheduler/` proxy from `deploy/nginx.conf`.

```bash
nginx -t && systemctl reload nginx
curl -fsS http://127.0.0.1:3690/api/library >/dev/null
curl -fsS http://127.0.0.1:3690/scheduler/health
```

Hard reload Safari once after deployment so the new asset build key is picked up.

## 4. Desktop + mobile UI regression

Before LAN playback testing, verify the UI on desktop Safari and iPhone/Safari:

1. No horizontal scrolling at normal desktop width or 390 px mobile width.
2. Bottom navigation has five items and active state follows the visible section.
3. Mobile mini-player appears after scrolling below the hero and its play/pause control works.
4. Hero artwork opens the fullscreen Now Playing view; close, previous, play/pause and next remain reachable.
5. `Playing from` reflects album / playlist / radio / history context.
6. Track-details sheet opens and shows available metadata; lyrics appear only when metadata provides them.
7. AirPlay output opens the custom output sheet; selecting an output updates the real OwnTone output and the volume slider remains synchronized.
8. Recently Played rail renders without pushing the page wider than the viewport.
9. Album info opens the detail sheet with tracklist plus Play, Shuffle and Add to queue.
10. Desktop >=1180 px shows the compact Up Next column; it is hidden on phone/tablet layouts.
11. Radio cards show local station identities/logos where configured, with generated identity fallback for unknown stations.
12. Contextual artwork tint remains subtle and does not reduce text contrast.

Automated browser regression lives in `tests/ui-smoke.spec.js` and exercises desktop `1440x1000` and mobile `390x844`. It is a development/CI test and does not require Node on the production LXC.

## 5. Folder browsing

The dashboard uses OwnTone `/api/library/files`; do not scan the filesystem directly from browser code.

```bash
curl -fsS 'http://127.0.0.1:3689/api/library/files' | head -c 1000
```

Verify at least one real music directory, then test folder navigation and individual FLAC playback in Safari.

## 6. Playback, Queue, History and Night Safe

Test against the real selected AirPlay output:

1. Album, playlist, folder track, search result and radio playback each start only once per click.
2. Play / pause / previous / next and seek work for normal music.
3. Queue drawer shows current/upcoming items; reorder and delete work on desktop, swipe-delete works on iPhone.
4. Desktop mini queue follows the real OwnTone queue and its button opens the full queue drawer.
5. History persists through the companion service and a history item can be played again.
6. Between 00:00 and 08:00 manual dashboard playback is capped to max 8% before playback starts. Scheduler rules are intentionally exempt.
7. Add to queue from Album Details appends without clearing current playback.

Useful checks:

```bash
curl -fsS 'http://127.0.0.1:3690/scheduler/history?limit=5'
curl -fsS 'http://127.0.0.1:3689/api/queue?start=0&end=20'
```

## 7. Radio favorites, identities and health

Test every radio card:

- Heart pin/unpin works and Favorites are partitioned before regular stations.
- There is no second/direct radio playback handler in `radio-dnd.js`; `app.js` owns the playback action.
- Each card starts at `CHECKING`, then resolves to `LIVE` or `OFFLINE` from the server-side health probe.
- Quality pill remains visible and may be refined by configured or detected codec/bitrate.
- Configured station artwork is local under `station-logos/`; unknown stations keep the generated identity.

Test one real radio playlist ID returned by OwnTone:

```bash
curl -fsS 'http://127.0.0.1:3689/api/library/playlists?limit=500' | head -c 2500
curl -fsS 'http://127.0.0.1:3690/scheduler/radio-health?playlist_id=REPLACE_WITH_ID&force=1'
```

Do not hardcode stream URLs into dashboard health code. The companion asks OwnTone for the playlist track and probes that URL server-side.

## 8. Scheduler

Schedule UI must continue to support start time, weekdays, Radio/Playlist source, AirPlay output, volume, shuffle, optional stop time, enable/disable and Play now.

```bash
curl -fsS http://127.0.0.1:3690/scheduler/schedules
journalctl -u owntone-dashboard-scheduler.service -n 100 --no-pager
```

Create one temporary rule a few minutes ahead, verify the real-time trigger, then delete it.

## 9. Final production report

Report:

- latest deployed git commit
- Plex: PASS/FAIL
- OwnTone API: PASS/FAIL
- dashboard HTTP: PASS/FAIL
- desktop Safari UI: PASS/FAIL
- iPhone/Safari UI: PASS/FAIL
- HomePod playback + volume + output switching: PASS/FAIL
- folder browsing + FLAC playback: PASS/FAIL
- scheduler: PASS/FAIL
- Queue drawer list/reorder/delete/swipe: PASS/FAIL
- desktop mini queue: PASS/FAIL
- Now Playing history persistence/replay: PASS/FAIL
- Night Safe 00:00–08:00 max 8%: PASS/FAIL
- album details Play/Shuffle/Add queue: PASS/FAIL
- fullscreen Now Playing: PASS/FAIL
- radio favorites/pinning + local station identity: PASS/FAIL
- radio health LIVE/OFFLINE: PASS/FAIL
- Safari desktop/mobile console errors
- RAM of OwnTone + companion service while idle

If a test fails, diagnose that component only. Do not make broad networking, Plex, Proxmox or OwnTone library changes to hide the failure.
