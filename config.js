window.OWNTONE_DASHBOARD = {
  // Recommended: keep the dashboard and OwnTone behind the same reverse proxy.
  // The included nginx config proxies /api and artwork to OwnTone on localhost:3689.
  apiBase: '/api',
  demoOnFailure: true,
  pollMs: 3000,
  radioPathHint: '/Radio/',
  preferredOutput: 'HomePod',
};
