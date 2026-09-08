# Known issues — OwnTone Dashboard

Reviewed 2026-09-08. Everything below is either open or explains a decision.
Items fixed in the cleanup pass are listed at the bottom for reference.

## Open

1. **`/scheduler/` is unauthenticated on the LAN** (port 3690 via nginx).
   Anyone on the network can create or delete schedules and start playback, and
   scheduler playback intentionally bypasses the night cap. The service itself
   binds to `127.0.0.1:3691`; nginx is what exposes it. Deliberate for a home
   network — add `auth_basic` or an `allow`/`deny` block to the site config
   before exposing it any further.

2. **Legacy installations need the new migration-capable installer once.**
   Browser overrides and custom artwork now live outside releases. The old
   installed updater cannot migrate them: first upgrade with the new manual
   deployment/common installer. See [migration instructions](DEPLOYMENT.md#operator-configuration).
   Existing custom units must merge the new optional EnvironmentFile lines.

3. **Private radio probes require an explicit trusted host.** Public-address
   validation now applies to every stream probe and redirect. For an intentional
   LAN stream, configure `OWNTONE_STREAM_TRUSTED_HOSTS` as a comma-separated list
   of exact hostnames/IPs (no schemes or ports). Redirect targets need their own
   entry. This trust is limited to administrator configuration.

4. **Custom nginx configurations need the public Host including its port.** The
   bundled proxy now forwards `Host $http_host` to the scheduler. Existing custom
   nginx files are preserved by the updater; merge this change manually when
   using a nondefault dashboard port so same-origin validation can succeed.
   For HTTPS/default-port proxy deployments set `OWNTONE_SCHEDULER_ORIGIN`
   explicitly, e.g. `https://music.example.com`.

5. **Some UI timers remain.** Major player/history/queue-preview/radio-health
   polling and sleep/statistics pollers pause while hidden, and several now avoid
   overlapping requests. Small DOM timers and the open queue drawer still use
   their own schedules. Opted-in desktop notifications continue polling intentionally. A full event-driven rewrite is deferred.

6. **Hardware and production-service validation is still required.** Mock API
   tests cannot prove HomePod pairing, actual audio, Linux service restarts or
   physical iOS behavior. See `DEPLOYMENT.md` for the manual checklist.

7. **Uncatchable interruptions.** The common installer uses
   two directory renames; power loss or SIGKILL in between requires manual
   recovery from the rollback tree. Manual deployment now uses the same lock,
   validation and recovery implementation as the updater, with unique upload
   directories. External operator data is additive and survives rollback.

## Fixed in the 2026-09-08 audit

See [the detailed audit](AUDIT-2026-09-08.md) for findings, tests and limits.

- Resume, zero-volume and combined browser/AirPlay playback now use the shared
  volume guard; playback stops before the queue request if volume setup fails.
- Search, folder, playlist, album, sleep and favorite responses cannot replace
  more recent state. Repeated playlist renders no longer accumulate handlers.
- Left/right arrow shortcuts seek; editable text is respected by mute shortcuts.
- Dynamic numeric HTML fields are escaped or normalized before rendering.
- The companion validates mutation origins, JSON media types and request
  framing, and serializes playback/file mutations. Temporary writes are unique
  and playlist permissions remain readable by OwnTone.
- Overnight stops, DST transitions, stale ramps and malformed persisted state
  have dedicated regression coverage.
- Radio probes validate public destinations and redirects, pin the resolved
  socket address, and read available bytes without waiting for a full block.
- Updater failures restore the release plus installed configuration, including
  the helper executable; incomplete rollback is reported honestly. Archives,
  hashes, health payloads and concurrent invocations are validated.
- Header/output labels now have consistent rules; the kicker follows the actual
  playing source rather than the selected library view.

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
