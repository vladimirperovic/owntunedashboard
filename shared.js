/**
 * Shared building blocks for the OwnTone Dashboard.
 *
 * Every feature module used to carry its own copy of these helpers: fourteen
 * fetch wrappers, eight toast implementations, four copies of the night-safe
 * volume rule. This file holds one of each, so a fix lands everywhere at once.
 *
 * Loads before app.js and before every feature module, and exposes itself as
 * `window.OwnTone`.
 */
window.OwnTone = (() => {
  'use strict';

  const config = Object.assign(
    {
      apiBase: '/api',
      schedulerBase: '/scheduler',
      pollMs: 3000,
      fallbackPollMs: 15000,
      websocketPath: '/owntone-events',
      websocketReconnectMs: 2500,
      radioPathHint: '/Radio/',
      radioNameHints: [],
      preferredOutput: 'HomePod',
      browserStreamPath: '/stream.mp3',
      manualVolume: 50,
      safeUnmuteVolume: 10,
      nightSafeStartHour: 0,
      nightSafeEndHour: 8,
      nightSafeMaxVolume: 8,
      historyLimit: 50,
      queueLimit: 20,
      defaultFolderPath: '/media/music/Music',
      radioQuality: {},
      radioArtwork: {},
    },
    window.OWNTONE_DASHBOARD || {}
  );

  const apiBase = String(config.apiBase || '/api').replace(/\/$/, '');
  const schedulerBase = String(config.schedulerBase || '/scheduler').replace(/\/$/, '');

  const join = (base, path) => `${base}${String(path).startsWith('/') ? path : `/${path}`}`;
  const apiUrl = path => join(apiBase, path);
  const schedulerUrl = path => join(schedulerBase, path);

  /* ---------------------------------------------------------------- HTTP -- */

  /**
   * One JSON request helper for both back ends.
   * Throws an Error whose message is the server's own `error` field when there
   * is one, so callers can put `error.message` straight into the UI.
   */
  async function json(url, options = {}) {
    const init = Object.assign({ cache: 'no-store' }, options, {
      headers: Object.assign({ Accept: 'application/json' }, options.headers),
    });
    if (init.body && typeof init.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }

    const response = await fetch(url, init);
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.clone().json())?.error || '';
      } catch {
        /* body was not JSON — fall back to the status line */
      }
      throw new Error(detail || `${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  const api = (path, options) => json(apiUrl(path), options);
  const scheduler = (path, options) => json(schedulerUrl(path), options);

  /* --------------------------------------------------------------- text -- */

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

  /** Milliseconds to `m:ss`. */
  function formatTime(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /* -------------------------------------------------------------- toast -- */

  let toastTimer;

  /** The one toast. A single timer, so two modules cannot cut each other short. */
  function toast(message, ms = 2400) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ------------------------------------------------------------- events -- */

  let readyEvent = null;

  function emit(name, detail) {
    const event = new CustomEvent(name, { detail });
    if (name === 'owntone:ready') readyEvent = event;
    window.dispatchEvent(event);
  }

  function on(name, handler) {
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  }

  /**
   * Run `handler` once app.js has loaded the library, now or later. The handler
   * always receives the ready event, whether it fired before or after this call.
   *
   * Replaces the 1.5 s polling loops modules used to run while waiting — those
   * gave up silently after 60 s, so a slow server meant a missing section.
   */
  function whenReady(handler) {
    if (readyEvent) {
      handler(readyEvent);
      return () => {};
    }
    const off = on('owntone:ready', event => {
      off();
      handler(event);
    });
    return off;
  }

  /* --------------------------------------------------------------- radio -- */

  /** True for a playlist that represents a radio station rather than music. */
  function isRadioPlaylist(playlist) {
    const path = String(playlist?.path || '').toLowerCase();
    const name = String(playlist?.name || '').toLowerCase();
    if (path.includes(String(config.radioPathHint || '/Radio/').toLowerCase())) return true;
    return (config.radioNameHints || []).some(hint => {
      const needle = String(hint || '')
        .trim()
        .toLowerCase();
      return needle
        ? new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(name)
        : false;
    });
  }

  /** True for a queue item that is a live stream rather than a local file. */
  const isRadioItem = item =>
    !!item && (item.data_kind === 'url' || /^https?:\/\//i.test(String(item.path || '')));

  /* --------------------------------------------------------- night safety -- */

  /**
   * Night safety, in one place.
   *
   * The rule: the volume slider is the user's intent for manual playback.
   * Starting playback applies that value to every selected output, and between
   * the configured hours it is capped. It is a ceiling, never a floor — a
   * quieter output is left alone. Scheduler runs are server-side and keep the
   * volume configured in the schedule.
   */
  const nightSafe = {
    isActive(date = new Date()) {
      const hour = date.getHours() + date.getMinutes() / 60;
      const start = Number(config.nightSafeStartHour ?? 0);
      const end = Number(config.nightSafeEndHour ?? 8);
      if (start === end) return true;
      return start < end ? hour >= start && hour < end : hour >= start || hour < end;
    },
    get cap() {
      return Math.max(0, Math.min(100, Number(config.nightSafeMaxVolume ?? 8)));
    },
    /** Ceiling only: returns `volume` untouched outside night hours. */
    limit(volume) {
      const value = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
      return this.isActive() ? Math.min(value, this.cap) : value;
    },
  };

  /* ------------------------------------------------------------- outputs -- */

  function browserOutput() {
    return window.OWNTONE_BROWSER_OUTPUT?.getState?.() || null;
  }

  /** Every output OwnTone currently plays to, plus the browser output if active. */
  async function selectedOutputs() {
    const browser = browserOutput();
    if (browser?.active) return [browser];
    const data = await api('/outputs').catch(() => null);
    return (data?.outputs || []).filter(output => output.selected);
  }

  async function setOutputVolume(outputId, volume) {
    const value = Math.max(0, Math.min(100, Math.round(volume)));
    if (String(outputId) === 'browser') {
      window.OWNTONE_BROWSER_OUTPUT?.setVolume(value);
      return;
    }
    const query = new URLSearchParams({ volume: String(value), output_id: String(outputId) });
    await api(`/player/volume?${query}`, { method: 'PUT' });
  }

  /**
   * How the current output selection is named in the UI.
   *
   * app.js and context-multiroom.js both write the hero label; when they
   * disagreed (one showing the first speaker's name, the other "2 outputs")
   * the text flipped back and forth on every poll. One rule, one result.
   */
  function outputLabel(outputs) {
    const selected = (outputs || []).filter(output => output?.selected);
    if (!selected.length) return 'No output';
    if (selected.length === 1) return selected[0].name || '1 output';
    return `${selected.length} outputs`;
  }

  /** Mirror a volume into the dashboard's own slider without a round trip. */
  function reflectVolume(volume) {
    const value = Math.max(0, Math.min(100, Math.round(volume)));
    const range = document.getElementById('volumeRange');
    const label = document.getElementById('volumeValue');
    if (range) {
      range.value = String(value);
      range.style.setProperty('--range-progress', `${value}%`);
    }
    if (label) label.textContent = `${value}%`;
    return value;
  }

  /* ------------------------------------------------------------ playback -- */

  /**
   * The single entry point for starting playback from the browser.
   *
   * Everything that used to build its own `/queue/items/add?...playback=start`
   * request goes through here, which is why the night-safe ceiling no longer
   * needs a `window.fetch` monkey patch to catch stragglers.
   *
   * @param {object}  request
   * @param {string} [request.uris]        comma-separated OwnTone URIs
   * @param {string} [request.expression]  smart-playlist expression (instead of uris)
   * @param {boolean}[request.shuffle]
   * @param {boolean}[request.clear]       replace the queue (default true)
   * @param {number} [request.volume]      desired volume; defaults to the slider
   */
  async function startPlayback({ uris, expression, shuffle = false, clear = true, volume } = {}) {
    if (!uris && !expression) throw new Error('startPlayback needs uris or an expression');

    const slider = Number(document.getElementById('volumeRange')?.value ?? config.manualVolume);
    const desired = Number.isFinite(Number(volume)) ? Number(volume) : slider;
    const target = nightSafe.limit(desired);

    if (target > 0) {
      // Apply to every selected output, so multi-room starts in step instead of
      // one speaker at the slider value and the rest wherever they were left.
      const outputs = await selectedOutputs();
      await Promise.all(
        outputs
          .filter(output => output.id != null)
          .map(output =>
            setOutputVolume(output.id, target).catch(error =>
              console.warn(`Volume for output ${output.id} failed:`, error)
            )
          )
      );
      if (target !== desired) {
        reflectVolume(target);
        emit('owntone:night-cap-applied', { requested: desired, applied: target });
      }
    }

    const query = new URLSearchParams({
      clear: String(clear),
      playback: 'start',
      shuffle: String(!!shuffle),
    });
    if (uris) query.set('uris', uris);
    if (expression) query.set('expression', expression);
    await api(`/queue/items/add?${query}`, { method: 'POST' });
  }

  /* --------------------------------------------------------------- icons -- */

  const svg = (path, extra = '') =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"${extra ? ` ${extra}` : ''}>${path}</svg>`;

  const icons = {
    play: svg('<path d="M8 5v14l11-7L8 5Z"/>'),
    pause: svg('<path d="M7 5h4v14H7zM14 5h4v14h-4z"/>'),
    previous: svg('<path d="M19 20 9 12l10-8v16M5 19V5"/>'),
    next: svg('<path d="m5 4 10 8-10 8V4M19 5v14"/>'),
    queue: svg(
      '<path d="M8 7h12M8 12h12M8 17h12"/><circle cx="4" cy="7" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17" r="1"/>'
    ),
    grip: svg(
      '<circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/>'
    ),
    trash: svg('<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/>'),
    close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.5-3.5"/>'),
    moon: svg('<path d="M20 15.5A8 8 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    shuffle: svg(
      '<path d="M4 7h2.5c4 0 5 10 9 10H20M17 14l3 3-3 3M4 17h2.5c1.5 0 2.6-1.4 3.6-3M15.5 7H20M17 4l3 3-3 3"/>'
    ),
    radio: svg('<path d="M4 10h16v10H4zM7 7l9-4M8 14h.01M12 14h5M12 17h5"/>'),
    note: svg(
      '<path d="M9 18V6l10-2v12M9 9l10-2M6.5 20A2.5 2.5 0 1 0 6.5 15a2.5 2.5 0 0 0 0 5ZM16.5 18A2.5 2.5 0 1 0 16.5 13a2.5 2.5 0 0 0 0 5Z"/>'
    ),
    album: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>'),
    output: svg(
      '<path d="M5 8h14v8H5zM8 19h8M12 16v3"/><path d="M8 11.5a6 6 0 0 1 8 0M10 13.5a3 3 0 0 1 4 0"/>'
    ),
    expand: svg('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>'),
    now: svg('<circle cx="12" cy="12" r="8"/><path d="m10 8.5 5 3.5-5 3.5Z"/>'),
    spinner: svg(
      '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" opacity="0.25"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="16 40" stroke-linecap="round"/>',
      'class="playback-spinner"'
    ),
  };

  return {
    config,
    apiUrl,
    schedulerUrl,
    api,
    scheduler,
    json,
    escapeHtml,
    formatTime,
    toast,
    emit,
    on,
    whenReady,
    isRadioPlaylist,
    isRadioItem,
    nightSafe,
    browserOutput,
    selectedOutputs,
    setOutputVolume,
    outputLabel,
    reflectVolume,
    startPlayback,
    icons,
  };
})();
