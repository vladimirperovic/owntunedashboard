# Backend and deployment architecture

Reviewed 2026-09-08 against the current working tree, including the prior audit's
uncommitted changes. Static review only: no services, network probes, deployments,
tests or Git commands were run. Only this document was written. Frontend event
synchronization and DOM observer measurements remain with the main task.

The architecture is proportionate to a single-host music dashboard. Keep nginx,
OwnTone, the standard-library companion and the separate updater privilege
boundary. The useful next changes concern lock scope and release ownership;
there is no measured justification for microservices, multiple companion workers,
a broker, an async rewrite or a database migration.

## Existing boundaries worth preserving

- nginx serves assets and forwards API, audio and WebSocket traffic directly to
  OwnTone; audio does not pass through Python (`deploy/nginx.conf:18`, `:27`,
  `:38`). Companion throughput is therefore separate from audio throughput.
- The companion combines scheduling, sleep, history, statistics, radio probes
  and library-file management in one process, with two background threads and a
  threaded HTTP server (`scheduler/scheduler_server.py:1681`). This is operationally
  simple, but globals and nested state updates couple these responsibilities.
- The update API runs as `www-data` and queues a request; a separate systemd
  path/oneshot runs the privileged installer (`deploy/update_server.py:130`,
  `deploy/owntone-dashboard-update-api.service:8`,
  `deploy/owntone-dashboard-updater.path:4`,
  `deploy/owntone-dashboard-updater.service:6`). Preserve this split.

## Ranked priorities

1. **Shorten state-lock ownership while preserving playback ordering.**
   `scheduler/scheduler_server.py:1395` takes `PLAYBACK_LOCK`, then enters
   `update_runtime_state` (`:235`), which holds `LOCK` throughout the callback.
   Due schedules perform stream probes and sequential output/volume/queue calls
   inside that callback (`:1339`, `:598`, `:612`); OwnTone requests default to an
   eight-second socket timeout (`:418`). History, schedules and even health reads
   share `LOCK` (`:197`, `:174`, `:1511`). Slow upstream I/O can therefore delay
   unrelated reads, and the next tick starts only after work plus a 15-second
   sleep (`:1411`). This blocking path is established by code; its production
   frequency and latency are unmeasured.

   First measure lock wait/hold time, command duration and schedule lateness.
   Then introduce explicit claim, execute and finalize phases: use short state
   transactions, retain serialized playback commands, and reconcile completion
   against the occurrence ID and schedule revision. Define cancellation and
   restart behavior before releasing the state lock; simply moving calls outside
   it could reintroduce lost updates or stale actions. Likewise move best-effort
   rescan outside `FILES_LOCK` after file mutation (`:1274`, `:1294`, `:567`).
   `PLAYBACK_LOCK` only orders companion callers: direct nginx `/api/` traffic
   and other OwnTone clients remain outside that boundary.

2. **Give manual deploy and updater one activation/recovery implementation.**
   The updater has an OS lock, configuration snapshots and rollback
   (`deploy/update-dashboard.sh:29`, `:109`, `:129`). Manual deploy uses fixed
   remote upload names and a separate activation sequence without that lock;
   recovery covers the second rename, but not later service failures
   (`deploy/deploy.sh:73`, `:96`, `:144`). Both replace the live directory through
   two renames (`deploy/update-dashboard.sh:305`, `deploy/deploy.sh:104`). These
   are the recovery limitations already recorded in the prior audit.

   First make transport/download feed a common installer with one host lock,
   unique staging paths and identical validation/rollback. Next consider
   immutable release directories with an atomically replaced `current` symlink
   and a retained previous target. Both scripts currently reject symlink targets
   (`deploy/update-dashboard.sh:21`, `deploy/deploy.sh:90`), so this requires a
   deliberate layout migration. Pointer replacement alone does not make service
   restarts or configuration changes transactional; retain recovery state and
   verify failure paths with the existing offline updater harness.

3. **Separate operator configuration and mutable assets from releases.**
   State already lives outside the release (`scheduler/scheduler_server.py:34`,
   `:131`). Browser settings, local artwork references and the asset loader share
   `config.js` (`config.js:1`, `:48`, `:58`). Whole-tree activation replaces those
   customizations. Installed service/nginx files are preserved by comparing them
   with previous templates (`deploy/update-dashboard.sh:109`), which also leaves
   operators responsible for merging new defaults.

   Keep shipped templates and loader code versioned; put site overrides in an
   external configuration directory, use systemd drop-ins/EnvironmentFile and
   nginx includes, and serve custom artwork from separate storage. Expose only
   browser-safe settings through a small configuration payload. Generate shared
   radio/night settings from one operator source where semantics overlap
   (`scheduler/scheduler_server.py:62`, `:124`), preserving scheduled playback's
   explicit night-cap opt-in. Validate overrides before activation and retain
   backward-compatible defaults for rollback.

4. **Make persistence and internal ownership explicit before changing storage.**
   JSON writes use unique temporary files and replacement
   (`scheduler/scheduler_server.py:154`); nested runtime mutations join one
   thread-local transaction (`:229`). These are useful single-process guarantees,
   not cross-process locking or a transaction with OwnTone. There is no file or
   directory `fsync` in the writer, and playback occurs before the runtime write
   (`:1351`, `:264`): crash recovery cannot promise exactly-once playback.

   Extract a state store and an injectable OwnTone client first, then separate
   schedule decisions, radio/history work and thin HTTP routing. Keep one
   companion process and explicit lock ownership. Document recovery semantics,
   state format/version and backup/restore; add durability measures if required.
   History writes retain 500 records and activity retains 30 (`:139`, `:203`,
   `:279`), so SQLite is not an established performance need. Revisit it for
   longer retention, measured storage cost or transactional state requirements;
   it would still not make external playback exactly once.

5. **Optimize measured upstream work before increasing concurrency.**
   History samples every capture-duration plus 12 seconds (`:914`), reading
   player and usually queue (`:864`). A radio-map refresh fetches playlists then
   each matching station sequentially (`:753`), cached for 600 seconds (`:142`).
   Health probes cache results for 90 seconds but release the cache lock before
   probing, so concurrent misses can duplicate work (`:821`). These are concrete
   request patterns, not measured saturation.

   Record request counts/durations, map refresh duration, cache hits and duplicate
   in-flight probes under representative use. If duplication matters, share one
   in-flight probe per station; if refresh dominates, use bounded refresh work
   while retaining a timestamped previous map. Consider event-triggered history
   with periodic reconciliation only after measuring sampling cost and defining
   reconnect behavior. Keep statistics over the small retained history (`:288`)
   simple. Do not add companion replicas: each would start its own scheduler,
   and existing locks/caches are process-local (`:134`, `:1687`).

## Staging and evidence gates

First collect baseline timing without changing behavior. Implement configuration
separation and the shared installer as a deployment-focused change. Extract
backend interfaces before changing lock scope, preserving existing API and
schedule semantics. Apply probe/history optimizations only when measurements
identify material redundant work.

For subsequent implementation, retain the existing regression coverage for
nested state updates, playback serialization and offline rollback
(`scheduler/test_scheduler_server.py:360`, `:695`,
`tests/update-dashboard-integration.sh`). Add focused checks for responsive reads
during stalled upstream calls and defined schedule edit/cancel/restart behavior.
Health currently reports stored state rather than verifying OwnTone availability
(`scheduler/scheduler_server.py:1510`); use separate dependency-readiness and tick
freshness signals when measuring reliability. Existing LAN access-control and
hardware-validation limits remain in `docs/KNOWN-ISSUES.md`; this review does not
reopen the security or bug audit.
