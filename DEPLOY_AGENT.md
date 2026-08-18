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

Do not redeploy an older cached copy. The checkout must include at least these files:

- `scheduler/scheduler_server.py`
- `scheduler-ui.js`
- `scheduler-ui.css`
- `library-browser.js`
- `library-browser.css`
- `radio-dnd.js`
- `radio-polish.css`
- `final-fixes.css`
- `deploy/owntone-dashboard-scheduler.service`

## 2. Install the scheduler service

The scheduler is intentionally tiny: Python standard library only, no pip/Node/Docker dependencies. It runs locally on `127.0.0.1:3691`, stores persistent rules in `/var/lib/owntone-dashboard/schedules.json`, and calls OwnTone on `127.0.0.1:3689`.

```bash
install -m 0644 /opt/owntunedashboard/deploy/owntone-dashboard-scheduler.service \
  /etc/systemd/system/owntone-dashboard-scheduler.service
systemctl daemon-reload
systemctl enable --now owntone-dashboard-scheduler.service
systemctl --no-pager --full status owntone-dashboard-scheduler.service
```

The service uses `TZ=Europe/Belgrade`. Confirm:

```bash
curl -fsS http://127.0.0.1:3691/health
```

Expected: JSON with `"ok": true` and no fatal `last_error`.

## 3. Update nginx reverse proxy

The dashboard is served on port `3690`. Preserve the working existing server block, but make sure it contains the `/scheduler/` proxy from `deploy/nginx.conf`:

```nginx
location /scheduler/ {
    proxy_pass http://127.0.0.1:3691/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    add_header Cache-Control "no-store" always;
}
```

If the current nginx dashboard file is already an exact deployment of `deploy/nginx.conf`, replace it with the new version. Otherwise merge only the missing scheduler location and preserve the current working settings.

Then:

```bash
nginx -t && systemctl reload nginx
```

Verify both proxied backends:

```bash
curl -fsS http://127.0.0.1:3690/api/library >/dev/null
curl -fsS http://127.0.0.1:3690/scheduler/health
```

## 4. Verify OwnTone folder browsing API

The dashboard now has **Folders** under Library and uses OwnTone's native `/api/library/files` endpoint. Do not scan the filesystem directly from browser code.

```bash
curl -fsS 'http://127.0.0.1:3689/api/library/files' | head -c 1000
```

Open at least one returned directory and verify it returns subdirectories/tracks:

```bash
curl -G -fsS 'http://127.0.0.1:3689/api/library/files' \
  --data-urlencode 'directory=/media/music' | head -c 1500
```

If `/media/music` is not the directory returned by the API, use the actual returned directory. Do not change OwnTone's configured library path merely to make this test match the example.

## 5. Browser functional tests

Open the dashboard through its normal LAN URL (currently `http://192.168.1.15:3690`, or the existing proxied dashboard URL if deployment maps it differently).

Hard reload once. `config.js` includes cache-busted extension assets, so subsequent releases should not require manual cache clearing.

Test all of the following:

1. **Music / Radio toggle** still works.
2. HomePod/AirPlay output is still listed and selectable.
3. Radio cards still play and remain draggable; reordered cards keep their slot color.
4. Radio card title is shown only once, quality pill is readable, and the card border animation is subtle.
5. **Folders** appears under Library on desktop and in mobile navigation.
6. Open Folders, navigate multiple directory levels, use breadcrumbs/back, and play an individual FLAC/MP3 track. Playback must go through OwnTone queue/API, not browser audio.
7. Folder dialog must work in both Music and Radio theme.
8. Clock/**Schedule** button appears in the top bar and Schedule appears in sidebar.
9. Scheduler UI loads playlists, radio presets and AirPlay outputs.
10. Create a temporary rule a few minutes in the future, save it, refresh the browser and confirm it persists.
11. Use **Play now** on that rule and confirm the selected source starts on the selected output at the selected volume.
12. Toggle rule OFF/ON and confirm state persists after refresh.
13. Delete the temporary rule.

## 6. Scheduler API smoke test

```bash
curl -fsS http://127.0.0.1:3690/scheduler/schedules
journalctl -u owntone-dashboard-scheduler.service -n 80 --no-pager
```

A scheduler rule supports:

- start time
- selected weekdays
- Radio or Playlist source
- OwnTone/AirPlay output
- volume 0–100
- shuffle
- optional same-day stop time
- enabled/disabled state
- Play now test

Example intended use:

- Mon–Fri 09:00 → Morning playlist → HomePod → 8%
- Sat–Sun 10:00 → Radio Porto Montenegro → HomePod → 10%

## 7. Resource / regression check

Do not install Node, npm, Docker, a database, Redis, or another web framework. Scheduler must remain the Python standard-library service committed in this repo.

After testing report:

- latest deployed git commit
- `owntone` service: PASS/FAIL
- Plex service: PASS/FAIL
- dashboard HTTP: PASS/FAIL
- folder browsing: PASS/FAIL
- individual folder-track playback: PASS/FAIL
- scheduler service: PASS/FAIL
- scheduler create/edit/toggle/delete: PASS/FAIL
- scheduler Play now: PASS/FAIL
- scheduled real-time trigger: PASS/FAIL
- HomePod output + volume control: PASS/FAIL
- RAM of OwnTone + scheduler while idle
- any console/network errors seen in Safari

If a test fails, diagnose that component only. Do not make broad networking, Plex, Proxmox, or OwnTone library changes to hide the failure.
