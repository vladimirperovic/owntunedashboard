window.OWNTONE_DASHBOARD = {
  // Recommended: keep the dashboard and OwnTone behind the same reverse proxy.
  // The included nginx config proxies /api and artwork to OwnTone on localhost:3689.
  apiBase: '/api',
  schedulerBase: '/scheduler',
  demoOnFailure: true,
  pollMs: 3000,
  radioPathHint: '/Radio/',
  preferredOutput: 'HomePod',
  // Volume applied whenever the user starts playback manually (not the morning scheduler).
  manualVolume: 50,
  // If the dashboard has never remembered a pre-mute level, unmute restores gently to this value.
  safeUnmuteVolume: 10,

  // Optional per-station quality labels. Add verified ffprobe results here when
  // OwnTone's playlist metadata does not expose codec/bitrate.
  radioQuality: {
    'Radio Porto Montenegro': 'MP3 320k',
  },
};

// Lightweight UI extensions are deliberately isolated from app.js so playback logic
// remains small and future OwnTone API changes are easier to maintain.
(() => {
  const BUILD = '20260819-1';
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
    script.defer = true;
    script.setAttribute(`data-${dataKey}`, '1');
    document.head.appendChild(script);
  };

  addStyle('radio-polish.css', 'owntone-radio-polish');
  addStyle('library-browser.css', 'owntone-library-browser');
  addStyle('scheduler-ui.css', 'owntone-scheduler-ui');
  addStyle('ui-polish.css', 'owntone-ui-polish');
  addStyle('final-fixes.css', 'owntone-final-fixes');
  addStyle('mute-control.css', 'owntone-mute-control');

  addScript('radio-dnd.js', 'owntone-radio-dnd');
  addScript('library-browser.js', 'owntone-library-browser-js');
  addScript('scheduler-ui.js', 'owntone-scheduler-ui-js');
  addScript('radio-visualizer.js', 'owntone-radio-visualizer-js');
  addScript('mute-control.js', 'owntone-mute-control-js');
})();
