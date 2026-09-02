(() => {
  'use strict';

  const { scheduler, toast, icons, escapeHtml } = window.OwnTone;
  const $ = id => document.getElementById(id);
  const app = () => window.OWNTONE_APP || null;
  const state = () => app()?.state || {};
  const heart =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
  const heartFill = heart.replace('<svg ', '<svg class="fill" ');
  const moreIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>';
  const browseIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8 4.8-2.2Z"/></svg>';
  const statsIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V11M12 19V5M19 19v-7"/></svg>';
  const playlistIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h11M8 12h11M8 17h7"/><circle cx="4" cy="7" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17" r="1"/></svg>';
  const updateIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/></svg>';
  const upIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
  const downIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  let trackDialog;
  let playlistDialog;
  let moreDialog;
  let currentFavorite = false;
  let lastToken = '';
  let favoriteRequest = 0;

  const current = () => state().current || null;
  const token = () => {
    const item = current() || {};
    return String(item.id ?? item.track_id ?? item.path ?? `${item.title || ''}|${item.artist || ''}`);
  };
  const isLive = () => {
    const item = current() || {};
    return item.data_kind === 'url' || /^https?:\/\//i.test(String(item.path || item.uri || ''));
  };
  const currentPath = () => {
    const item = current() || {};
    return (
      [item.path, item.uri].map(value => String(value || '').trim()).find(value => /^\//.test(value)) || ''
    );
  };
  const isDemo = () => !!state().demo;
  const demoKey = () => `owntone-demo-favorite:${token()}`;

  function readDemoFavorite() {
    try {
      return localStorage.getItem(demoKey()) === '1';
    } catch (_) {
      return false;
    }
  }
  function writeDemoFavorite(value) {
    try {
      if (value) localStorage.setItem(demoKey(), '1');
      else localStorage.removeItem(demoKey());
    } catch (_) {}
  }

  async function editablePlaylists() {
    return (await scheduler('/playlists', { cache: 'no-store' }))?.items || [];
  }
  function favoritesFrom(items) {
    return (
      items.find(
        item =>
          String(item.name || '')
            .trim()
            .toLowerCase() === 'favorites'
      ) || null
    );
  }
  async function ensureFavorites() {
    let items = await editablePlaylists();
    let favorites = favoritesFrom(items);
    if (favorites) return favorites;
    await scheduler('/playlists', { method: 'POST', body: { name: 'Favorites' } });
    items = await editablePlaylists();
    favorites = favoritesFrom(items);
    if (!favorites) throw new Error('Favorites playlist could not be created');
    return favorites;
  }
  const savePlaylist = (playlist, lines) =>
    scheduler(`/playlists/${encodeURIComponent(playlist.slug)}`, { method: 'PUT', body: { lines } });

  function favoriteControls() {
    return [
      ...document.querySelectorAll(
        '.transport-row .micro-action[data-playlist-name="Favorites"], .dock-heart[data-playlist-name="Favorites"], [data-safe-favorite]'
      ),
    ];
  }
  function bindFavorite(button) {
    if (!button || button.dataset.safeFavoriteBound === '1') return;
    button.dataset.safeFavoriteBound = '1';
    button.dataset.safeFavorite = '1';
    button.classList.add('current-favorite-control');
    button.removeAttribute('data-action');
    button.removeAttribute('data-playlist-name');
    button.removeAttribute('data-playlist');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleFavorite();
    });
  }
  function renderFavorites() {
    const item = current();
    favoriteControls().forEach(button => {
      bindFavorite(button);
      button.classList.toggle('is-current-favorite', currentFavorite);
      const visual = currentFavorite ? 'filled' : 'outline';
      if (button.dataset.safeFavoriteVisual !== visual) {
        button.innerHTML = currentFavorite ? heartFill : heart;
        button.dataset.safeFavoriteVisual = visual;
      }
      const label = isLive()
        ? 'Pin this radio station from its station card'
        : currentFavorite
          ? 'Remove current track from Favorites'
          : 'Add current track to Favorites';
      button.disabled = !item;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(currentFavorite));
      button.title = label;
    });
    const action = $('safeTrackFavorite');
    if (action) {
      action.innerHTML = `${currentFavorite ? heartFill : heart}<span>${currentFavorite ? 'Remove from Favorites' : 'Add to Favorites'}</span>`;
      action.classList.toggle('active', currentFavorite);
      action.disabled = !current() || isLive();
    }
  }
  async function syncFavorite() {
    const request = ++favoriteRequest;
    if (!current() || isLive()) currentFavorite = false;
    else if (isDemo()) currentFavorite = readDemoFavorite();
    else if (!currentPath()) currentFavorite = false;
    else {
      try {
        currentFavorite = !!favoritesFrom(await editablePlaylists())?.lines?.includes(currentPath());
      } catch (_) {
        currentFavorite = false;
      }
    }
    if (request === favoriteRequest) renderFavorites();
  }
  async function toggleFavorite() {
    if (!current()) return toast('Nothing is playing');
    if (isLive()) return toast('Pin live radio from its station card');
    if (isDemo()) {
      currentFavorite = !readDemoFavorite();
      writeDemoFavorite(currentFavorite);
      renderFavorites();
      return toast(currentFavorite ? 'Added to Favorites' : 'Removed from Favorites');
    }
    const path = currentPath();
    if (!path) return toast('This track has no file path that can be saved');
    try {
      const favorites = await ensureFavorites();
      const lines = [...(favorites.lines || [])];
      const index = lines.indexOf(path);
      if (index >= 0) lines.splice(index, 1);
      else lines.push(path);
      await savePlaylist(favorites, lines);
      currentFavorite = index < 0;
      renderFavorites();
      toast(currentFavorite ? 'Added to Favorites' : 'Removed from Favorites');
      setTimeout(() => app()?.refreshLibrary?.(), 4000);
    } catch (error) {
      toast(`Favorites failed: ${error.message}`);
    }
  }

  function ensureTrackDialog() {
    if (trackDialog) return trackDialog;
    trackDialog = document.createElement('dialog');
    trackDialog.id = 'safeTrackActionsDialog';
    trackDialog.className = 'ux-dialog ux-actions-dialog';
    trackDialog.innerHTML = `
      <div class="ux-dialog-panel">
        <header class="ux-dialog-head"><div><span class="section-kicker">NOW PLAYING</span><h2>Track actions</h2></div><button type="button" class="ux-dialog-close" aria-label="Close">${icons.close}</button></header>
        <div class="ux-track-summary"><b id="safeTrackActionTitle">OwnTone</b><span id="safeTrackActionArtist"></span></div>
        <div class="ux-action-list">
          <button id="safeTrackFavorite" type="button">${heart}<span>Add to Favorites</span></button>
          <button id="safeTrackPlaylist" type="button">${playlistIcon}<span>Add to playlist</span></button>
          <button id="safeTrackDetails" type="button">${icons.info}<span>Track details</span></button>
        </div>
      </div>`;
    document.body.appendChild(trackDialog);
    trackDialog.querySelector('.ux-dialog-close').addEventListener('click', () => trackDialog.close());
    trackDialog.addEventListener('click', event => {
      if (event.target === trackDialog) trackDialog.close();
    });
    $('safeTrackFavorite').addEventListener('click', toggleFavorite);
    $('safeTrackPlaylist').addEventListener('click', () => {
      trackDialog.close();
      openAddToPlaylist();
    });
    $('safeTrackDetails').addEventListener('click', () => {
      trackDialog.close();
      ($('trackInfoButton') || $('playingFrom'))?.click();
    });
    return trackDialog;
  }
  function openTrackActions() {
    ensureTrackDialog();
    const item = current() || {};
    $('safeTrackActionTitle').textContent = item.title || $('trackTitle')?.textContent || 'Nothing playing';
    $('safeTrackActionArtist').textContent = item.artist || $('trackArtist')?.textContent || 'OwnTone';
    $('safeTrackPlaylist').disabled = !currentPath() || isLive();
    renderFavorites();
    trackDialog.showModal?.();
  }

  function ensurePlaylistDialog() {
    if (playlistDialog) return playlistDialog;
    playlistDialog = document.createElement('dialog');
    playlistDialog.id = 'safeAddPlaylistDialog';
    playlistDialog.className = 'ux-dialog';
    playlistDialog.innerHTML = `
      <form class="ux-dialog-panel" id="safeAddPlaylistForm">
        <header class="ux-dialog-head"><div><span class="section-kicker">PLAYLIST</span><h2>Add current track</h2></div><button type="button" class="ux-dialog-close" aria-label="Close">${icons.close}</button></header>
        <p class="ux-dialog-copy" id="safePlaylistTrackLabel"></p>
        <label class="ux-field"><span>Existing playlist</span><select id="safePlaylistSelect"></select></label>
        <div class="ux-or"><span>or create a new one</span></div>
        <label class="ux-field"><span>New playlist name</span><input id="safePlaylistNewName" type="text" maxlength="60" placeholder="e.g. Evening"></label>
        <div class="ux-dialog-actions"><button type="button" class="ux-secondary" id="safeManagePlaylists">Manage playlists</button><button type="submit" class="ux-primary">Add track</button></div>
      </form>`;
    document.body.appendChild(playlistDialog);
    playlistDialog.querySelector('.ux-dialog-close').addEventListener('click', () => playlistDialog.close());
    playlistDialog.addEventListener('click', event => {
      if (event.target === playlistDialog) playlistDialog.close();
    });
    $('safeManagePlaylists').addEventListener('click', () => {
      playlistDialog.close();
      $('managePlaylists')?.click();
    });
    $('safeAddPlaylistForm').addEventListener('submit', addCurrentToPlaylist);
    return playlistDialog;
  }
  async function openAddToPlaylist() {
    const path = currentPath();
    if (!current() || isLive() || !path)
      return toast(
        isLive() ? 'Live radio cannot be added as a track' : 'This track has no savable file path'
      );
    ensurePlaylistDialog();
    $('safePlaylistTrackLabel').textContent =
      `${current()?.title || 'Current track'} · ${current()?.artist || 'OwnTone'}`;
    const select = $('safePlaylistSelect');
    select.innerHTML = '<option value="">Loading playlists…</option>';
    $('safePlaylistNewName').value = '';
    playlistDialog.showModal?.();
    try {
      const items = await editablePlaylists();
      select.innerHTML = items.length
        ? items
            .map(
              item =>
                `<option value="${escapeHtml(item.slug)}">${escapeHtml(item.name)} · ${item.track_count || 0} tracks</option>`
            )
            .join('')
        : '<option value="">No editable playlists yet</option>';
    } catch (error) {
      select.innerHTML = '<option value="">Playlists unavailable</option>';
      toast(`Playlist list failed: ${error.message}`);
    }
  }
  async function addCurrentToPlaylist(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit?.setAttribute('disabled', '');
    try {
      let items = await editablePlaylists();
      const name = $('safePlaylistNewName').value.trim();
      let playlist;
      if (name) {
        const created = await scheduler('/playlists', { method: 'POST', body: { name } });
        items = await editablePlaylists();
        playlist = items.find(item => item.slug === created?.slug) || items.find(item => item.name === name);
      } else playlist = items.find(item => item.slug === $('safePlaylistSelect').value);
      if (!playlist) throw new Error('Choose or create a playlist');
      const lines = [...(playlist.lines || [])];
      const path = currentPath();
      if (!path) throw new Error('Current track is unavailable');
      if (lines.includes(path)) {
        playlistDialog.close();
        return toast(`Already in ${playlist.name}`);
      }
      lines.push(path);
      await savePlaylist(playlist, lines);
      playlistDialog.close();
      toast(`Added to ${playlist.name}`);
      setTimeout(() => app()?.refreshLibrary?.(), 4000);
    } catch (error) {
      toast(`Playlist update failed: ${error.message}`);
    } finally {
      submit?.removeAttribute('disabled');
    }
  }

  function scrollTo(id, label) {
    const section = $(id);
    if (!section) return toast(`${label} is available after the library connects`);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function openHistory() {
    $('queueDrawerButton')?.click();
    setTimeout(() => document.querySelector('#playbackDrawer [data-tab="history"]')?.click(), 0);
  }
  function ensureMoreDialog() {
    if (moreDialog) return moreDialog;
    moreDialog = document.createElement('dialog');
    moreDialog.id = 'safeMoreDialog';
    moreDialog.className = 'ux-dialog ux-more-dialog';
    moreDialog.innerHTML = `
      <div class="ux-dialog-panel">
        <header class="ux-dialog-head"><div><span class="section-kicker">OWN TONE</span><h2>More</h2></div><button type="button" class="ux-dialog-close" aria-label="Close">${icons.close}</button></header>
        <div class="ux-more-grid">
          <button type="button" data-safe-more="track">${moreIcon}<span>Track actions</span></button>
          <button type="button" data-safe-more="queue">${icons.queue}<span>Queue</span></button>
          <button type="button" data-safe-more="history">${icons.clock}<span>History</span></button>
          <button type="button" data-safe-more="browse">${browseIcon}<span>Browse</span></button>
          <button type="button" data-safe-more="insights">${statsIcon}<span>Insights</span></button>
          <button type="button" data-safe-more="schedule">${icons.clock}<span>Schedule</span></button>
          <button type="button" data-safe-more="playlists">${playlistIcon}<span>Edit playlists</span></button>
          <button type="button" data-safe-more="stations">${icons.radio}<span>Manage stations</span></button>
          <button type="button" data-safe-more="notifications">${icons.info}<span>Notifications</span></button>
          <button type="button" data-safe-more="update">${updateIcon}<span>Update dashboard</span></button>
        </div>
      </div>`;
    document.body.appendChild(moreDialog);
    moreDialog.querySelector('.ux-dialog-close').addEventListener('click', () => moreDialog.close());
    moreDialog.addEventListener('click', event => {
      if (event.target === moreDialog) return moreDialog.close();
      const action = event.target.closest('[data-safe-more]')?.dataset.safeMore;
      if (!action) return;
      moreDialog.close();
      if (action === 'track') openTrackActions();
      else if (action === 'queue') $('queueDrawerButton')?.click();
      else if (action === 'history') openHistory();
      else if (action === 'browse') scrollTo('browseSection', 'Browse');
      else if (action === 'insights') scrollTo('insightsSection', 'Insights');
      else if (action === 'schedule') $('scheduleButton')?.click();
      else if (action === 'playlists') $('managePlaylists')?.click();
      else if (action === 'stations') $('manageStations')?.click();
      else if (action === 'notifications') $('notifyButton')?.click();
      else if (action === 'update') $('dashboardUpdateButton')?.click();
    });
    return moreDialog;
  }
  function openMore() {
    ensureMoreDialog();
    const radio = document.body.classList.contains('radio-mode');
    moreDialog.querySelector('[data-safe-more="stations"]').hidden = !radio;
    moreDialog.querySelector('[data-safe-more="playlists"]').hidden = radio;
    const update = moreDialog.querySelector('[data-safe-more="update"]');
    const updater = $('dashboardUpdateButton');
    update.hidden = !updater || updater.hidden;
    update.disabled = !!updater?.disabled;
    moreDialog.showModal?.();
  }

  function cleanMobileNav() {
    $('muteNavButton')?.remove();
    document.querySelector('.mobile-nav')?.style.removeProperty('grid-template-columns');
  }
  function sideButton(id, label, icon, target) {
    const button = document.createElement('button');
    button.id = id;
    button.className = 'side-link ux-side-link';
    button.type = 'button';
    button.innerHTML = `<span>${icon}</span>${label}`;
    button.addEventListener('click', () => scrollTo(target, label));
    return button;
  }
  function cleanSidebar() {
    const nav = document.querySelector('.side-nav');
    if (!nav) return;
    nav.querySelector('[data-nav="recent"]')?.remove();
    const history = $('historyNavButton');
    if (history && history.dataset.safeHistory !== '1') {
      history.dataset.safeHistory = '1';
      history.innerHTML = `<span>${icons.clock}</span>History`;
      history.title = 'Queue and listening history';
    }
    const quick = [...nav.querySelectorAll('.nav-label')].find(label =>
      /quick access/i.test(label.textContent || '')
    );
    if (!quick) return;
    if (!$('browseNavButton'))
      quick.insertAdjacentElement(
        'beforebegin',
        sideButton('browseNavButton', 'Browse', browseIcon, 'browseSection')
      );
    if (!$('insightsNavButton'))
      quick.insertAdjacentElement(
        'beforebegin',
        sideButton('insightsNavButton', 'Insights', statsIcon, 'insightsSection')
      );
  }

  function enhanceDock() {
    const track = $('leftMoreButton');
    if (track && track.dataset.safeLabel !== '1') {
      track.dataset.safeLabel = '1';
      track.setAttribute('aria-label', 'Current track actions');
      track.title = 'Track actions';
      track.innerHTML = moreIcon;
    }
    const more = $('dockMoreButton');
    if (more && more.dataset.safeLabel !== '1') {
      more.dataset.safeLabel = '1';
      more.setAttribute('aria-label', 'More dashboard options');
      more.title = 'More';
      more.innerHTML = browseIcon;
    }
  }
  function enhanceTrackAccess() {
    const info = $('trackInfoButton');
    if (!info || $('trackActionsButton')) return;
    const button = document.createElement('button');
    button.id = 'trackActionsButton';
    button.className = 'track-chip track-chip--info track-actions-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Current track actions');
    button.title = 'Track actions';
    button.innerHTML = moreIcon;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openTrackActions();
    });
    info.insertAdjacentElement('afterend', button);
  }
  function enhanceFullscreen() {
    const fullscreen = $('fullscreenNowPlaying');
    const controls = fullscreen?.querySelector('.fullscreen-controls');
    if (!fullscreen || !controls || $('fullscreenVolumeRange')) return;
    const volume = Number($('volumeRange')?.value || 0);
    const utility = document.createElement('div');
    utility.className = 'fullscreen-utility-row';
    utility.innerHTML = `
      <label class="fullscreen-volume-control" for="fullscreenVolumeRange">${icons.output}<input id="fullscreenVolumeRange" type="range" min="0" max="100" value="${volume}" aria-label="Fullscreen volume"><output id="fullscreenVolumeValue">${volume}%</output></label>
      <button type="button" id="fullscreenFavoriteButton" data-safe-favorite aria-label="Add current track to Favorites">${heart}</button>
      <button type="button" id="fullscreenTrackActionsButton" aria-label="Current track actions">${moreIcon}</button>
      <button type="button" id="fullscreenQueueButton" aria-label="Open queue">${icons.queue}</button>`;
    controls.insertAdjacentElement('afterend', utility);
    const fullVolume = $('fullscreenVolumeRange');
    const mirrorVolume = eventName => {
      const main = $('volumeRange');
      if (!main) return;
      main.value = fullVolume.value;
      main.dispatchEvent(new Event(eventName, { bubbles: true }));
      syncFullscreenVolume();
    };
    fullVolume.addEventListener('input', () => mirrorVolume('input'));
    fullVolume.addEventListener('change', () => mirrorVolume('change'));
    $('fullscreenTrackActionsButton').addEventListener('click', () => {
      fullscreen.close?.();
      setTimeout(openTrackActions, 0);
    });
    $('fullscreenQueueButton').addEventListener('click', () => {
      fullscreen.close?.();
      setTimeout(() => $('queueDrawerButton')?.click(), 0);
    });
    renderFavorites();
    syncFullscreenVolume();
  }
  function syncFullscreenVolume() {
    const range = $('fullscreenVolumeRange');
    const value = $('fullscreenVolumeValue');
    if (!range || !value) return;
    const volume = Number($('volumeRange')?.value || 0);
    if (document.activeElement !== range) range.value = String(volume);
    value.textContent = `${volume}%`;
  }

  function addManagerClose(dialog, label) {
    if (!dialog || dialog.querySelector('.ux-manager-close')) return;
    const panel = dialog.querySelector('.stations-panel');
    if (!panel) return;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ux-manager-close';
    close.setAttribute('aria-label', `Close ${label}`);
    close.innerHTML = icons.close;
    close.addEventListener('click', () => dialog.close());
    panel.appendChild(close);
  }
  function enhanceManagers() {
    addManagerClose($('stationsDialog'), 'stations');
    addManagerClose($('playlistsDialog'), 'playlists');
  }
  function enhancePlaylistIcons() {
    document.querySelectorAll('.pline [data-up]').forEach(button => {
      if (button.dataset.safeIcon === '1') return;
      button.dataset.safeIcon = '1';
      button.innerHTML = upIcon;
      button.setAttribute('aria-label', 'Move up');
      button.title = 'Move up';
    });
    document.querySelectorAll('.pline [data-down]').forEach(button => {
      if (button.dataset.safeIcon === '1') return;
      button.dataset.safeIcon = '1';
      button.innerHTML = downIcon;
      button.setAttribute('aria-label', 'Move down');
      button.title = 'Move down';
    });
    document.querySelectorAll('.pline [data-del]').forEach(button => {
      if (button.dataset.safeIcon === '1') return;
      button.dataset.safeIcon = '1';
      button.innerHTML = icons.trash;
      button.setAttribute('aria-label', 'Remove line');
      button.title = 'Remove';
    });
  }
  function armDelete(button, label) {
    const now = Date.now();
    const armed = Number(button.dataset.safeDeleteArmedAt || 0);
    if (now - armed < 2600) {
      delete button.dataset.safeDeleteArmedAt;
      button.classList.remove('delete-armed');
      return false;
    }
    button.dataset.safeDeleteArmedAt = String(now);
    button.classList.add('delete-armed');
    toast(`Tap again to delete ${label}`);
    setTimeout(() => {
      if (Number(button.dataset.safeDeleteArmedAt || 0) === now) {
        delete button.dataset.safeDeleteArmedAt;
        button.classList.remove('delete-armed');
      }
    }, 2600);
    return true;
  }

  function reconcile() {
    cleanMobileNav();
    cleanSidebar();
    enhanceDock();
    enhanceTrackAccess();
    enhanceFullscreen();
    enhanceManagers();
    enhancePlaylistIcons();
    favoriteControls().forEach(bindFavorite);
    const nextToken = token();
    if (nextToken !== lastToken) {
      lastToken = nextToken;
      syncFavorite();
    } else renderFavorites();
    if ($('fullscreenNowPlaying')?.open) syncFullscreenVolume();
  }

  document.addEventListener(
    'click',
    event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const mini = target.closest('#mobileMiniPlayer');
      if (mini && !target.closest('.mobile-mini-play')) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        $('playerArt')?.click();
        return;
      }
      if (target.closest('#leftMoreButton')) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openTrackActions();
        return;
      }
      if (target.closest('#dockMoreButton')) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openMore();
        return;
      }
      const stationDelete = target.closest('.station-del');
      if (stationDelete && armDelete(stationDelete, 'station')) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      const playlistDelete = target.closest('#plineDelete');
      if (playlistDelete && armDelete(playlistDelete, 'playlist')) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  function mount() {
    reconcile();
    lastToken = token();
    syncFavorite();
    setInterval(reconcile, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
