window.OWNTONE_DASHBOARD = {
  // Recommended: keep the dashboard and OwnTone behind the same reverse proxy.
  // The included nginx config proxies /api and artwork to OwnTone on localhost:3689.
  apiBase: '/api',
  schedulerBase: '/scheduler',
  demoOnFailure: true,
  pollMs: 3000,
  fallbackPollMs: 15000,
  websocketPath: '/owntone-events',
  websocketReconnectMs: 2500,
  // A playlist counts as a radio station when its file path contains this
  // fragment. This is the reliable signal — prefer it to name matching.
  radioPathHint: '/Radio/',

  // Extra whole-word name fragments that also mark a playlist as a station, for
  // libraries where the stations do not live in one folder. Matching is
  // case-insensitive and on whole words, so 'radio' matches "Rock Radio" but not
  // "Radiohead". Keep this list short: anything here can misread an album
  // playlist as a station. Example: ['radio', 'fm', 'kexp'].
  radioNameHints: ['radio'],

  preferredOutput: 'HomePod',
  browserStreamPath: '/stream.mp3',

  // Normal manual playback volume during the day.
  manualVolume: 50,
  // If the dashboard has never remembered a pre-mute level, unmute restores gently here.
  safeUnmuteVolume: 10,

  // Night safety applies only to manual playback from the dashboard. Scheduler rules keep
  // the exact volume configured in the schedule. From midnight until 08:00 any manual
  // Play action is capped before playback starts, so an accidental tap cannot blast audio.
  nightSafeStartHour: 0,
  nightSafeEndHour: 8,
  nightSafeMaxVolume: 8,

  historyLimit: 50,
  queueLimit: 20,

  // Default folder path when opening the folder browser
  defaultFolderPath: '/media/music/Music',

  // Optional per-station quality labels, keyed by station name. Add verified
  // ffprobe results here when OwnTone's playlist metadata does not expose
  // codec/bitrate. Example: { 'KEXP 90.3': 'MP3 320k' }
  radioQuality: {},

  // Local station artwork, keyed by station name. Stations without an entry get
  // a monogram generated from their name, so this is optional.
  // Drop your own files in station-logos/ — see the README there.
  // Example: { 'KEXP 90.3': 'station-logos/kexp.svg' }
  radioArtwork: {
    'Radio Porto Montenegro': 'station-logos/porto-montenegro.svg',
    'Porto Montenegro': 'station-logos/porto-montenegro.svg',
  },
};

/*
 * Asset loader.
 *
 * Everything is appended from here rather than listed in index.html so the
 * `?v=BUILD` cache buster lives in exactly one place.
 *
 * Order matters and is guaranteed: a dynamically created script defaults to
 * async, and setting `script.async = false` puts it in the browser's
 * "execute in insertion order, as soon as possible" list. So shared.js runs
 * before app.js, and app.js before every feature module.
 *
 * (`script.defer` is deliberately not set — the spec ignores defer on scripts
 * that were not inserted by the HTML parser, so setting it only misleads.)
 */
(() => {
  const BUILD = '20260901-13';
  const asset = path => `${path}?v=${BUILD}`;

  const addStyle = href => {
    if (document.querySelector(`link[data-owntone-style="${href}"]`)) return;
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = asset(href);
    style.dataset.owntoneStyle = href;
    document.head.appendChild(style);
  };

  const addScript = src => {
    if (document.querySelector(`script[data-owntone-script="${src}"]`)) return;
    const script = document.createElement('script');
    script.src = asset(src);
    script.async = false;
    script.dataset.owntoneScript = src;
    document.head.appendChild(script);
  };

  // Stylesheets, in cascade order — styles.css (from index.html) is the base.
  [
    'radio-polish.css',
    'radio-features.css',
    'library-browser.css',
    'scheduler-ui.css',
    'mute-control.css',
    'playback-tools.css',
    'design-system.css',
    'premium-experience.css',
    'context-multiroom.css',
    'production-polish.css',
    'live-playback-polish.css',
    'extras.css',
  ].forEach(addStyle);

  // shared.js and app.js first — every module below depends on both.
  [
    'shared.js',
    'app.js',
    'playback-tools.js',
    'radio-stations.js',
    'library-browser.js',
    'scheduler-ui.js',
    'radio-visualizer.js',
    'mute-control.js',
    'design-enhancements.js',
    'premium-experience.js',
    'browser-output.js',
    'context-multiroom.js',
    'safari-touch-fix.js',
    'live-playback-polish.js',
    'sleep-timer.js',
    'shortcuts.js',
    'browse.js',
    'station-manager.js',
    'stats.js',
    'playlist-editor.js',
    'screensaver.js',
    'notifications.js',
  ].forEach(addScript);

  // Deployed build identity, shown in the sidebar footer (with version.json commit when present).
  window.OWNTONE_DASHBOARD_BUILD = BUILD;
})();
