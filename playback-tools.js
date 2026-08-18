(() => {
  'use strict';

  const cfg = Object.assign({
    apiBase: '/api',
    schedulerBase: '/scheduler',
    nightSafeStartHour: 0,
    nightSafeEndHour: 8,
    nightSafeMaxVolume: 8,
    historyLimit: 50,
    queueLimit: 20,
  }, window.OWNTONE_DASHBOARD || {});

  const apiBase = String(cfg.apiBase || '/api').replace(/\/$/, '');
  const companionBase = String(cfg.schedulerBase || '/scheduler').replace(/\/$/, '');
  const nativeFetch = window.fetch.bind(window);
  let drawer;
  let body;
  let activeTab = 'queue';
  let queueStart = 0;
  let refreshTimer;
  let nightBadge;

  const icons = {
    queue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h12M8 12h12M8 17h12"/><circle cx="4" cy="7" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17" r="1"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>',
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/></svg>',
    moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8 8 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z"/></svg>',
  };

  function apiUrl(path) { return `${apiBase}${path.startsWith('/') ? path : '/' + path}`; }
  function companionUrl(path) { return `${companionBase}${path.startsWith('/') ? path : '/' + path}`; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtTime(value) {
    if (!value) return '';
    try { return new Intl.DateTimeFormat(undefined, {hour:'2-digit', minute:'2-digit'}).format(new Date(value)); }
    catch (_) { return ''; }
  }
  function quality(item) {
    const type = String(item?.type || '').toUpperCase();
    const bitrate = String(item?.bitrate || '').trim();
    if (type === 'FLAC' || type === 'ALAC') return type;
    if (bitrate) return `${type || 'AUDIO'} ${bitrate}${/^\d+$/.test(bitrate) ? 'k' : ''}`;
    return type || (item?.is_radio ? 'RADIO' : 'AUDIO');
  }

  function isNightSafeTime(date = new Date()) {
    const hour = date.getHours() + date.getMinutes() / 60;
    const start = Number(cfg.nightSafeStartHour ?? 0);
    const end = Number(cfg.nightSafeEndHour ?? 8);
    if (start === end) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  function selectedOutputId() { return document.getElementById('outputSelect')?.value || ''; }
  function currentVolume() { return Number(document.getElementById('volumeRange')?.value || 0); }
  function setLocalVolume(value) {
    const v = Math.max(0, Math.min(100, Math.round(value)));
    const range = document.getElementById('volumeRange');
    const label = document.getElementById('volumeValue');
    if (range) { range.value = String(v); range.style.setProperty('--range-progress', `${v}%`); }
    if (label) label.textContent = `${v}%`;
  }

  async function enforceNightSafety() {
    if (!isNightSafeTime()) return false;
    const cap = Math.max(0, Math.min(100, Number(cfg.nightSafeMaxVolume ?? 8)));
    if (currentVolume() <= cap) return false;
    const params = new URLSearchParams({volume: String(cap)});
    const outputId = selectedOutputId();
    if (outputId) params.set('output_id', outputId);
    try {
      const response = await nativeFetch(apiUrl(`/player/volume?${params}`), {method:'PUT'});
      if (response.ok) {
        setLocalVolume(cap);
        flashNightBadge();
        return true;
      }
    } catch (_) {}
    return false;
  }

  /* Safety guard for every manual browser playback path: cards, folders, history and search.
     Scheduler playback is server-side and therefore keeps its explicitly configured volume. */
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    const method = String(init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/api/queue/items/add') && /(?:\?|&)playback=start(?:&|$)/.test(url)) {
      await enforceNightSafety();
    }
    return nativeFetch(input, init);
  };

  function mountNightBadge() {
    if (document.getElementById('nightSafeBadge')) return;
    const dock = document.querySelector('.audio-dock');
    if (!dock) return;
    nightBadge = document.createElement('div');
    nightBadge.id = 'nightSafeBadge';
    nightBadge.className = 'night-safe-badge';
    nightBadge.innerHTML = `${icons.moon}<span>Night cap ${Number(cfg.nightSafeMaxVolume ?? 8)}%</span>`;
    nightBadge.title = `Manual playback is capped from ${String(cfg.nightSafeStartHour).padStart(2,'0')}:00 to ${String(cfg.nightSafeEndHour).padStart(2,'0')}:00`;
    dock.appendChild(nightBadge);
    renderNightBadge();
  }

  function renderNightBadge() {
    if (!nightBadge) return;
    nightBadge.classList.toggle('active', isNightSafeTime());
  }
  function flashNightBadge() {
    renderNightBadge();
    nightBadge?.classList.add('flash');
    setTimeout(() => nightBadge?.classList.remove('flash'), 1100);
  }

  async function requestApi(path, options={}) {
    const response = await nativeFetch(apiUrl(path), options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async function requestCompanion(path) {
    const response = await nativeFetch(companionUrl(path), {cache:'no-store'});
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  function mountDrawer() {
    if (document.getElementById('playbackDrawer')) return;
    const topActions = document.querySelector('.top-actions');
    if (topActions && !document.getElementById('queueDrawerButton')) {
      const button = document.createElement('button');
      button.id = 'queueDrawerButton';
      button.className = 'icon-button subtle playback-drawer-button';
      button.type = 'button';
      button.title = 'Queue & history';
      button.setAttribute('aria-label', 'Open queue and history');
      button.innerHTML = `${icons.queue}<span class="queue-count-dot" id="queueCountDot"></span>`;
      const schedulerButton = document.getElementById('schedulerButton');
      topActions.insertBefore(button, schedulerButton || topActions.firstChild);
      button.addEventListener('click', () => openDrawer('queue'));
    }

    drawer = document.createElement('aside');
    drawer.id = 'playbackDrawer';
    drawer.className = 'playback-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = `
      <div class="playback-drawer-backdrop" data-close-drawer></div>
      <section class="playback-drawer-panel" role="dialog" aria-modal="true" aria-label="Queue and listening history">
        <header class="playback-drawer-head">
          <div><span class="section-kicker">PLAYBACK</span><h2>Up next</h2></div>
          <button class="playback-drawer-close" type="button" aria-label="Close">${icons.close}</button>
        </header>
        <div class="playback-tabs" role="tablist">
          <button class="active" data-tab="queue" type="button">Queue <span id="queueTabCount">—</span></button>
          <button data-tab="history" type="button">History <span>50</span></button>
        </div>
        <div class="playback-drawer-body" id="playbackDrawerBody"></div>
        <footer class="playback-drawer-foot"><span id="drawerHint">Drag to reorder · swipe left to remove</span><span class="night-foot">${icons.moon} 00–08 · max ${Number(cfg.nightSafeMaxVolume ?? 8)}%</span></footer>
      </section>`;
    document.body.appendChild(drawer);
    body = drawer.querySelector('#playbackDrawerBody');
    drawer.querySelector('.playback-drawer-close').addEventListener('click', closeDrawer);
    drawer.querySelector('[data-close-drawer]').addEventListener('click', closeDrawer);
    drawer.querySelectorAll('[data-tab]').forEach(tab => tab.addEventListener('click', () => setTab(tab.dataset.tab)));

    const recentLink = [...document.querySelectorAll('.side-link')].find(x => /recently played/i.test(x.textContent || ''));
    if (recentLink && !document.getElementById('historyNavButton')) {
      const button = document.createElement('button');
      button.className = 'side-link';
      button.type = 'button';
      button.id = 'historyNavButton';
      button.innerHTML = '<span>↺</span>Now playing history';
      button.addEventListener('click', () => openDrawer('history'));
      recentLink.insertAdjacentElement('afterend', button);
    }
  }

  function openDrawer(tab='queue') {
    mountDrawer();
    activeTab = tab;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    setTab(tab, false);
  }
  function closeDrawer() {
    drawer?.classList.remove('open');
    drawer?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    clearTimeout(refreshTimer);
  }
  function setTab(tab, schedule=true) {
    activeTab = tab === 'history' ? 'history' : 'queue';
    drawer?.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === activeTab));
    const title = drawer?.querySelector('.playback-drawer-head h2');
    const hint = document.getElementById('drawerHint');
    if (title) title.textContent = activeTab === 'queue' ? 'Up next' : 'Recently played';
    if (hint) hint.textContent = activeTab === 'queue' ? 'Drag to reorder · swipe left to remove' : 'Tap any item to play it again';
    activeTab === 'queue' ? loadQueue() : loadHistory();
    if (schedule) scheduleRefresh();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!drawer?.classList.contains('open')) return;
    refreshTimer = setTimeout(() => activeTab === 'queue' ? loadQueue() : loadHistory(), activeTab === 'queue' ? 4000 : 12000);
  }

  async function loadQueue() {
    if (!body) return;
    try {
      const [player, now] = await Promise.all([requestApi('/player'), requestApi('/queue?id=now_playing')]);
      const current = now?.items?.[0];
      queueStart = Number(current?.position ?? 0);
      const end = queueStart + Math.max(10, Math.min(30, Number(cfg.queueLimit || 20)));
      const queue = await requestApi(`/queue?start=${queueStart}&end=${end}`);
      renderQueue(queue?.items || [], Number(queue?.count || 0), String(player?.item_id ?? ''));
    } catch (error) {
      body.innerHTML = `<div class="drawer-empty"><b>Queue unavailable</b><span>${escapeHtml(error.message)}</span></div>`;
    } finally { scheduleRefresh(); }
  }

  function renderQueue(items, total, currentId) {
    const count = document.getElementById('queueTabCount');
    const dot = document.getElementById('queueCountDot');
    if (count) count.textContent = String(total || items.length || 0);
    if (dot) { dot.textContent = total > 99 ? '99+' : String(total || ''); dot.classList.toggle('show', total > 0); }
    if (!items.length) {
      body.innerHTML = '<div class="drawer-empty"><b>Queue is empty</b><span>Start an album, playlist or radio station.</span></div>';
      return;
    }
    body.innerHTML = `<div class="queue-list">${items.map((item, i) => `
      <div class="queue-row ${String(item.id) === currentId ? 'is-playing' : ''}" draggable="true" data-id="${escapeHtml(item.id)}" data-uri="${escapeHtml(item.uri || '')}">
        <span class="queue-grip">${icons.grip}</span>
        <span class="queue-index">${String(queueStart + i + 1).padStart(2,'0')}</span>
        <span class="queue-copy"><b>${escapeHtml(item.title || 'Untitled')}</b><small>${escapeHtml([item.artist, item.album].filter(Boolean).join(' · ') || (item.data_kind === 'url' ? 'Live radio' : 'OwnTone'))}</small></span>
        <span class="queue-quality">${escapeHtml(quality(item))}</span>
        <button class="queue-delete" type="button" aria-label="Remove from queue">${icons.trash}</button>
      </div>`).join('')}</div>`;
    wireQueueRows();
  }

  function wireQueueRows() {
    const list = body.querySelector('.queue-list');
    if (!list) return;
    let dragged;
    list.querySelectorAll('.queue-row').forEach(row => {
      row.addEventListener('dragstart', e => { dragged = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', async () => {
        row.classList.remove('dragging');
        if (!dragged) return;
        const newIndex = [...list.querySelectorAll('.queue-row')].indexOf(dragged);
        const id = dragged.dataset.id;
        dragged = null;
        try { await requestApi(`/queue/items/${encodeURIComponent(id)}?new_position=${queueStart + newIndex}`, {method:'PUT'}); await loadQueue(); }
        catch (_) { await loadQueue(); }
      });
      row.addEventListener('dragover', e => {
        if (!dragged || dragged === row) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        list.insertBefore(dragged, e.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
      });
      row.querySelector('.queue-delete').addEventListener('click', e => { e.stopPropagation(); removeQueueItem(row); });
      wireSwipeDelete(row);
    });
  }

  async function removeQueueItem(row) {
    if (!row?.dataset.id) return;
    row.classList.add('removing');
    try { await requestApi(`/queue/items/${encodeURIComponent(row.dataset.id)}`, {method:'DELETE'}); setTimeout(loadQueue, 140); }
    catch (_) { row.classList.remove('removing'); }
  }

  function wireSwipeDelete(row) {
    let startX = 0, startY = 0, dx = 0, tracking = false;
    row.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || e.target.closest('button,.queue-grip')) return;
      tracking = true; startX = e.clientX; startY = e.clientY; dx = 0;
    });
    row.addEventListener('pointermove', e => {
      if (!tracking) return;
      const x = e.clientX - startX, y = e.clientY - startY;
      if (Math.abs(y) > Math.abs(x) && Math.abs(y) > 12) { tracking = false; row.style.transform = ''; return; }
      dx = Math.min(0, x);
      if (dx < -8) row.style.transform = `translateX(${Math.max(-96, dx)}px)`;
    });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (dx < -72) removeQueueItem(row); else row.style.transform = '';
    };
    row.addEventListener('pointerup', end); row.addEventListener('pointercancel', end);
  }

  async function loadHistory() {
    if (!body) return;
    try {
      const data = await requestCompanion(`/history?limit=${Math.max(20, Math.min(50, Number(cfg.historyLimit || 50)))}`);
      renderHistory(data?.items || []);
    } catch (error) {
      body.innerHTML = `<div class="drawer-empty"><b>History unavailable</b><span>Restart the dashboard companion service after deploying this build.</span></div>`;
    } finally { scheduleRefresh(); }
  }

  function renderHistory(items) {
    if (!items.length) {
      body.innerHTML = '<div class="drawer-empty"><b>No history yet</b><span>Played tracks and radio metadata will appear here automatically.</span></div>';
      return;
    }
    body.innerHTML = `<div class="history-list">${items.map(item => `
      <button class="history-row" type="button" ${item.play_uri ? `data-uri="${escapeHtml(item.play_uri)}"` : 'disabled'}>
        <span class="history-art">${item.is_radio ? 'LIVE' : '♪'}</span>
        <span class="history-copy"><b>${escapeHtml(item.title || item.station_name || 'Unknown')}</b><small>${escapeHtml([item.artist || item.station_name, item.album].filter(Boolean).join(' · ') || (item.is_radio ? 'Radio' : 'OwnTone'))}</small></span>
        <span class="history-meta"><em>${escapeHtml(quality(item))}</em><small>${escapeHtml(fmtTime(item.played_at))}</small></span>
        <span class="history-play">${icons.play}</span>
      </button>`).join('')}</div>`;
    body.querySelectorAll('.history-row[data-uri]').forEach(row => row.addEventListener('click', async () => {
      const uri = row.dataset.uri;
      if (!uri) return;
      row.classList.add('starting');
      try {
        const qs = new URLSearchParams({uris:uri, clear:'true', playback:'start'});
        await requestApi(`/queue/items/add?${qs}`, {method:'POST'});
        closeDrawer();
      } catch (_) { row.classList.remove('starting'); }
    }));
  }

  function mount() {
    mountDrawer();
    mountNightBadge();
    renderNightBadge();
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drawer?.classList.contains('open')) closeDrawer();
  });
  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();
  setInterval(renderNightBadge, 60000);
})();
