(() => {
  'use strict';

  const {
    config: cfg,
    api: requestApi,
    scheduler: requestCompanion,
    escapeHtml,
    toast: say,
    icons,
    nightSafe,
    on,
    startPlayback,
  } = window.OwnTone;

  let drawer;
  let body;
  let activeTab = 'queue';
  let queueStart = 0;
  let refreshTimer;
  let nightBadge;

  /** A play timestamp as HH:MM — not the same thing as shared formatTime(ms). */
  function formatClock(value) {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(value)
      );
    } catch (_) {
      return '';
    }
  }

  function quality(item) {
    const type = String(item?.type || '').toUpperCase();
    const bitrate = String(item?.bitrate || '').trim();
    if (type === 'FLAC' || type === 'ALAC') return type;
    if (bitrate) return `${type || 'AUDIO'} ${bitrate}${/^\d+$/.test(bitrate) ? 'k' : ''}`;
    return type || (item?.is_radio ? 'RADIO' : 'AUDIO');
  }

  /** "00–08" for the configured window — the badge and the drawer read the same. */
  function nightWindowText() {
    const hour = value => String(Math.max(0, Math.min(23, Number(value) || 0))).padStart(2, '0');
    return `${hour(cfg.nightSafeStartHour)}–${hour(cfg.nightSafeEndHour)}`;
  }

  function mountNightBadge() {
    if (document.getElementById('nightSafeBadge')) return;
    const dock = document.querySelector('.audio-dock');
    if (!dock) return;
    nightBadge = document.createElement('div');
    nightBadge.id = 'nightSafeBadge';
    nightBadge.className = 'night-safe-badge';
    nightBadge.innerHTML = `${icons.moon}<span>Night cap ${nightSafe.cap}%</span>`;
    nightBadge.title = `Manual playback is capped from ${nightWindowText().replace('–', ':00 to ')}:00`;
    dock.appendChild(nightBadge);
    renderNightBadge();
  }

  function renderNightBadge() {
    if (!nightBadge) return;
    nightBadge.classList.toggle('active', nightSafe.isActive());
  }
  function flashNightBadge() {
    renderNightBadge();
    nightBadge?.classList.add('flash');
    setTimeout(() => nightBadge?.classList.remove('flash'), 1100);
  }

  // shared.js applies the cap; this module only owns the badge that shows it.
  on('owntone:night-cap-applied', flashNightBadge);

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
      const schedulerButton = document.getElementById('scheduleButton');
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
        <div class="playback-toolbar" id="playbackToolbar">
          <span class="playback-toolbar-search">${icons.search}</span>
          <input id="queueFilter" type="search" placeholder="Filter queue…" aria-label="Filter queue" autocomplete="off">
          <button id="queueJumpNow" type="button" title="Jump to playing" aria-label="Jump to playing">${icons.now}</button>
          <button id="queueClear" type="button" title="Clear queue (click twice)" aria-label="Clear queue">${icons.trash}</button>
        </div>
        <div class="playback-drawer-body" id="playbackDrawerBody"></div>
        <footer class="playback-drawer-foot"><span id="drawerHint">Drag to reorder · swipe left to remove</span><span class="night-foot">${icons.moon} ${nightWindowText()} · max ${nightSafe.cap}%</span></footer>
      </section>`;
    document.body.appendChild(drawer);
    body = drawer.querySelector('#playbackDrawerBody');
    drawer.querySelector('.playback-drawer-close').addEventListener('click', closeDrawer);
    drawer.querySelector('[data-close-drawer]').addEventListener('click', closeDrawer);
    drawer
      .querySelectorAll('[data-tab]')
      .forEach(tab => tab.addEventListener('click', () => setTab(tab.dataset.tab)));

    const filterInput = drawer.querySelector('#queueFilter');
    let filterTimer;
    filterInput.addEventListener('input', () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => applyQueueFilter(filterInput.value.trim()), 250);
    });
    filterInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        filterInput.value = '';
        applyQueueFilter('');
      }
    });
    drawer.querySelector('#queueJumpNow').addEventListener('click', () => {
      filterInput.value = '';
      setTab('queue');
      body?.scrollTo({ top: 0, behavior: 'smooth' });
    });
    let clearArm = 0;
    const clearBtn = drawer.querySelector('#queueClear');
    clearBtn.addEventListener('click', async () => {
      if (Date.now() - clearArm > 2500) {
        clearArm = Date.now();
        clearBtn.classList.add('arm');
        setTimeout(() => clearBtn.classList.remove('arm'), 2500);
        return;
      }
      clearArm = 0;
      clearBtn.classList.remove('arm');
      try {
        await requestApi('/queue/clear', { method: 'PUT' });
        say('Queue cleared');
        loadQueue();
      } catch (error) {
        say(`Clear failed: ${error.message}`);
      }
    });

    const recentLink = [...document.querySelectorAll('.side-link')].find(x =>
      /recently played/i.test(x.textContent || '')
    );
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

  function openDrawer(tab = 'queue') {
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
  function setTab(tab, schedule = true) {
    activeTab = tab === 'history' ? 'history' : 'queue';
    drawer
      ?.querySelectorAll('[data-tab]')
      .forEach(x => x.classList.toggle('active', x.dataset.tab === activeTab));
    const title = drawer?.querySelector('.playback-drawer-head h2');
    const hint = document.getElementById('drawerHint');
    if (title) title.textContent = activeTab === 'queue' ? 'Up next' : 'Recently played';
    if (hint)
      hint.textContent =
        activeTab === 'queue' ? 'Drag to reorder · swipe left to remove' : 'Tap any item to play it again';
    const toolbar = document.getElementById('playbackToolbar');
    if (toolbar) toolbar.hidden = activeTab !== 'queue';
    activeTab === 'queue' ? loadQueue() : loadHistory();
    if (schedule) scheduleRefresh();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!drawer?.classList.contains('open')) return;
    refreshTimer = setTimeout(
      () => (activeTab === 'queue' ? loadQueue() : loadHistory()),
      activeTab === 'queue' ? 4000 : 12000
    );
  }

  async function loadQueue() {
    const q = document.getElementById('queueFilter')?.value?.trim();
    if (q) return applyQueueFilter(q);
    if (!body) return;
    try {
      const [player, now] = await Promise.all([requestApi('/player'), requestApi('/queue?id=now_playing')]);
      const current = now?.items?.[0];
      queueStart = Number(current?.position ?? 0);
      const end = queueStart + Math.max(10, Math.min(30, Number(cfg.queueLimit || 20)));
      const queue = await requestApi(`/queue?start=${queueStart}&end=${end}`);
      renderQueue(queue?.items || [], Number(queue?.count || 0), String(player?.item_id ?? ''), current);
    } catch (error) {
      body.innerHTML = `<div class="drawer-empty"><b>Queue unavailable</b><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      scheduleRefresh();
    }
  }

  function queueRowHtml(item, currentId, index) {
    // The item's own position when OwnTone reports one. Filtered results are
    // fetched from the head of the queue, so offsetting them by queueStart --
    // the *playing* item's position -- numbered every match wrongly.
    const position = Number.isFinite(Number(item.position))
      ? Number(item.position) + 1
      : queueStart + index + 1;
    return `<div class="queue-row ${String(item.id) === currentId ? 'is-playing' : ''}" draggable="true" data-id="${escapeHtml(item.id)}" data-uri="${escapeHtml(item.uri || '')}">
        <span class="queue-grip">${icons.grip}</span>
        <span class="queue-index">${String(position).padStart(2, '0')}</span>
        <span class="queue-copy"><b>${escapeHtml(item.title || 'Untitled')}</b><small>${escapeHtml([item.artist, item.album].filter(Boolean).join(' · ') || (item.data_kind === 'url' ? 'Live radio' : 'OwnTone'))}</small></span>
        <span class="queue-quality">${escapeHtml(quality(item))}</span>
        <button class="queue-delete" type="button" aria-label="Remove from queue">${icons.trash}</button>
      </div>`;
  }

  async function applyQueueFilter(q) {
    if (!body) return;
    if (!q) return loadQueue();
    try {
      const data = await requestApi('/queue?start=0&end=500');
      const needle = q.toLowerCase();
      const items = (data?.items || [])
        .filter(it => `${it.title || ''} ${it.artist || ''} ${it.album || ''}`.toLowerCase().includes(needle))
        .slice(0, 60);
      const total = Number(data?.count || 0);
      const count = document.getElementById('queueTabCount');
      if (count) count.textContent = `${items.length}/${total}`;
      if (items.length) {
        body.innerHTML = `<div class="queue-list is-filtered">${items.map((item, i) => queueRowHtml(item, '', i)).join('')}</div>`;
        body.querySelectorAll('.queue-delete').forEach(btn =>
          btn.addEventListener('click', e => {
            e.stopPropagation();
            removeQueueItem(btn.closest('.queue-row'));
          })
        );
      } else {
        body.innerHTML = `<div class="drawer-empty"><b>No matches</b><span>Nothing in the first 500 queue items.</span></div>`;
      }
    } catch (error) {
      body.innerHTML = `<div class="drawer-empty"><b>Filter failed</b><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      scheduleRefresh();
    }
  }

  // `nowPlaying` is the item from /queue?id=now_playing. A live stream reports no
  // upcoming items, so it is the only thing left to show when `items` is empty.
  function renderQueue(items, total, currentId, nowPlaying) {
    const count = document.getElementById('queueTabCount');
    const dot = document.getElementById('queueCountDot');
    if (count) count.textContent = String(total || items.length || 0);
    if (dot) {
      dot.textContent = total > 99 ? '99+' : String(total || '');
      dot.classList.toggle('show', total > 0);
    }

    if (items.length) {
      body.innerHTML = `<div class="queue-list">${items.map((item, i) => queueRowHtml(item, currentId, i)).join('')}</div>`;
      wireQueueRows();
      return;
    }

    if (!nowPlaying) {
      body.innerHTML =
        '<div class="drawer-empty"><b>Queue is empty</b><span>Start an album, playlist or radio station.</span></div>';
      return;
    }

    const live = nowPlaying.data_kind === 'url' || /^https?:\/\//i.test(String(nowPlaying.path || ''));
    const subtitle =
      [nowPlaying.artist, nowPlaying.album].filter(Boolean).join(' · ') ||
      (live ? 'Live radio · on air' : 'Now playing');
    const note = live ? 'Live stream — no upcoming items. Stop with the pause button.' : 'End of queue.';

    body.innerHTML = `
      <div class="queue-list">
        <div class="queue-row is-playing live-only" data-id="${escapeHtml(nowPlaying.id)}">
          <span class="queue-grip">${icons.grip}</span>
          <span class="queue-index">●</span>
          <span class="queue-copy">
            <b>${escapeHtml(nowPlaying.title || 'Live radio')}</b>
            <small>${escapeHtml(subtitle)}</small>
          </span>
          <span class="queue-quality">${escapeHtml(quality(nowPlaying))}</span>
          <button class="queue-delete" type="button" aria-label="Remove from queue">${icons.trash}</button>
        </div>
      </div>
      <div class="queue-live-note">${note}</div>`;
    wireQueueRows();
  }

  function wireQueueRows() {
    const list = body.querySelector('.queue-list');
    if (!list) return;
    let dragged;
    list.querySelectorAll('.queue-row').forEach(row => {
      row.addEventListener('dragstart', e => {
        dragged = row;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', async () => {
        row.classList.remove('dragging');
        if (!dragged) return;
        const newIndex = [...list.querySelectorAll('.queue-row')].indexOf(dragged);
        const id = dragged.dataset.id;
        dragged = null;
        try {
          await requestApi(`/queue/items/${encodeURIComponent(id)}?new_position=${queueStart + newIndex}`, {
            method: 'PUT',
          });
          await loadQueue();
        } catch (_) {
          await loadQueue();
        }
      });
      row.addEventListener('dragover', e => {
        if (!dragged || dragged === row) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        list.insertBefore(dragged, e.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
      });
      row.querySelector('.queue-delete').addEventListener('click', e => {
        e.stopPropagation();
        removeQueueItem(row);
      });
      wireSwipeDelete(row);
    });
  }

  async function removeQueueItem(row) {
    if (!row?.dataset.id) return;
    row.classList.add('removing');
    try {
      await requestApi(`/queue/items/${encodeURIComponent(row.dataset.id)}`, { method: 'DELETE' });
      setTimeout(loadQueue, 140);
    } catch (_) {
      row.classList.remove('removing');
    }
  }

  function wireSwipeDelete(row) {
    let startX = 0,
      startY = 0,
      dx = 0,
      tracking = false,
      pid = 0;
    row.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || e.target.closest('button,.queue-grip')) return;
      tracking = true;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      pid = e.pointerId;
      try {
        row.setPointerCapture(pid);
      } catch (_) {}
    });
    row.addEventListener('pointermove', e => {
      if (!tracking) return;
      const x = e.clientX - startX,
        y = e.clientY - startY;
      if (Math.abs(y) > Math.abs(x) && Math.abs(y) > 12) {
        tracking = false;
        row.style.transform = '';
        return;
      }
      dx = Math.min(0, x);
      if (dx < -8) row.style.transform = `translateX(${Math.max(-96, dx)}px)`;
    });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (dx < -72) removeQueueItem(row);
      else row.style.transform = '';
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);
  }

  async function loadHistory() {
    if (!body) return;
    try {
      const data = await requestCompanion(
        `/history?limit=${Math.max(20, Math.min(50, Number(cfg.historyLimit || 50)))}`
      );
      renderHistory(data?.items || []);
    } catch (error) {
      body.innerHTML = `<div class="drawer-empty"><b>History unavailable</b><span>Restart the dashboard companion service after deploying this build.</span></div>`;
    } finally {
      scheduleRefresh();
    }
  }

  function renderHistory(items) {
    if (!items.length) {
      body.innerHTML =
        '<div class="drawer-empty"><b>No history yet</b><span>Played tracks and radio metadata will appear here automatically.</span></div>';
      return;
    }
    body.innerHTML = `<div class="history-list">${items
      .map(
        item => `
      <button class="history-row" type="button" ${item.play_uri ? `data-uri="${escapeHtml(item.play_uri)}"` : 'disabled'}>
        <span class="history-art">${item.is_radio ? 'LIVE' : '♪'}</span>
        <span class="history-copy"><b>${escapeHtml(item.title || item.station_name || 'Unknown')}</b><small>${escapeHtml([item.artist || item.station_name, item.album].filter(Boolean).join(' · ') || (item.is_radio ? 'Radio' : 'OwnTone'))}</small></span>
        <span class="history-meta"><em>${escapeHtml(quality(item))}</em><small>${escapeHtml(formatClock(item.played_at))}</small></span>
        <span class="history-play">${icons.play}</span>
      </button>`
      )
      .join('')}</div>`;
    body.querySelectorAll('.history-row[data-uri]').forEach(row =>
      row.addEventListener('click', async () => {
        const uri = row.dataset.uri;
        if (!uri) return;
        row.classList.add('starting');
        try {
          // Replaying from history used to build its own request against a
          // pre-patch copy of fetch, which is how it slipped past the night cap.
          await startPlayback({ uris: uri });
          window.OWNTONE_SYNC_PLAYBACK_MODE?.(uri);
          closeDrawer();
        } catch (error) {
          row.classList.remove('starting');
          say(`Could not play: ${error.message}`);
        }
      })
    );
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
