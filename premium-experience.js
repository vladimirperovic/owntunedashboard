(() => {
  'use strict';

  const { apiUrl, schedulerUrl, json: requestJson, escapeHtml, toast, whenReady, on } = window.OwnTone;

  const $ = id => document.getElementById(id);
  const app = () => window.OWNTONE_APP || null;
  const normalize = value =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const icons = {
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>',
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 20 9 12l10-8v16M5 19V5"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 4 10 8-10 8V4M19 5v14"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    queue:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h12M8 12h12M8 17h12"/><circle cx="4" cy="7" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17" r="1"/></svg>',
    output:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14v8H5zM8 19h8M12 16v3"/><path d="M8 11.5a6 6 0 0 1 8 0M10 13.5a3 3 0 0 1 4 0"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    shuffle:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h2.5c4 0 5 10 9 10H20M17 14l3 3-3 3M4 17h2.5c1.5 0 2.6-1.4 3.6-3M15.5 7H20M17 4l3 3-3 3"/></svg>',
    expand:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>',
    radio:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16v10H4zM7 7l9-4M8 14h.01M12 14h5M12 17h5"/></svg>',
    album:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
    sound:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 9.5a4 4 0 0 1 0 5"/><path d="M19 7a7.5 7.5 0 0 1 0 10"/></svg>',
    muted:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m17 9 5 5M22 9l-5 5"/></svg>',
  };

  let currentSource = readSource();
  let sheet;
  let albumDialog;
  let fullscreen;
  let miniQueue;
  let recentRail;
  let outputButton;
  let refreshHandle;
  let accentToken = '';
  // Bumped on every refresh: an await that started before the library loaded
  // must not paint its stale result over the render that came after it.
  let miniQueueRun = 0;
  let recentRailRun = 0;

  function readSource() {
    try {
      return JSON.parse(sessionStorage.getItem('owntone-playing-source') || 'null');
    } catch (_) {
      return null;
    }
  }
  function writeSource(source) {
    currentSource = source;
    try {
      sessionStorage.setItem('owntone-playing-source', JSON.stringify(source));
    } catch (_) {}
    syncPlayingFrom();
  }
  function appState() {
    return app()?.state || {};
  }
  function currentItem() {
    return appState().current || null;
  }
  function isRadioMode() {
    return document.body.classList.contains('radio-mode');
  }
  function isDemo() {
    return !!appState().demo;
  }
  function mountPlayingFrom() {
    if ($('playingFrom')) return;
    const copy = document.querySelector('.track-copy');
    const title = $('trackTitle');
    if (!copy || !title) return;
    const crumb = document.createElement('button');
    crumb.id = 'playingFrom';
    crumb.className = 'playing-from';
    crumb.type = 'button';
    crumb.setAttribute('aria-label', 'Show now playing details');
    crumb.innerHTML = `<span>Playing from</span><b>OwnTone</b>${icons.chevron}`;
    title.insertAdjacentElement('beforebegin', crumb);
    crumb.addEventListener('click', openTrackSheet);
    syncPlayingFrom();
  }

  function inferSource() {
    const item = currentItem();
    const isLive = item?.data_kind === 'url' || /^https?:\/\//i.test(String(item?.path || item?.uri || ''));
    if (isLive) {
      if (currentSource?.kind === 'radio' && currentSource?.label) return currentSource;
      return { kind: 'radio', label: item?.title || 'Live radio' };
    }
    // stale radio cache must not persist when a library file is playing (screenshot bug: Bach FLAC showed Radio)
    if (currentSource?.kind === 'radio' && !isLive) {
      if (item?.album) return { kind: 'album', label: item.album };
      return { kind: 'library', label: 'OwnTone library' };
    }
    if (currentSource?.label) return currentSource;
    if (item?.album) return { kind: 'album', label: item.album };
    return { kind: 'library', label: 'OwnTone library' };
  }

  function syncPlayingFrom() {
    const crumb = $('playingFrom');
    if (!crumb) return;
    const source = inferSource();
    const label = crumb.querySelector('b');
    if (label && label.textContent !== source.label) label.textContent = source.label;
    crumb.dataset.kind = source.kind || 'library';
  }

  function capturePlaybackSource(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.album-info-button,.premium-action,.premium-close')) return;

    const radio = target.closest('.radio-card[data-uri]');
    if (radio) {
      writeSource({
        kind: 'radio',
        label: radio.querySelector('.radio-station-name, b')?.textContent?.trim() || 'Radio',
      });
      return;
    }
    const album = target.closest('.album-card[data-uri]');
    if (album) {
      writeSource({
        kind: 'album',
        label: album.querySelector('.album-copy b')?.textContent?.trim() || 'Album',
      });
      return;
    }
    const playlist = target.closest('.playlist-card[data-uri]');
    if (playlist) {
      writeSource({
        kind: 'playlist',
        label: playlist.querySelector('.playlist-copy b')?.textContent?.trim() || 'Playlist',
      });
      return;
    }
    const quick = target.closest('.quick-card');
    if (quick) {
      writeSource({
        kind: 'playlist',
        label: quick.querySelector('b')?.textContent?.trim() || quick.dataset.playlist || 'Quick access',
      });
      return;
    }
    if (target.closest('.search-item[data-uri]')) {
      writeSource({ kind: 'search', label: 'Search' });
      return;
    }
    if (target.closest('.history-row[data-uri],.premium-recent-card[data-uri]')) {
      writeSource({ kind: 'history', label: 'Recently played' });
      return;
    }
    if (target.closest('#shuffleLibraryButton')) {
      writeSource({ kind: 'library', label: 'Library shuffle' });
    }
  }

  function mountTrackInfoButton() {
    // Info chip now lives inside #trackChips (rendered by app.js); use delegation so it survives re-renders
    const chips = document.getElementById('trackChips');
    if (!chips || chips.dataset.infoBound === '1') return;
    chips.dataset.infoBound = '1';
    chips.addEventListener('click', event => {
      if (event.target.closest('#trackInfoButton, .track-chip--info')) openTrackSheet();
    });
  }

  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement('aside');
    sheet.id = 'premiumSheet';
    sheet.className = 'premium-sheet';
    sheet.setAttribute('aria-hidden', 'true');
    sheet.innerHTML = `
      <div class="premium-sheet-backdrop" data-premium-close></div>
      <section class="premium-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="premiumSheetTitle">
        <header class="premium-sheet-head"><div><span class="section-kicker" id="premiumSheetKicker">DETAILS</span><h2 id="premiumSheetTitle">Now playing</h2></div><button type="button" class="premium-close" aria-label="Close">${icons.close}</button></header>
        <div class="premium-sheet-body" id="premiumSheetBody"></div>
      </section>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.premium-close').addEventListener('click', closeSheet);
    sheet.querySelector('[data-premium-close]').addEventListener('click', closeSheet);
    return sheet;
  }
  function openSheet(title, kicker, html) {
    ensureSheet();
    $('premiumSheetTitle').textContent = title;
    $('premiumSheetKicker').textContent = kicker;
    $('premiumSheetBody').innerHTML = html;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('premium-sheet-open');
  }
  function closeSheet() {
    sheet?.classList.remove('open');
    sheet?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('premium-sheet-open');
  }

  async function openTrackSheet() {
    let item = currentItem();
    if (!isDemo()) {
      try {
        const now = await requestJson(apiUrl('/queue?id=now_playing'), { cache: 'no-store' });
        item = now?.items?.[0] || item;
      } catch (_) {}
    }
    const source = inferSource();
    const rows = [
      ['Artist', item?.artist],
      ['Album', item?.album],
      ['Year', item?.year],
      ['Format', String(item?.type || '').toUpperCase()],
      ['Bitrate', item?.bitrate],
      ['Sample rate', item?.samplerate ? `${item.samplerate} Hz` : ''],
      ['Source', source.label],
      ['Path', item?.path],
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());
    const lyrics = String(item?.lyrics || '').trim();
    openSheet(
      'Track details',
      'NOW PLAYING',
      `
      <div class="premium-detail-hero"><b>${escapeHtml(item?.title || $('trackTitle')?.textContent || 'Nothing playing')}</b><span>${escapeHtml(item?.artist || $('trackArtist')?.textContent || 'OwnTone')}</span></div>
      <dl class="premium-meta-grid">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
      ${lyrics ? `<section class="premium-lyrics"><span class="section-kicker">LYRICS</span><pre>${escapeHtml(lyrics)}</pre></section>` : ''}`
    );
  }

  function mountOutputPicker() {
    const select = $('outputSelect');
    const row = document.querySelector('.volume-output-row');
    if (!select || !row || $('premiumOutputButton')) return;
    select.classList.add('premium-native-output');
    outputButton = document.createElement('button');
    outputButton.id = 'premiumOutputButton';
    outputButton.className = 'premium-output-button';
    outputButton.type = 'button';
    outputButton.innerHTML = `${icons.output}<span><small>AIRPLAY OUTPUT</small><b>${escapeHtml(select.options[select.selectedIndex]?.text || 'No output')}</b></span>${icons.chevron}`;
    row.insertBefore(outputButton, select.nextSibling);
    outputButton.addEventListener('click', openOutputSheet);
    select.addEventListener('change', syncOutputButton);
    new MutationObserver(syncOutputButton).observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }

  function syncOutputButton() {
    if (!outputButton) return;
    const select = $('outputSelect');
    const label = select?.options[select.selectedIndex]?.text || 'No output';
    const b = outputButton.querySelector('b');
    if (b && b.textContent !== label) b.textContent = label;
  }

  function openOutputSheet() {
    const select = $('outputSelect');
    const outputs = appState().outputs || [];
    const rows = [...(select?.options || [])]
      .filter(option => option.value)
      .map(option => {
        const meta = outputs.find(x => String(x.id) === String(option.value));
        const active = String(select.value) === String(option.value);
        return `<button type="button" class="premium-output-row ${active ? 'active' : ''}" data-output-id="${escapeHtml(option.value)}">
        <span class="premium-output-icon">${icons.output}</span><span><b>${escapeHtml(option.text)}</b><small>${escapeHtml(meta?.type || 'AirPlay')}${meta?.selected ? ' · Connected' : ''}</small></span><span class="premium-output-check">${active ? '✓' : ''}</span>
      </button>`;
      })
      .join('');
    const volume = Number($('volumeRange')?.value || 0);
    openSheet(
      'AirPlay output',
      'OUTPUT',
      `
      <div class="premium-output-list">${rows || '<p class="premium-empty">No outputs available.</p>'}</div>
      <div class="premium-sheet-volume"><label for="premiumOutputVolume"><span>Volume</span><b id="premiumOutputVolumeValue">${volume}%</b></label><input id="premiumOutputVolume" type="range" min="0" max="100" value="${volume}"></div>`
    );
    $('premiumSheetBody')
      .querySelectorAll('[data-output-id]')
      .forEach(button =>
        button.addEventListener('click', () => {
          if (!select) return;
          select.value = button.dataset.outputId;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(openOutputSheet, 80);
        })
      );
    const volumeInput = $('premiumOutputVolume');
    volumeInput?.addEventListener('input', () => {
      const value = Number(volumeInput.value);
      $('premiumOutputVolumeValue').textContent = `${value}%`;
      const main = $('volumeRange');
      if (main) {
        main.value = String(value);
        main.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    volumeInput?.addEventListener('change', () => {
      const main = $('volumeRange');
      if (main) main.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function enhanceAlbumCards() {
    document.querySelectorAll('.album-card[data-uri]').forEach(card => {
      if (card.querySelector('.album-info-button')) return;
      const art = card.querySelector('.album-art');
      if (!art) return;
      const button = document.createElement('button');
      button.className = 'album-info-button';
      button.type = 'button';
      button.title = 'Album details';
      button.setAttribute(
        'aria-label',
        `Album details: ${card.querySelector('.album-copy b')?.textContent || 'album'}`
      );
      button.innerHTML = icons.info;
      art.appendChild(button);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openAlbumDialog(card);
      });
    });
  }

  function ensureAlbumDialog() {
    if (albumDialog) return albumDialog;
    albumDialog = document.createElement('dialog');
    albumDialog.id = 'albumDetailDialog';
    albumDialog.className = 'premium-dialog album-detail-dialog';
    albumDialog.innerHTML = '<div class="premium-dialog-inner" id="albumDialogInner"></div>';
    document.body.appendChild(albumDialog);
    albumDialog.addEventListener('click', event => {
      if (event.target === albumDialog) albumDialog.close();
    });
    return albumDialog;
  }

  async function openAlbumDialog(card) {
    ensureAlbumDialog();
    const uri = card.dataset.uri || '';
    const name = card.querySelector('.album-copy b')?.textContent?.trim() || 'Album';
    const artist = card.querySelector('.album-copy small')?.textContent?.trim() || 'Unknown artist';
    const image = card.querySelector('.album-art img')?.getAttribute('src') || '';
    const inner = $('albumDialogInner');
    inner.innerHTML = `
      <header class="album-detail-head"><div class="album-detail-art">${image ? `<img src="${escapeHtml(image)}" alt="">` : icons.album}</div><div><span class="section-kicker">ALBUM</span><h2>${escapeHtml(name)}</h2><p>${escapeHtml(artist)}</p><div class="album-detail-actions"><button type="button" class="premium-action primary" data-album-action="play">${icons.play}<span>Play</span></button><button type="button" class="premium-action" data-album-action="shuffle">${icons.shuffle}<span>Shuffle</span></button><button type="button" class="premium-action" data-album-action="queue">${icons.plus}<span>Add to queue</span></button></div></div><button class="premium-close album-dialog-close" type="button" aria-label="Close">${icons.close}</button></header>
      <section class="album-track-section"><div class="album-track-heading"><span class="section-kicker">TRACKLIST</span><span id="albumTrackCount">Loading…</span></div><div id="albumTrackList" class="album-track-list"><div class="premium-loading">Loading tracks…</div></div></section>`;
    inner.querySelector('.album-dialog-close').addEventListener('click', () => albumDialog.close());
    inner.querySelector('[data-album-action="play"]').addEventListener('click', () => {
      writeSource({ kind: 'album', label: name });
      app()?.playUri?.(uri);
      albumDialog.close();
    });
    inner.querySelector('[data-album-action="shuffle"]').addEventListener('click', () => {
      writeSource({ kind: 'album', label: `${name} · shuffled` });
      app()?.playUri?.(uri, { shuffle: true });
      albumDialog.close();
    });
    inner
      .querySelector('[data-album-action="queue"]')
      .addEventListener('click', () => addAlbumToQueue(uri, name));
    if (typeof albumDialog.showModal === 'function') albumDialog.showModal();
    else albumDialog.setAttribute('open', '');
    await loadAlbumTracks(name, artist);
  }

  async function addAlbumToQueue(uri, name) {
    if (!uri) return;
    if (isDemo()) {
      toast(`${name} added to preview queue`);
      return;
    }
    try {
      const qs = new URLSearchParams({ uris: uri, clear: 'false' });
      await requestJson(apiUrl(`/queue/items/add?${qs}`), { method: 'POST' });
      toast(`${name} added to queue`);
      refreshMiniQueue();
    } catch (error) {
      toast(`Queue failed: ${error.message}`);
    }
  }

  async function loadAlbumTracks(name, artist) {
    const list = $('albumTrackList');
    const count = $('albumTrackCount');
    if (!list) return;
    if (isDemo()) {
      const demoTracks = ['Opening track', 'Side A', 'Interlude', 'Deep cut', 'Side B', 'Finale'];
      list.innerHTML = demoTracks
        .map(
          (title, index) =>
            `<div class="album-track-row"><span>${String(index + 1).padStart(2, '0')}</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(artist)}</small></span><em>${3 + (index % 3)}:${String(8 + index * 7).padStart(2, '0')}</em></div>`
        )
        .join('');
      if (count) count.textContent = `${demoTracks.length} tracks`;
      return;
    }
    try {
      const qs = new URLSearchParams({ query: name, type: 'tracks', media_kind: 'music', limit: '50' });
      const data = await requestJson(apiUrl(`/search?${qs}`), { cache: 'no-store' });
      let tracks = data?.tracks?.items || [];
      const exact = tracks.filter(track => normalize(track.album) === normalize(name));
      if (exact.length) tracks = exact;
      tracks = tracks.slice(0, 40);
      if (count) count.textContent = `${tracks.length} tracks`;
      list.innerHTML = tracks.length
        ? tracks
            .map(
              (track, index) =>
                `<div class="album-track-row"><span>${String(index + 1).padStart(2, '0')}</span><span><b>${escapeHtml(track.title || 'Untitled')}</b><small>${escapeHtml(track.artist || artist)}</small></span><em>${escapeHtml(track.track_number || '')}</em></div>`
            )
            .join('')
        : '<div class="premium-empty">Tracklist is not available from OwnTone search.</div>';
    } catch (error) {
      if (count) count.textContent = 'Unavailable';
      list.innerHTML = `<div class="premium-empty">Could not load tracklist: ${escapeHtml(error.message)}</div>`;
    }
  }

  function mountRecentRail() {
    if ($('premiumRecentlyPlayed')) return;
    const quickGrid = $('quickGrid');
    if (!quickGrid) return;
    const section = document.createElement('section');
    section.id = 'premiumRecentlyPlayed';
    section.className = 'premium-recent-section';
    section.innerHTML = `<div class="section-heading-row premium-recent-head"><div><span class="section-kicker">HISTORY</span><h2>Recently played</h2></div><button type="button" class="text-button" id="premiumOpenHistory">View all</button></div><div id="premiumRecentRail" class="premium-recent-rail"><div class="premium-loading">Loading history…</div></div>`;
    quickGrid.insertAdjacentElement('afterend', section);
    recentRail = $('premiumRecentRail');
    $('premiumOpenHistory').addEventListener('click', () => $('queueDrawerButton')?.click());
    refreshRecentRail();
  }

  function demoRecentItems() {
    const item = currentItem();
    return [
      {
        title: item?.title || 'La Vie En Rose',
        artist: item?.artist || 'Grace Jones',
        album: item?.album || 'Portfolio',
        played_at: new Date().toISOString(),
        play_uri: item?.uri || 'library:track:demo',
        is_radio: isRadioMode(),
      },
      {
        title: 'Teardrop',
        artist: 'Massive Attack',
        album: 'Mezzanine',
        play_uri: 'library:track:42',
        played_at: new Date(Date.now() - 18 * 60000).toISOString(),
      },
      {
        title: 'FIP',
        artist: 'Live radio',
        play_uri: 'library:playlist:13',
        is_radio: true,
        played_at: new Date(Date.now() - 42 * 60000).toISOString(),
      },
      {
        title: 'Riders on the Storm',
        artist: 'The Doors',
        album: 'L.A. Woman',
        play_uri: 'library:track:43',
        played_at: new Date(Date.now() - 64 * 60000).toISOString(),
      },
      {
        title: 'Moon Safari',
        artist: 'Air',
        album: 'Moon Safari',
        play_uri: 'library:album:6',
        played_at: new Date(Date.now() - 93 * 60000).toISOString(),
      },
      {
        title: 'KEXP 90.3',
        artist: 'Live radio',
        play_uri: 'library:playlist:11',
        is_radio: true,
        played_at: new Date(Date.now() - 130 * 60000).toISOString(),
      },
    ];
  }

  async function refreshRecentRail() {
    if (!recentRail) return;
    const run = ++recentRailRun;
    let items = [];
    if (isDemo()) items = demoRecentItems();
    else {
      try {
        const data = await requestJson(schedulerUrl('/history?limit=8'), { cache: 'no-store' });
        items = data?.items || [];
      } catch (_) {
        items = demoRecentItems().slice(0, 1);
      }
    }
    if (run !== recentRailRun) return;
    recentRail.innerHTML = items.length
      ? items
          .slice(0, 8)
          .map((item, index) => {
            const title = item.title || item.station_name || 'Unknown';
            const sub =
              item.artist || item.station_name || item.album || (item.is_radio ? 'Live radio' : 'OwnTone');
            return `<button type="button" class="premium-recent-card ${item.is_radio ? 'is-radio' : ''}" ${item.play_uri ? `data-uri="${escapeHtml(item.play_uri)}"` : ''} style="--recent-hue:${(index * 47 + 18) % 360}"><span class="premium-recent-art">${item.is_radio ? icons.radio : icons.album}</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small></span></button>`;
          })
          .join('')
      : '<div class="premium-empty">No listening history yet.</div>';
    recentRail.querySelectorAll('[data-uri]').forEach(button =>
      button.addEventListener('click', () => {
        writeSource({ kind: 'history', label: 'Recently played' });
        app()?.playUri?.(button.dataset.uri);
      })
    );
  }

  function mountMiniQueue() {
    if ($('desktopMiniQueue')) return;
    const hero = document.querySelector('.hero-stack');
    if (!hero) return;
    hero.classList.add('premium-queue-layout');
    miniQueue = document.createElement('aside');
    miniQueue.id = 'desktopMiniQueue';
    miniQueue.className = 'desktop-mini-queue';
    miniQueue.innerHTML = `<header><div><span class="section-kicker">UP NEXT</span><h3>Queue</h3></div><button type="button" class="premium-mini-queue-open" aria-label="Open full queue">${icons.queue}</button></header><div id="desktopMiniQueueBody" class="desktop-mini-queue-body"><div class="premium-loading">Loading queue…</div></div>`;
    hero.appendChild(miniQueue);
    miniQueue
      .querySelector('.premium-mini-queue-open')
      .addEventListener('click', () => $('queueDrawerButton')?.click());
    refreshMiniQueue();
  }

  async function refreshMiniQueue() {
    const body = $('desktopMiniQueueBody');
    if (!body) return;
    const run = ++miniQueueRun;
    let items = [];
    if (isDemo()) {
      items = [
        { title: 'Teardrop', artist: 'Massive Attack' },
        { title: 'Riders on the Storm', artist: 'The Doors' },
        { title: 'Roads', artist: 'Portishead' },
      ];
    } else {
      try {
        const now = await requestJson(apiUrl('/queue?id=now_playing'), { cache: 'no-store' });
        const position = Number(now?.items?.[0]?.position ?? 0);
        const data = await requestJson(apiUrl(`/queue?start=${position + 1}&end=${position + 4}`), {
          cache: 'no-store',
        });
        items = data?.items || [];
      } catch (_) {
        items = [];
      }
    }
    if (run !== miniQueueRun) return;
    const item = currentItem();
    if (items.length) {
      body.innerHTML = items
        .slice(0, 3)
        .map(
          (item, index) =>
            `<div class="desktop-mini-queue-row"><span>${String(index + 1).padStart(2, '0')}</span><span><b>${escapeHtml(item.title || 'Untitled')}</b><small>${escapeHtml(item.artist || item.album || 'OwnTone')}</small></span></div>`
        )
        .join('');
    } else if (item) {
      const live = item.data_kind === 'url' || /^https?:\/\//i.test(String(item.path || ''));
      body.innerHTML = `<div class="desktop-mini-queue-row is-now"><span>●</span><span><b>${escapeHtml(item.title || 'Live radio')}</b><small>${escapeHtml([item.artist, live ? 'Live radio · on air' : item.album].filter(Boolean).join(' · '))}</small></span></div>`;
    } else {
      body.innerHTML = '<div class="premium-empty compact">Queue is empty.</div>';
    }
  }

  function mountFullscreen() {
    if ($('fullscreenNowPlaying')) return;
    fullscreen = document.createElement('dialog');
    fullscreen.id = 'fullscreenNowPlaying';
    fullscreen.className = 'fullscreen-now-playing';
    fullscreen.innerHTML = `
      <div class="fullscreen-ambient" aria-hidden="true"></div>
      <div class="fullscreen-shell">
        <header><span class="fullscreen-source" id="fullscreenSource">OwnTone</span><button class="premium-close fullscreen-close" type="button" aria-label="Close fullscreen player">${icons.close}</button></header>
        <main><div class="fullscreen-art"><img id="fullscreenArtwork" src="icon.svg" alt="" hidden><div id="fullscreenArtFallback">OT</div></div><div class="fullscreen-copy"><span class="section-kicker">NOW PLAYING</span><h2 id="fullscreenTitle">OwnTone</h2><p id="fullscreenArtist">Music</p><small id="fullscreenMeta"></small><div class="fullscreen-progress"><div><span id="fullscreenElapsed">0:00</span><span id="fullscreenRemaining">−0:00</span></div><div class="fullscreen-progress-track"><i id="fullscreenProgressFill"></i></div></div><div class="fullscreen-controls"><button type="button" data-full-command="previous" aria-label="Previous">${icons.previous}</button><button type="button" class="fullscreen-play" data-full-command="toggle" aria-label="Play">${icons.play}</button><button type="button" data-full-command="next" aria-label="Next">${icons.next}</button><button type="button" id="fullscreenMuteButton" class="fullscreen-mute" aria-label="Mute" data-muted="false">${icons.sound}</button></div><button type="button" class="fullscreen-output" id="fullscreenOutputButton">${icons.output}<span id="fullscreenOutputName">No output</span></button></div></main>
      </div>`;
    document.body.appendChild(fullscreen);
    fullscreen.querySelector('.fullscreen-close').addEventListener('click', () => fullscreen.close());
    fullscreen.querySelectorAll('[data-full-command]').forEach(button =>
      button.addEventListener('click', () => {
        const command = button.dataset.fullCommand;
        if (command === 'toggle') $('playButton')?.click();
        if (command === 'previous') $('previousButton')?.click();
        if (command === 'next') $('nextButton')?.click();
        setTimeout(syncPremiumNowPlaying, 50);
      })
    );
    $('fullscreenOutputButton').addEventListener('click', openOutputSheet);
    $('fullscreenMuteButton').addEventListener('click', () => {
      const mute = document.getElementById('muteButton');
      if (mute) mute.click();
      setTimeout(syncFullscreenMute, 80);
    });
    fullscreen.addEventListener('click', event => {
      if (event.target === fullscreen) fullscreen.close();
    });

    const art = $('playerArt');
    if (art) {
      art.classList.add('premium-expandable-art');
      art.tabIndex = 0;
      art.setAttribute('role', 'button');
      art.setAttribute('aria-label', 'Open fullscreen now playing');
      const badge = document.createElement('span');
      badge.className = 'art-expand-badge';
      badge.innerHTML = icons.expand;
      art.appendChild(badge);
      const open = () => openFullscreen();
      art.addEventListener('click', open);
      art.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
    }
  }

  function openFullscreen() {
    syncPremiumNowPlaying();
    if (typeof fullscreen.showModal === 'function') fullscreen.showModal();
    else fullscreen.setAttribute('open', '');
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function syncFullscreen() {
    if (!fullscreen) return;
    const state = appState();
    const item = state.current || {};
    $('fullscreenTitle').textContent = item.title || $('trackTitle')?.textContent || 'OwnTone';
    $('fullscreenArtist').textContent = item.artist || $('trackArtist')?.textContent || 'OwnTone';
    $('fullscreenMeta').textContent = $('trackMeta')?.textContent || '';
    $('fullscreenSource').textContent = inferSource().label;
    $('fullscreenOutputName').textContent =
      $('outputSelect')?.options[$('outputSelect')?.selectedIndex]?.text || 'No output';
    const src = $('artwork')?.getAttribute('src') || '';
    const img = $('fullscreenArtwork');
    const fallback = $('fullscreenArtFallback');
    const ambient = fullscreen.querySelector('.fullscreen-ambient');
    if (ambient) {
      if (src) ambient.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`;
      else ambient.style.backgroundImage = '';
    }
    if (src) {
      if (img.getAttribute('src') !== src) img.src = src;
      img.hidden = false;
      fallback.hidden = true;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      fallback.hidden = false;
    }
    const player = state.player || {};
    const len = Number(player.item_length_ms || item.length_ms || 0);
    const pos = Number(player.item_progress_ms || 0);
    $('fullscreenElapsed').textContent = fmtTime(pos);
    $('fullscreenRemaining').textContent = `−${fmtTime(Math.max(0, len - pos))}`;
    $('fullscreenProgressFill').style.width = `${len ? Math.min(100, Math.max(0, (pos / len) * 100)) : 0}%`;
    const playing =
      player.state === 'play' ||
      String($('playButton')?.getAttribute('aria-label') || '')
        .toLowerCase()
        .includes('pause');
    const play = fullscreen.querySelector('.fullscreen-play');
    if (play.dataset.state !== (playing ? 'pause' : 'play')) {
      play.dataset.state = playing ? 'pause' : 'play';
      play.innerHTML = playing ? icons.pause : icons.play;
      play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    syncFullscreenMute();
  }

  function syncFullscreenMute() {
    const btn = $('fullscreenMuteButton');
    if (!btn) return;
    const range = $('volumeRange');
    const muted = Number(range?.value || 0) === 0;
    btn.dataset.muted = muted ? 'true' : 'false';
    btn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    btn.setAttribute('aria-pressed', String(muted));
    btn.innerHTML = muted ? icons.muted : icons.sound;
  }

  async function syncArtworkMood() {
    const art = $('artwork');
    const src = art?.getAttribute('src') || '';
    const player = document.querySelector('.player-card');
    if (!player) return;
    if (src) player.style.setProperty('--premium-artwork', `url("${src.replace(/"/g, '%22')}")`);
    else player.style.removeProperty('--premium-artwork');
    const token = `${src}|${$('trackTitle')?.textContent || ''}`;
    if (token === accentToken) return;
    accentToken = token;
    if (src && art?.complete && art.naturalWidth) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 18;
        canvas.height = 18;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(art, 0, 0, 18, 18);
        const data = ctx.getImageData(0, 0, 18, 18).data;
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let i = 0; i < data.length; i += 16) {
          if (data[i + 3] < 160) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
        if (count) {
          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);
          const max = Math.max(r, g, b),
            min = Math.min(r, g, b);
          if (max - min < 35) {
            r = Math.min(235, r + 35);
            g = Math.max(55, g - 12);
            b = Math.max(45, b - 20);
          }
          document.documentElement.style.setProperty('--context-accent-rgb', `${r},${g},${b}`);
          return;
        }
      } catch (_) {}
    }
    const text = $('trackTitle')?.textContent || 'OwnTone';
    let hash = 0;
    for (const ch of text) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    document.documentElement.style.setProperty('--context-accent-hue', String(hue));
    document.documentElement.style.removeProperty('--context-accent-rgb');
  }

  function syncPremiumNowPlaying() {
    syncPlayingFrom();
    syncOutputButton();
    syncFullscreen();
    syncArtworkMood();
  }

  function mountMutationObservers() {
    const player = $('playerCard');
    if (player)
      new MutationObserver(() => {
        syncPremiumNowPlaying();
        enhanceAlbumCards();
      }).observe(player, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['src', 'class', 'aria-label'],
      });
    const albumGrid = $('albumGrid');
    if (albumGrid) new MutationObserver(enhanceAlbumCards).observe(albumGrid, { childList: true });
  }

  function mount() {
    mountPlayingFrom();
    mountTrackInfoButton();
    mountOutputPicker();
    enhanceAlbumCards();
    mountRecentRail();
    mountMiniQueue();
    mountFullscreen();
    mountMutationObservers();
    syncPremiumNowPlaying();

    document.addEventListener('click', capturePlaybackSource, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && sheet?.classList.contains('open')) closeSheet();
    });

    clearInterval(refreshHandle);
    refreshHandle = setInterval(refreshAll, 9000);

    // The first render happens before app.js has answered the server, so redraw
    // once the library is in. Without this the panels show whatever the empty
    // initial state implies for the first nine seconds.
    whenReady(refreshAll);
    on('owntone:library-updated', refreshAll);
  }

  function refreshAll() {
    syncPremiumNowPlaying();
    refreshRecentRail();
    refreshMiniQueue();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
