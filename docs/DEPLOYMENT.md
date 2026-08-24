# Deployment

The dashboard is static files plus one Python service. Nothing is compiled, so
"deploying" means copying the checkout and restarting one systemd unit.

The reference setup is an LXC container that already runs OwnTone, but nothing
here depends on that — any Linux host with OwnTone, nginx and Python 3.11+ works.

Node and Playwright are development dependencies only. **Do not install Node on
the host that serves the dashboard.**

## 1. Files

Put the checkout wherever you like; the examples use `/opt/owntone-dashboard`.

```bash
cd /opt/owntone-dashboard
git fetch origin
git checkout main
git pull --ff-only origin main
git log -1 --oneline
```

Assets are cache-busted from the `BUILD` constant in `config.js`, so a browser
that already has the old files picks up the new ones on the next load. Bump
`BUILD` when you change anything under a `?v=` URL.

`deploy/deploy.sh` automates the copy for a Proxmox host — it packages
`git archive HEAD`, pushes it into the container, installs the unit and the
nginx site, and polls the health endpoint. Your host and container id live in
`deploy/deploy.local.conf`, which is gitignored; copy
`deploy/deploy.local.conf.example` to start.

## 2. Companion service

Standard library only. It listens on `127.0.0.1:3691` and provides schedules,
listening history, statistics and server-side radio health probes. State lives
under `/var/lib/owntone-dashboard/`.

```bash
install -m 0644 /opt/owntone-dashboard/deploy/owntone-dashboard-scheduler.service \
  /etc/systemd/system/owntone-dashboard-scheduler.service
systemctl daemon-reload
systemctl enable --now owntone-dashboard-scheduler.service
systemctl --no-pager --full status owntone-dashboard-scheduler.service
curl -fsS http://127.0.0.1:3691/health
```

Health returns `ok`, `service`, `timezone`, `history_count` and `last_error`.
`last_error` should be `null`.

Review the `Environment=` lines in the unit before enabling it — the two
library directories and the night-cap hours. If you change
`OWNTONE_STATIONS_DIR` or `OWNTONE_PLAYLISTS_DIR`, change `ReadWritePaths` to
match: `ProtectSystem=strict` makes everything else read-only, and writes would
otherwise fail with `EROFS`.

Schedules run in local time. The service reads the host's zone from
`/etc/timezone` or `/etc/localtime` and logs which one it chose:

```
[time] schedules use Europe/Berlin (from the host)
```

`/health` reports the same value. Set `TZ` in the unit only if you need to pin
it — for instance in a container that does not carry the host's zone. If neither
can be resolved the service says so and falls back to UTC, which will run your
schedules at the wrong hour.

## 3. nginx

The dashboard is served on port `3690`, and the same server block proxies
`/api`, `/artwork`, `/stream.mp3`, `/owntone-events` and `/scheduler` so the
browser sees one origin.

```bash
cp deploy/nginx.conf /etc/nginx/sites-available/owntone-dashboard
ln -sf ../sites-available/owntone-dashboard /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
curl -fsS http://127.0.0.1:3690/api/library >/dev/null
curl -fsS http://127.0.0.1:3690/scheduler/health
```

> The `/scheduler/` API has no authentication. The service binds to localhost,
> but this proxy exposes it to the whole network — anyone on the LAN can create
> schedules and start playback. Add `auth_basic` or an `allow`/`deny` block
> before exposing it any further. See [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

## 4. Verifying a deployment

Automated coverage runs from a development machine, not the server:

```bash
npm ci
npx playwright install chromium
npx playwright test                                       # desktop + mobile UI
python3 -m unittest discover -s scheduler -p 'test_*.py'  # companion logic
```

What the tests cannot check, because it needs real speakers and a real library:

**Playback**

- Album, playlist, folder track, search result and radio each start playback
  once per click.
- Play, pause, previous, next and seek work for local files; previous/next are
  disabled for a live stream.
- Switching AirPlay output moves audio and the volume slider follows.
- Between the configured night hours, manual playback is capped to
  `nightSafeMaxVolume` before audio starts. Scheduler rules are exempt unless
  the rule opts in.

**Queue and history**

- The queue drawer lists current and upcoming items; reorder and delete work on
  desktop and swipe-delete works on a phone.
- History persists across a companion restart, and replaying an entry works.

**Radio**

- Each card starts at `CHECKING` and resolves to `LIVE` or `OFFLINE` from the
  server-side probe.
- Pinning a favourite moves the card, and it survives a library Refresh without
  duplicating.
- Configured artwork appears; stations without it keep the generated monogram.

**Scheduler**

- Create a rule a few minutes ahead, confirm it fires, then delete it.
- A rule with a stop time stops playback at that time.

```bash
curl -fsS http://127.0.0.1:3690/scheduler/schedules
curl -fsS 'http://127.0.0.1:3690/scheduler/history?limit=5'
journalctl -u owntone-dashboard-scheduler.service -n 100 --no-pager
```

## Notes

- Folder browsing goes through OwnTone's `/api/library/files`. Browser code
  never touches the filesystem.
- Radio health probes ask OwnTone for the playlist's track and probe that URL
  server-side, so stream URLs are never hardcoded in the dashboard.
- Safari caches aggressively; a hard reload after deploying saves confusion if
  you forgot to bump `BUILD`.
