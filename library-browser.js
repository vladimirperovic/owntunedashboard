(() => {
  'use strict';

  const cfg = Object.assign({apiBase:'/api', defaultFolderPath:'/media/music/Music'}, window.OWNTONE_DASHBOARD || {});
  const apiBase = String(cfg.apiBase || '/api').replace(/\/$/, '');
  const defaultPath = String(cfg.defaultFolderPath || '/media/music/Music');
  let dialog;
  let body;
  let crumbs;
  let pathLabel;
  let searchInput;
  let searchClear;
  let countBadge;
  let currentPath = defaultPath;
  let currentTracks = [];
  let busy = false;

  const icon = {
    folder:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.8h6l1.8 2h9.2v9.7a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V6.8Z"/><path d="M3.5 9h17"/></svg>',
    play:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    back:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    shuffle:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h2.5c4 0 5 10 9 10H20M17 14l3 3-3 3M4 17h2.5c1.5 0 2.6-1.4 3.6-3M15.5 7H20M17 4l3 3-3 3"/></svg>',
    next:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l9 7-9 7V5Z"/><path d="M18 5v14"/></svg>',
    add:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    search:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  };

  function apiUrl(path) { return `${apiBase}${path.startsWith('/') ? path : '/' + path}`; }
  async function request(path, options={}) {
    const response = await fetch(apiUrl(path), options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function basename(path) {
    const clean = String(path || '').replace(/\/+$/, '');
    return clean.split('/').filter(Boolean).pop() || clean || 'Music';
  }
  function duration(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;
  }
  function quality(track) {
    const type = String(track.type || '').toUpperCase();
    const bitrate = String(track.bitrate || '').trim();
    if (type === 'FLAC' || type === 'ALAC') return type;
    if (bitrate) return `${type || 'AUDIO'} ${bitrate}${/^\d+$/.test(bitrate) ? 'k' : ''}`;
    return type || 'AUDIO';
  }

  function mount() {
    if (document.getElementById('folderBrowserDialog')) return;

    const albumLink = [...document.querySelectorAll('.side-link')].find(x => /albums/i.test(x.textContent || ''));
    if (albumLink) {
      const button = document.createElement('button');
      button.className = 'side-link';
      button.type = 'button';
      button.id = 'foldersNavButton';
      button.innerHTML = `<span class="folder-nav-icon">${icon.folder}</span>Folders`;
      button.addEventListener('click', () => openBrowser(currentPath || defaultPath));
      albumLink.insertAdjacentElement('afterend', button);
    }

    const mobile = document.querySelector('.mobile-nav');
    if (mobile && !document.getElementById('foldersMobileButton')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'foldersMobileButton';
      button.innerHTML = `<span class="folder-mobile-icon">${icon.folder}</span><small>Folders</small>`;
      button.addEventListener('click', () => openBrowser(currentPath || defaultPath));
      const library = [...mobile.querySelectorAll('button')].find(x => /library/i.test(x.textContent || ''));
      library ? library.insertAdjacentElement('afterend', button) : mobile.appendChild(button);
    }

    dialog = document.createElement('dialog');
    dialog.id = 'folderBrowserDialog';
    dialog.className = 'folder-dialog';
    dialog.innerHTML = `
      <div class="folder-panel">
        <header class="folder-head">
          <div class="folder-title-wrap">
            <span class="section-kicker">MUSIC FILES</span>
            <h2>Folders</h2>
            <div class="folder-path" id="folderPathLabel">Local library</div>
          </div>
          <div class="folder-head-actions">
            <button class="folder-action secondary" id="folderShuffle" type="button" disabled>${icon.shuffle}<span>Shuffle folder</span></button>
            <button class="folder-action" id="folderPlayAll" type="button" disabled>${icon.play}<span>Play folder</span></button>
            <button class="folder-close" id="folderClose" type="button" aria-label="Close">×</button>
          </div>
        </header>
        <div class="folder-crumbs" id="folderCrumbs"></div>
        <div class="folder-search-row">
          <div class="folder-search-wrap">
            <span class="folder-search-icon">${icon.search}</span>
            <input type="text" id="folderSearchInput" class="folder-search-input" placeholder="Filter folders and tracks in this folder…" aria-label="Filter folder contents" autocomplete="off" spellcheck="false" />
            <button type="button" class="folder-search-clear" id="folderSearchClear" aria-label="Clear filter" style="display:none">×</button>
          </div>
          <span class="folder-count-badge" id="folderCountBadge">0 items</span>
        </div>
        <div class="folder-body" id="folderBody"><div class="folder-loading">Loading folders…</div></div>
      </div>`;
    document.body.appendChild(dialog);
    body = dialog.querySelector('#folderBody');
    crumbs = dialog.querySelector('#folderCrumbs');
    pathLabel = dialog.querySelector('#folderPathLabel');
    searchInput = dialog.querySelector('#folderSearchInput');
    searchClear = dialog.querySelector('#folderSearchClear');
    countBadge = dialog.querySelector('#folderCountBadge');

    dialog.querySelector('#folderClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.querySelector('#folderPlayAll').addEventListener('click', () => playTracks(currentTracks, false));
    dialog.querySelector('#folderShuffle').addEventListener('click', () => playTracks(currentTracks, true));

    searchInput.addEventListener('input', () => filterCurrentDirectory(searchInput.value));
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (searchInput.value) {
          searchInput.value = '';
          filterCurrentDirectory('');
          e.stopPropagation();
        }
      }
    });
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      filterCurrentDirectory('');
      searchInput.focus();
    });
  }

  function filterCurrentDirectory(query) {
    const q = String(query || '').trim().toLowerCase();
    searchClear.style.display = q ? 'grid' : 'none';
    const rows = [...body.querySelectorAll('.folder-row')];
    if (!rows.length) return;

    let matched = 0;
    let totalItems = 0;
    const existingEmpty = body.querySelector('.folder-search-empty');
    if (existingEmpty) existingEmpty.remove();

    rows.forEach(row => {
      if (row.classList.contains('folder-up')) {
        row.style.display = '';
        return;
      }
      totalItems++;
      const text = row.textContent.toLowerCase();
      const match = !q || text.includes(q);
      row.style.display = match ? '' : 'none';
      if (match) matched++;
    });

    if (q && matched === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-search-empty';
      empty.innerHTML = `<b>No matches found</b><span>No files or folders matching "<em>${escapeHtml(query)}</em>" in this directory.</span>`;
      body.appendChild(empty);
    }

    if (countBadge) {
      countBadge.textContent = q ? `${matched} of ${totalItems} items` : `${totalItems} items`;
    }
  }

  async function openBrowser(path) {
    mount();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else { dialog.setAttribute('open',''); dialog.classList.add('fallback-open'); }
    await browse(path || currentPath || defaultPath);
  }

  function renderCrumbs(path) {
    crumbs.innerHTML = '';
    const root = document.createElement('button');
    root.type = 'button';
    root.textContent = 'Library';
    root.addEventListener('click', () => browse(''));
    crumbs.appendChild(root);

    const pieces = String(path || '').split('/').filter(Boolean);
    let built = '';
    pieces.forEach(piece => {
      built += `/${piece}`;
      const separator = document.createElement('span');
      separator.textContent = '/';
      crumbs.appendChild(separator);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = piece;
      const target = built;
      button.addEventListener('click', () => browse(target));
      crumbs.appendChild(button);
    });
  }

  async function browse(path) {
    if (busy) return;
    busy = true;
    currentPath = path || '';
    pathLabel.textContent = currentPath || 'Local library';
    renderCrumbs(currentPath);
    if (searchInput) {
      searchInput.value = '';
      if (searchClear) searchClear.style.display = 'none';
    }
    body.innerHTML = '<div class="folder-loading">Loading…</div>';
    try {
      const qs = currentPath ? `?directory=${encodeURIComponent(currentPath)}` : '';
      const data = await request(`/library/files${qs}`);
      currentTracks = data?.tracks?.items || [];
      renderDirectory(data || {});
    } catch (error) {
      currentTracks = [];
      body.innerHTML = `<div class="folder-empty"><b>Could not open this folder</b><span>${escapeHtml(error.message)}</span></div>`;
      if (countBadge) countBadge.textContent = '0 items';
    } finally {
      busy = false;
      const play = dialog.querySelector('#folderPlayAll');
      const shuffle = dialog.querySelector('#folderShuffle');
      play.disabled = !currentTracks.length;
      shuffle.disabled = !currentTracks.length;
    }
  }

  function renderDirectory(data) {
    const directories = data.directories || [];
    const tracks = data.tracks?.items || [];
    const playlists = data.playlists?.items || [];
    if (!directories.length && !tracks.length && !playlists.length) {
      body.innerHTML = '<div class="folder-empty"><b>This folder is empty</b><span>No indexed audio files were found.</span></div>';
      if (countBadge) countBadge.textContent = '0 items';
      return;
    }

    let html = '';
    if (currentPath) {
      const parent = currentPath.replace(/\/+$/, '').split('/').slice(0,-1).join('/') || '';
      html += `<button class="folder-row folder-up" type="button" data-folder="${escapeHtml(parent)}"><span class="folder-row-icon">${icon.back}</span><span class="folder-row-copy"><b>Back</b><small>Parent folder</small></span></button>`;
    }

    directories.forEach(dir => {
      const path = dir.path || '';
      html += `<button class="folder-row directory" type="button" data-folder="${escapeHtml(path)}">
        <span class="folder-row-icon">${icon.folder}</span>
        <span class="folder-row-copy"><b>${escapeHtml(basename(path))}</b><small>${escapeHtml(path)}</small></span>
        <span class="folder-chevron">›</span>
      </button>`;
    });

    tracks.forEach((track, index) => {
      html += `<div class="folder-row track" data-uri="${escapeHtml(track.uri || '')}">
        <span class="folder-track-number">${String(index + 1).padStart(2,'0')}</span>
        <span class="folder-row-copy"><b>${escapeHtml(track.title || basename(track.path))}</b><small>${escapeHtml([track.artist, track.album].filter(Boolean).join(' · ') || basename(track.path))}</small></span>
        <span class="folder-track-meta"><em>${escapeHtml(quality(track))}</em><span>${duration(track.length_ms)}</span></span>
        <button class="folder-track-next" type="button" title="Play next" aria-label="Play next">${icon.next}<span>Play next</span></button>
        <button class="folder-track-add" type="button" title="Add to queue" aria-label="Add to queue">${icon.add}<span>Add to queue</span></button>
        <button class="folder-track-play" type="button" title="Play now" aria-label="Play now">${icon.play}</button>
      </div>`;
    });

    playlists.forEach(item => {
      html += `<button class="folder-row track playlist-file" type="button" data-uri="${escapeHtml(item.uri || '')}">
        <span class="folder-track-number">PL</span>
        <span class="folder-row-copy"><b>${escapeHtml(item.name || basename(item.path))}</b><small>Playlist in this folder</small></span>
        <span class="folder-track-play">${icon.play}</span>
      </button>`;
    });

    body.innerHTML = html;
    const totalCount = directories.length + tracks.length + playlists.length;
    if (countBadge) countBadge.textContent = `${totalCount} items`;

    body.querySelectorAll('[data-folder]').forEach(row => row.addEventListener('click', () => browse(row.dataset.folder || '')));
    body.querySelectorAll('[data-uri]').forEach(row => row.addEventListener('click', () => playUris([row.dataset.uri], false)));
    body.querySelectorAll('.folder-track-play').forEach(btn => btn.addEventListener('click', event => {
      event.stopPropagation();
      playUris([btn.closest('[data-uri]').dataset.uri], false);
    }));
    body.querySelectorAll('.folder-track-next').forEach(btn => btn.addEventListener('click', event => {
      event.stopPropagation();
      playNext(btn.closest('[data-uri]').dataset.uri);
    }));
    body.querySelectorAll('.folder-track-add').forEach(btn => btn.addEventListener('click', event => {
      event.stopPropagation();
      addToQueue(btn.closest('[data-uri]').dataset.uri);
    }));
  }

  function flash(button) {
    if (!button) return;
    button.classList.add('is-done');
    setTimeout(() => button.classList.remove('is-done'), 700);
  }

  async function addToQueue(uri) {
    if (!uri) return;
    try {
      await request(`/queue/items/add?uris=${encodeURIComponent(uri)}&clear=false&playback=stop`, {method:'POST'});
      const dot = document.getElementById('queueCountDot');
      if (dot) { dot.textContent = String((Number(dot.textContent) || 0) + 1); dot.classList.add('show'); }
      const tab = document.getElementById('queueTabCount');
      if (tab) tab.textContent = String((Number(tab.textContent) || 0) + 1);
      flash(document.activeElement);
    } catch (error) {
      body.insertAdjacentHTML('afterbegin', `<div class="folder-error">Queue add failed: ${escapeHtml(error.message)}</div>`);
    }
  }

  async function playNext(uri) {
    if (!uri) return;
    try {
      const player = await request('/player').catch(() => null);
      const running = player?.state === 'play' || player?.state === 'pause';
      if (!running) {
        await request(`/queue/items/add?uris=${encodeURIComponent(uri)}&clear=false&playback=start`, {method:'POST'});
      } else {
        const added = await request(`/queue/items/add?uris=${encodeURIComponent(uri)}&clear=false&playback=stop`, {method:'POST'});
        const q = await request('/queue?start=0&end=500');
        const queue = q?.items || [];
        const now = await request('/queue?id=now_playing').catch(() => null);
        const current = now?.items?.[0];
        const item = queue.find(i => String(i.uri) === String(uri)) || queue[queue.length - 1];
        if (item) {
          const target = current?.position != null ? Number(current.position) + 1 : 0;
          await request(`/queue/items/${encodeURIComponent(item.id)}?new_position=${target}`, {method:'PUT'});
        }
      }
      flash(document.activeElement);
    } catch (error) {
      body.insertAdjacentHTML('afterbegin', `<div class="folder-error">Play next failed: ${escapeHtml(error.message)}</div>`);
    }
  }

  async function playUris(uris, shuffle) {
    const valid = uris.filter(Boolean);
    if (!valid.length) return;
    try {
      const running = await request('/player').catch(() => null);
      if (cfg.manualVolume != null && running?.state !== 'play' && running?.state !== 'pause') {
        const outs = await request('/outputs').catch(() => null);
        const out = (outs?.outputs || []).find(o => o.selected);
        if (out?.id != null) {
          const v = new URLSearchParams({volume:String(cfg.manualVolume), output_id:String(out.id)});
          await request(`/player/volume?${v}`, {method:'PUT'});
        }
      }
      const qs = new URLSearchParams({uris:valid.join(','), clear:'true', playback:'start', shuffle:String(!!shuffle)});
      await request(`/queue/items/add?${qs}`, {method:'POST'});
      window.OWNTONE_SYNC_PLAYBACK_MODE?.(valid[0]);
      dialog?.close();
    } catch (error) {
      body.insertAdjacentHTML('afterbegin', `<div class="folder-error">Playback failed: ${escapeHtml(error.message)}</div>`);
    }
  }

  async function playTracks(tracks, shuffle) {
    const uris = tracks.map(track => track.uri).filter(Boolean);
    await playUris(uris, shuffle);
  }

  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();
})();
