window.OWNTONE_DASHBOARD = {
  // Recommended: keep the dashboard and OwnTone behind the same reverse proxy.
  // The included nginx config proxies /api and artwork to OwnTone on localhost:3689.
  apiBase: '/api',
  demoOnFailure: true,
  pollMs: 3000,
  radioPathHint: '/Radio/',
  preferredOutput: 'HomePod',

  // Optional per-station quality labels. Add the verified ffprobe result here when
  // OwnTone's playlist metadata does not expose codec/bitrate. The currently playing
  // station is detected automatically from the live player metadata.
  radioQuality: {
    'Radio Porto Montenegro': 'MP3 320k',
  },
};

// Lightweight UI extensions are kept separate from the OwnTone API layer so future
// dashboard updates do not have to modify playback logic.
(() => {
  if (!document.querySelector('link[data-owntone-radio-polish]')) {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = 'radio-polish.css';
    style.dataset.owntoneRadioPolish = '1';
    document.head.appendChild(style);
  }

  if (!document.querySelector('script[data-owntone-radio-dnd]')) {
    const script = document.createElement('script');
    script.src = 'radio-dnd.js';
    script.async = false;
    script.dataset.owntoneRadioDnd = '1';
    document.head.appendChild(script);
  }
})();
