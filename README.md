# OwnTone Dashboard

A lightweight, responsive controller for OwnTone, designed for a local music library + AirPlay/HomePod setup.

The interface is inspired by the warm editorial feel, rounded cards, dark live view and coral/cream palette of the referenced **Immersive Podcast** concept by Anastasia Golovko / Tino on Dribbble, while using an original layout and components for OwnTone.

## What it does

- Music / Radio mode switch in the top-right.
  - Music mode shows a **radio icon**.
  - Radio mode shows a **music-note icon** to return to the library.
- Live Now Playing view with artwork, title, artist, album, codec/bitrate and progress.
- Play / pause / previous / next / seek.
- HomePod / AirPlay output selector and per-output volume.
- One-tap **Favorites**, **Random 500**, **Morning** and **My Music** actions.
- Album and playlist browsing.
- Search across tracks, artists, albums and playlists.
- Dedicated radio UI built from OwnTone playlists stored under `/Radio/` (configurable).
- Desktop, tablet and mobile layouts.
- No framework and no build step: plain HTML/CSS/JS.
- Demo fallback so the visual layout can still be previewed if OwnTone is unreachable.

## OwnTone API

The dashboard uses OwnTone's JSON API for playback, queue, outputs, library and search.

Default configuration is in `config.js`:

```js
window.OWNTONE_DASHBOARD = {
  apiBase: '/api',
  demoOnFailure: true,
  pollMs: 3000,
  radioPathHint: '/Radio/',
  preferredOutput: 'HomePod',
};
```

## Recommended deployment on the Plex / OwnTone LXC

Do **not** serve the dashboard from GitHub Pages if OwnTone is only available at `http://192.168.1.15:3689`. An HTTPS page cannot reliably call a private HTTP API, and cross-origin browser rules may also block it.

Serve this dashboard from the same LXC and reverse-proxy OwnTone through the same origin.

Example:

```bash
apt install -y nginx git
git clone https://github.com/vladimirperovic/owntunedashboard.git /opt/owntunedashboard
cp /opt/owntunedashboard/deploy/nginx.conf /etc/nginx/sites-available/owntunedashboard
ln -s /etc/nginx/sites-available/owntunedashboard /etc/nginx/sites-enabled/owntunedashboard
nginx -t && systemctl reload nginx
```

Then open:

```text
http://192.168.1.15:3690
```

The included Nginx config proxies:

- `/api/*` → `http://127.0.0.1:3689/api/*`
- `/artwork/*` → `http://127.0.0.1:3689/artwork/*`

This keeps the browser on one origin and avoids CORS/mixed-content problems.

## Radio presets

The dashboard classifies a playlist as radio when its path contains `radioPathHint` (default `/Radio/`). For example:

```text
/media/music/Radio/Naxi Radio.m3u
/media/music/Radio/Radio S1.m3u
/media/music/Radio/Radio 202.m3u
```

After adding M3U files, run an OwnTone library update and press **Refresh** in the dashboard.

## Expected OwnTone version

Built against the JSON API documented for current OwnTone and intended for the installed OwnTone 29.x setup.
