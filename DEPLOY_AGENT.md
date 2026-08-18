# Deploy / upgrade checklist for the Plex + OwnTone LXC

Target host is the existing Plex/OwnTone LXC (`192.168.1.15`). Do not create a new container and do not modify Plex media, Plex database, OwnTone library paths, or the existing `/media/music` mount unless a test proves something is broken.

## 1. Update dashboard code

The dashboard checkout is expected at `/opt/owntunedashboard`.

```bash
cd /opt/owntunedashboard
git fetch origin
git checkout main
git pull --ff-only origin main
git log -1 --oneline
```

Do not redeploy an older cached copy. The checkout must include at least:

- `scheduler/scheduler_server.py`
- `scheduler-ui.js` / `scheduler-ui.css`
- `library-browser.js` / `library-browser.css`
- `radio-dnd.js` / `radio-polish.css` / `radio-features.css`
- `playback-tools.js` / `playback-tools.css`
- `night-safety-history.js`
- `mute-control.js` / `mute-control.css`
- `final-fixes.css`
- `deploy/owntone-dashboard-scheduler.service`

## 2. Install or restart the companion scheduler service

The service is Python standard-library only. It runs on `127.0.0.1:3691` and now provides scheduler, persistent Now Playing history and server-side radio health probes. Data is stored under `/var/lib/owntone-dashboard/`.

```bash
install -m 0644 /opt/owntunedashboard/deploy/owntone-dashboard-scheduler.service \
  /etc/systemd/system/owntone-dashboard-scheduler.service
systemctl daemon-reload
systemctl enable owntone-dashboard-scheduler.service
systemctl restart owntone-dashboard-scheduler.service
systemctl --no-pager --full status owntone-dashboard-scheduler.service
```

The service uses `TZ=Europe/Belgrade`. Confirm:

```bash
curl -fsS http://127.0.0.1:3691/health
```

Expected: `"ok": true`, `"service": "owntone-dashboard-companion"`, a `history_count` field, and no fatal `last_error`.

## 3. Update nginx reverse proxy

The dashboard is served on port `3690`. Preserve the working server block and make sure it contains the `/scheduler/` proxy from `deploy/nginx.conf`:

```nginx
location /scheduler/ {
    proxy_pass http://127.0.0.1:3691/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    add_header Cache-Control "no-store" always;
}
```

Then:

```bash
nginx -t && systemctl reload nginx
curl -fsS http://127.0.0.1:3690/api/library >/dev/null
curl -fsS http://127.0.0.1:3690/scheduler/health
```

## 4. Folder browsing

The dashboard uses OwnTone `/api/library/files`; do not scan the filesystem directly from browser code.

```bash
curl -fsS 'http://127.0.0.1:3689/api/library/files' | head -c 1000
```

Verify at least one real music directory, then test folder navigation and individual FLAC playback in Safari.

## 5. New playback tools

Open the dashboard at its normal LAN URL, hard reload once, and test:

1. The new **Queue** icon opens a right-side drawer.
2. Queue shows the current item plus up to 20 upcoming items.
3. Drag a queued track to a new position and verify OwnTone queue order changes.
4. Delete one queued item with the trash button.
5. On iPhone/Safari, swipe a queue row left and verify removal works.
6. Switch the drawer to **History**. The companion service should retain up to 50 last played local tracks and radio metadata changes even while the browser is closed.
7. Click a History item and confirm it plays again through OwnTone.
8. After midnight and before 08:00, any **manual dashboard playback** must be capped to max **8%** before it starts. This includes albums, playlists, radio, folder tracks, search results and History replay. Scheduler rules are intentionally exempt and retain their configured volume.
9. The audio dock should show the small Night cap indicator during the 00:00–08:00 safety window.

Useful checks:

```bash
curl -fsS 'http://127.0.0.1:3690/scheduler/history?limit=5'
curl -fsS 'http://127.0.0.1:3689/api/queue?start=0&end=20'
```

## 6. Radio favorites and health

Test every radio card:

- Heart pin/unpin works.
- Favorites move before non-favorites; with five or fewer they occupy the first desktop row.
- Manual drag/reorder still works and slot color still belongs to position, not station.
- Each card gets `CHECKING`, then `LIVE` or `OFFLINE` from a server-side health probe.
- Quality pill remains visible; if OwnTone/stream headers expose bitrate, health may refine the quality label.
- An `OFFLINE` card must not immediately start playback; clicking it should re-check the stream.

Test one real radio playlist ID returned by OwnTone:

```bash
curl -fsS 'http://127.0.0.1:3689/api/library/playlists?limit=500' | head -c 2500
curl -fsS 'http://127.0.0.1:3690/scheduler/radio-health?playlist_id=REPLACE_WITH_ID&force=1'
```

Do not hardcode stream URLs into the dashboard health code. The companion asks OwnTone for the first track in the playlist and probes that URL server-side.

## 7. Scheduler

Schedule UI must continue to support start time, weekdays, Radio/Playlist source, AirPlay output, volume, shuffle, optional stop time, enable/disable and Play now.

Smoke test:

```bash
curl -fsS http://127.0.0.1:3690/scheduler/schedules
journalctl -u owntone-dashboard-scheduler.service -n 100 --no-pager
```

Create a temporary rule a few minutes ahead, verify the real-time trigger, then delete it.

## 8. Regression / resource check

Do not install Node, npm, Docker, a database, Redis or another web framework. The companion remains Python standard-library only.

After testing report:

- latest deployed git commit
- Plex: PASS/FAIL
- OwnTone: PASS/FAIL
- dashboard HTTP: PASS/FAIL
- HomePod playback + volume: PASS/FAIL
- folder browsing + FLAC playback: PASS/FAIL
- scheduler: PASS/FAIL
- Queue drawer list/reorder/delete/swipe: PASS/FAIL
- Now Playing history persistence/replay: PASS/FAIL
- Night Safe 00:00–08:00 max 8%: PASS/FAIL
- radio favorites/pinning: PASS/FAIL
- radio health LIVE/OFFLINE: PASS/FAIL
- Safari desktop/mobile console errors
- RAM of OwnTone + companion service while idle

If a test fails, diagnose that component only. Do not make broad networking, Plex, Proxmox or OwnTone library changes to hide the failure.
