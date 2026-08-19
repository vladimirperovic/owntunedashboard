window.OWNTONE_DASHBOARD = {
  // Recommended: keep the dashboard and OwnTone behind the same reverse proxy.
  // The included nginx config proxies /api and artwork to OwnTone on localhost:3689.
  apiBase: '/api',
  schedulerBase: '/scheduler',
  demoOnFailure: true,
  pollMs: 3000,
  radioPathHint: '/Radio/',
  preferredOutput: 'HomePod',

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

  // Optional per-station quality labels. Add verified ffprobe results here when
  // OwnTone's playlist metadata does not expose codec/bitrate.
  radioQuality: {
    'Radio Porto Montenegro': 'MP3 320k',
  },

  // Local, fast station identities. Add exact station names here for custom artwork.
  // Unknown stations keep the generated monogram identity.
  radioArtwork: {
    'Naxi Radio': 'station-logos/naxi.svg',
    'Radio S1': 'station-logos/s1.svg',
    'Radio Beograd 202': 'station-logos/radio-202.svg',
    'Rock Radio': 'station-logos/rock-radio.svg',
    'Radio Porto Montenegro': 'station-logos/porto-montenegro.svg',
  },
};

// Feature modules stay isolated, while all cross-app visual rules are consolidated
// into design-system.css to avoid cascades of competing last-mile overrides.
(() => {
  const BUILD = '20260819-15';
  const asset = path => `${path}?v=${BUILD}`;

  const addStyle = (href, dataKey) => {
    if (document.querySelector(`link[data-${dataKey}]`)) return;
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = asset(href);
    style.setAttribute(`data-${dataKey}`, '1');
    document.head.appendChild(style);
  };

  const addScript = (src, dataKey) => {
    if (document.querySelector(`script[data-${dataKey}]`)) return;
    const script = document.createElement('script');
    script.src = asset(src);
    // Dynamically created scripts are async by default; preserve insertion order on Safari/mobile.
    script.async = false;
    script.defer = true;
    script.setAttribute(`data-${dataKey}`, '1');
    document.head.appendChild(script);
  };

  addStyle('radio-polish.css', 'owntone-radio-polish');
  addStyle('radio-features.css', 'owntone-radio-features');
  addStyle('library-browser.css', 'owntone-library-browser');
  addStyle('scheduler-ui.css', 'owntone-scheduler-ui');
  addStyle('mute-control.css', 'owntone-mute-control');
  addStyle('playback-tools.css', 'owntone-playback-tools');
  addStyle('design-system.css', 'owntone-design-system');
  addStyle('premium-experience.css', 'owntone-premium-experience');

  addScript('playback-tools.js', 'owntone-playback-tools-js');
  addScript('night-safety-history.js', 'owntone-night-safety-history-js');
  addScript('radio-dnd.js', 'owntone-radio-dnd');
  addScript('library-browser.js', 'owntone-library-browser-js');
  addScript('scheduler-ui.js', 'owntone-scheduler-ui-js');
  addScript('radio-visualizer.js', 'owntone-radio-visualizer-js');
  addScript('mute-control.js', 'owntone-mute-control-js');
  addScript('design-enhancements.js', 'owntone-design-enhancements-js');
  addScript('premium-experience.js', 'owntone-premium-experience-js');
})();
