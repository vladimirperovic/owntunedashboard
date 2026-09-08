# Deployment

The dashboard is static files plus a Python companion and a separate updater API.
The common installer validates a release, migrates operator data, replaces the
release, restarts services and restores the previous files on catchable failures.

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
`git archive HEAD`, uploads through unique staging directories, and invokes the
same installer used by the update button. Your host and container id live in
`deploy/deploy.local.conf`, which is gitignored; copy
`deploy/deploy.local.conf.example` to start.

The installer accepts either no arguments (download GitHub main) or
`--archive /absolute/release.tar.gz FULL_SHA` (offline/manual transport). Both
paths share the host lock, archive validation, configuration preservation,
activation, service checks and rollback. Manual archives must contain the
single prefix `owntunedashboard-FULL_SHA/`, as produced by `deploy.sh`.
The helper also supports a first installation, but nginx's site must be enabled
as described below. A manual deployment intentionally installs the supplied
archive even when its SHA matches the installed version.

### Operator configuration

The first upgrade from a release predating external configuration **must use the
new `deploy.sh` from a commit containing this installer**, or invoke that new
installer directly with a prefixed archive. An already-installed older update
helper cannot run a migration it does not contain. Do this migration before
using the update button for subsequent releases.

The default persistent layout is:

```text
/etc/owntone-dashboard/config.json       public browser overrides
/etc/owntone-dashboard/artwork/          public custom artwork
/etc/owntone-dashboard/scheduler.env     optional companion environment
/etc/owntone-dashboard/update-api.env    optional updater API environment
/etc/owntone-dashboard/installer.env     optional systemd installer environment
/var/lib/owntone-dashboard/              schedules, history and runtime state
```

Example browser overrides:

```json
{
  "preferredOutput": "Living room",
  "nightSafeMaxVolume": 6,
  "radioArtwork": { "Local Radio": "/site-assets/local.svg" }
}
```

The loader fetches `site-config.json` with cache disabled before starting any
application modules. Invalid, unknown or unreadable settings produce a visible
configuration error and block startup. Arrays replace defaults; artwork/quality
maps merge by key. The empty tracked `site-config.json` supports static previews
and checkouts. Installed releases replace it with a link to the external file;
`site-assets` links only the artwork directory, not the environment files.
Custom nginx policies must allow those two installer-owned links and keep the
external directory readable by the web-server user.

On first migration the installer parses the legacy `window.OWNTONE_DASHBOARD`
literal without executing JavaScript, copies `station-logos` and rewrites its
configured URLs. Existing external settings/assets are never overwritten.
JavaScript expressions in the legacy settings, invalid JSON and linked artwork
require manual conversion before activation. Migration is additive: if later
activation fails, the copied external data remains available and the previous
release and installed service files are restored. Keep external data in backups
alongside schedules/history; it is deliberately not part of release rollback.
If the restored legacy settings or artwork are edited before a retry, the
migration record detects the change and stops activation. Reconcile those edits
with the external JSON/artwork, then remove `.legacy-migration.json` to acknowledge
the reconciliation before retrying. Existing external data is never silently
replaced by either version.

Set service overrides in the optional EnvironmentFiles or use `systemctl edit`.
Changes to library directories still require matching `ReadWritePaths` in a
drop-in. Existing customized units/nginx files are preserved, so merge the new
`EnvironmentFile` lines into older customized units manually. Keep frontend and
companion radio/night settings aligned; scheduled playback retains its explicit
night-cap opt-in.

The installer's `OWNTONE_SITE_DIR`, `OWNTONE_DASHBOARD_STATE` and
`OWNTONE_DASHBOARD_TARGET` overrides support nondefault host layouts. When
invoking the installer directly, pass the same environment as the systemd job;
the systemd-only `installer.env` is not a shell script and is not sourced by a
manual invocation. The Proxmox wrapper uses the default site/state locations
and its configured `TARGET_DIR`.

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
