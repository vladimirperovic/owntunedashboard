(() => {
  'use strict';

  const { scheduler, toast, icons, escapeHtml } = window.OwnTone;
  const $ = id => document.getElementById(id);
  const app = () => window.OWNTONE_APP || null;
  const state = () => app()?.state || {};

  const heartOutline =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
  const heartFilled =
    '<svg class="fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
  const moreIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>';
  const browseIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8 4.8-2.2Z"/></svg>';
  const statsIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V11M12 19V5M19 19v-7"/></svg>';
  const playlistIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h11M8 12h11M8 17h7"/><circle cx="4" cy="7" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17" r="1"/></svg>';
  const upIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
  const downIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  let trackActionsDialog;
  let addPlaylistDialog;
  let moreDialog;
  let currentFavorite = false;
  let lastTrackToken = '';
  let favoriteRequest = 0;

  function currentItem() {
    return state().current || null;
  }

  function currentPath() {
    const item = currentItem() || {};
    for (const value of [item.path, item.uri]) {
      const path = String(value || '').trim();
      if (/^(?:\/|https?:\/\/)/i.test(path)) return path;
    }
    return '';
  }

  function currentToken() {
    const item = currentItem() || {};
    return String(item.id ?? item.track_id ?? item.path ?? `${item.title || ''}|${item.artist || ''}`);
  }

  function isLiveItem() {
    const item = currentItem() || {};
    return item.data_kind === 'url' || /^https?:\/\//i.test(String(item.path || item.uri || ''));
  }

  function isDemo() {
    return !!state().demo;
  }

  function demoFavoriteKey() {
    return `owntone-demo-favorite:${currentToken()}`;
  }

  function readDemoFavorite() {
    try {
      return localStorage.getItem(demoFavoriteKey()) === '1';
    } catch (_) {
      return false;
    }
  }

  function writeDemoFavorite(value) {
    try {
      if (value) localStorage.setItem(demoFavoriteKey(), '1');
      else localStorage.removeItem(demoFavoriteKey());
    } catch (_) {}
  }

  async function editablePlaylists() {
    const data = await scheduler('/playlists', { cache: 'no-store' });
    return data?.items || [];
  }

  function findFavorites(items) {
    return (
      items.find(
        item =>
          String(item.name || '')
            .trim()
            .toLowerCase() === 'favorites'
      ) || null
    );
  }

  async function ensureFavoritesPlaylist() {
    let items = await editablePlaylists();
    let favorites = findFavorites(items);
    if (favorites) return favorites;
    await scheduler('/playlists', { method: 'POST', body: { name: 'Favorites' } });
    items = await editablePlaylists();
    favorites = findFavorites(items);
    if (!favorites) throw new Error('Favorites playlist could not be created');
    return favorites;
  }

  async function savePlaylistLines(playlist, lines) {
    return scheduler(`/playlists/${encodeURIComponent(playlist.slug)}`, {
      method: 'PUT',
      body: { lines },
    });
  }

  function favoriteControls() {
    return [
      ...document.querySelectorAll(
        '.transport-row .micro-action[data-playlist-name="Favorites"], .dock-heart[data-playlist-name="Favorites"], [data-ux-favorite]'
      ),
    ];
  }

  function renderFavoriteControls() {
    const item = currentItem();
    const live = isLiveItem();
    favoriteControls().forEach(button => {
      button.classList.add('current-favorite-control');
      button.dataset.uxFavorite = '1';
      button.removeAttribute('data-action');
      button.removeAttribute('data-playlist-name');
      button.removeAttribute('data-playlist');
      button.classList.toggle('is-current-favorite', currentFavorite);
      const visual = currentFavorite ? 'filled' : 'outline';
      if (button.dataset.uxFavoriteVisual !== visual) {
        button.innerHTML = currentFavorite ? heartFilled : heartOutline;
        button.dataset.uxFavoriteVisual = visual;
      }
      const label = live
        ? 'Pin this radio station from its station card'
        : currentFavorite
          ? 'Remove current track from Favorites'
          : 'Add current track to Favorites';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.disabled = !item;
      button.setAttribute('aria-pressed', String(currentFavorite));
    });
    const actionButton = $('uxTrackFavorite');
    if (actionButton) {
      const visual = currentFavorite ? 'filled' : 'outline';
      if (actionButton.dataset.uxFavoriteVisual !== visual) {
        actionButton.innerHTML = `${currentFavorite ? heartFilled : heartOutline}<span>${currentFavorite ? 'Remove from Favorites' : 'Add to Favorites'}</span>`;
        actionButton.dataset.uxFavoriteVisual = visual;
      }
      actionButton.classList.toggle('active', currentFavorite);
    }
  }

  async function syncFavoriteState() {
    const request = ++favoriteRequest;
    if (!currentItem() || isLiveItem()) {
      currentFavorite = false;
      renderFavoriteControls();
      return;
    }
    if (isDemo()) {
      currentFavorite = readDemoFavorite();
      renderFavoriteControls();
      return;
    }
    const path = currentPath();
    if (!path) {
      currentFavorite = false;
      renderFavoriteControls();
      return;
    }
    try {
      const favorites = findFavorites(await editablePlaylists());
      if (request !== favoriteRequest) return;
      currentFavorite = !!favorites?.lines?.includes(path);
    } catch (_) {
      if (request !== favoriteRequest) return;
      currentFavorite = false;
    }
    renderFavoriteControls();
  }

  async function toggleCurrentFavorite() {
    if (!currentItem()) {
      toast('Nothing is playing');
      return;
    }
    if (isLiveItem()) {
      toast('Pin live radio from its station card');
      return;
    }
    if (isDemo()) {
      currentFavorite = !readDemoFavorite();
      writeDemoFavorite(currentFavorite);
      renderFavoriteControls();
      toast(currentFavorite ? 'Added to Favorites' : 'Removed from Favorites');
      return;
    }
    const path = currentPath();
    if (!path) {
      toast('This track has no file path that can be saved');
      return;
    }
    try {
      const favorites = await ensureFavoritesPlaylist();
      const lines = [...(favorites.lines || [])];
      const index = lines.indexOf(path);
      if (index >= 0) lines.splice(index, 1);
      else lines.push(path);
      await savePlaylistLines(favorites, lines);
      currentFavorite = index < 0;
      renderFavoriteControls();
      toast(currentFavorite ? 'Added to Favorites' : 'Removed from Favorites');
      setTimeout(() => app()?.refreshLibrary?.(), 4000);
    } catch (error) {
      toast(`Favorites failed: ${error.message}`);
    }
  }

  function ensureTrackActionsDialog() {
    if (trackActionsDialog) return trackActionsDialog;
    trackActionsDialog = document.createElement('dialog');
    trackActionsDialog.id = 'uxTrackActionsDialog';
    trackActionsDialog.className = 'ux-dialog ux-actions-dialog';
    trackActionsDialog.innerHTML = `
      <div class="ux-dialog-panel">
        <header class="ux-dialog-head"><div><span class="section-kicker">NOW PLAYING</span><h2>Track actions</h2></div><button type="button" class="ux-dialog-close" aria-label="Close">${icons.close}</button></header>
        <div class="ux-track-summary"><b id="uxTrackActionTitle">OwnTone</b><span id="uxTrackActionArtist"></span></div>
        <div class="ux-action-list">
          <button id="uxTrackFavorite" type="button">${heartOutline}<span>Add to Favorites</span></button>
          <button id="uxTrackPlaylist" type="button">${playlistIcon}<span>Add to playlist</span></button>
          <button id="uxTrackDetails" type="button">${icons.info}<span>Track details</span></button>
        </div>
      </div>`;
    document.body.appendChild(trackActionsDialog);
    trackActionsDialog
      .querySelector('.ux-dialog-close')
      .addEventListener('click', () => trackActionsDialog.close());
    trackActionsDialog.addEventListener('click', event => {
      if (event.target === trackActionsDialog) trackActionsDialog.close();
    });
    $('uxTrackFavorite').addEventListener('click', toggleCurrentFavorite);
    $('uxTrackPlaylist').addEventListener('click', () => {
      trackActionsDialog.close();
      openAddToPlaylist();
    });
    $('uxTrackDetails').addEventListener('click', () => {
      trackActionsDialog.close();
      const info = $('trackInfoButton') || $('playingFrom');
      info?.click();
    });
    return trackActionsDialog;
  }

  function openTrackActions() {
    ensureTrackActionsDialog();
    const item = currentItem() || {};
    $('uxTrackActionTitle').textContent = item.title || $('trackTitle')?.textContent || 'Nothing playing';
    $('uxTrackActionArtist').textContent = item.artist || $('trackArtist')?.textContent || 'OwnTone';
    $('uxTrackPlaylist').disabled = !currentPath() || isLiveItem();
    renderFavoriteControls();
    if (typeof trackActionsDialog.showModal === 'function') trackActionsDialog.showModal();
    else trackActionsDialog.setAttribute('open', '');
  }

  function ensureAddPlaylistDialog() {
    if (addPlaylistDialog) return addPlaylistDialog;
    addPlaylistDialog = document.createElement('dialog');
    addPlaylistDialog.id = 'uxAddPlaylistDialog';
    addPlaylistDialog.className = 'ux-dialog';
    addPlaylistDialog.innerHTML = `
      <form class="ux-dialog-panel" id="uxAddPlaylistForm">
        <header class="ux-dialog-head"><div><span class="section-kicker">PLAYLIST</span><h2>Add current track</h2></div><button type="button" class="ux-dialog-close" aria-label="Close">${icons.close}</button></header>
        <p class="ux-dialog-copy" id="uxPlaylistTrackLabel"></p>
        <label class="ux-field"><span>Existing playlist</span><select id="uxPlaylistSelect"></select></label>
        <div class="ux-or"><span>or create a new one</span></div>
        <label class="ux-field"><span>New playlist name</span><input id="uxPlaylistNewName" type="text" maxlength="60" placeholder="e.g. Evening"></label>
        <div class="ux-dialog-actions"><button type="button" class="ux-secondary" id="uxManagePlaylists">Manage playlists</button><button type="submit" class="ux-primary">Add track</button></div>
      </form>`;
    document.body.appendChild(addPlaylistDialog);
    addPlaylistDialog
      .querySelector('.ux-dialog-close')
      .addEventListener('click', () => addPlaylistDialog.close());
    addPlaylistDialog.addEventListener('click', event => {
      if (event.target === addPlaylistDialog) addPlaylistDialog.close();
    });
    $('uxManagePlaylists').addEventListener('click', () => {
      addPlaylistDialog.close();
      $('managePlaylists')?.click();
    });
    $('uxAddPlaylistForm').addEventListener('submit', addCurrentToPlaylist);
    return addPlaylistDialog;
  }

  async function openAddToPlaylist() {
    if (!currentItem() || isLiveItem() || !currentPath()) {
      toast(isLiveItem() ? 'Live radio cannot be added as a track' : 'This track has no savable file path');
      return;
    }
    ensureAddPlaylistDialog();
    $('uxPlaylistTrackLabel').textContent =
      `${currentItem()?.title || 'Current track'} · ${currentItem()?.artist || 'OwnTone'}`;
    const select = $('uxPlaylistSelect');
    select.innerHTML = '<option value="">Loading playlists…</option>';
    $('uxPlaylistNewName').value = '';
    if (typeof addPlaylistDialog.showModal === 'function') addPlaylistDialog.showModal();
    else addPlaylistDialog.setAttribute('open', '');
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
    const path = currentPath();
    if (!path) {
      toast('This track has no savable file path');
      return;
    }
    const submit = event.submitter;
    submit?.setAttribute('disabled', '');
    try {
      let items = await editablePlaylists();
      const newName = $('uxPlaylistNewName').value.trim();
      let playlist;
      if (newName) {
        const created = await scheduler('/playlists', { method: 'POST', body: { name: newName } });
        items = await editablePlaylists();
        playlist =
          items.find(item => item.slug === created?.slug) || items.find(item => item.name === newName);
      } else {
        playlist = items.find(item => item.slug === $('uxPlaylistSelect').value);
      }
      if (!playlist) throw new Error('Choose or create a playlist');
      const lines = [...(playlist.lines || [])];
      if (lines.includes(path)) {
        toast(`Already in ${playlist.name}`);
        addPlaylistDialog.close();
        return;
      }
      lines.push(path);
      await savePlaylistLines(playlist, lines);
      toast(`Added to ${playlist.name}`);
      addPlaylistDialog.close();
      setTimeout(() => app()?.refreshLibrary?.(), 4000);
    } catch (error) {
      toast(`Add to playlist failed: ${error.message}`);
    } finally {
      submit?.removeAttribute('disabled');
    }
  }

  function ensureMoreDialog() {
    if (moreDialog) return moreDialog;
    moreDialog = document.createElement('dialog');
    moreDialog.id = 'uxMoreDialog';
    moreDialog.className = 'ux-dialog ux-more-dialog';
    moreDialog.innerHTML = `
      <div class="ux-dialog-panel">
        <header class="ux-dialog-head"><div><span class="section-kicker">OWN TONE</span><h2>More</h2></div><button type="button" class="ux-dialog-close" aria-label="Close">${icons.close}</button></header>
        <div class="ux-more-grid">
          <button type="button" data-ux-more="track">${moreIcon}<span>Track actions</span></button>
          <button type="button" data-ux-more="queue">${icons.queue}<span>Queue</span></button>
          <button type="button" data-ux-more="history">${icons.clock}<span>History</span></button>
          <button type="button" data-ux-more="browse">${browseIcon}<span>Browse</span></button>
          <button type="button" data-ux-more="insights">${statsIcon}<span>Insights</span></button>
          <button type="button" data-ux-more="schedule">${icons.clock}<span>Schedule</span></button>
          <button type="button" data-ux-more="playlists">${playlistIcon}<span>Edit playlists</span></button>
          <button type="button" data-ux-more="stations">${icons.radio}<span>Manage stations</span></button>
          <button type="button" data-ux-more="notifications">${icons.info}<span>Notifications</span></button>
        </div>
      </div>`;
    document.body.appendChild(moreDialog);
    moreDialog.querySelector('.ux-dialog-close').addEventListener('click', () => moreDialog.close());
    moreDialog.addEventListener('click', event => {
      if (event.target === moreDialog) moreDialog.close();
    });
    moreDialog.querySelectorAll('[data-ux-more]').forEach(button =>
      button.addEventListener('click', () => {
        const action = button.dataset.uxMore;
        moreDialog.close();
        runMoreAction(action);
      })
    );
    return moreDialog;
  }

  function scrollToSection(id, label) {
    const section = $(id);
    if (!section) {
      toast(`${label} is available after the library connects`);
      return;
    }
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function runMoreAction(action) {
    if (action === 'track') openTrackActions();
    else if (action === 'queue') $('queueDrawerButton')?.click();
    else if (action === 'history') $('historyNavButton')?.click();
    else if (action === 'browse') scrollToSection('browseSection', 'Browse');
    else if (action === 'insights') scrollToSection('insightsSection', 'Insights');
    else if (action === 'schedule') $('scheduleButton')?.click();
    else if (action === 'playlists') $('managePlaylists')?.click();
    else if (action === 'stations') $('manageStations')?.click();
    else if (action === 'notifications') $('notifyButton')?.click();
  }

  function openMoreDialog() {
    ensureMoreDialog();
    const stationButton = moreDialog.querySelector('[data-ux-more="stations"]');
    const playlistButton = moreDialog.querySelector('[data-ux-more="playlists"]');
    if (stationButton) stationButton.hidden = !document.body.classList.contains('radio-mode');
    if (playlistButton) playlistButton.hidden = document.body.classList.contains('radio-mode');
    if (typeof moreDialog.showModal === 'function') moreDialog.showModal();
    else moreDialog.setAttribute('open', '');
  }

  function cleanMobileNavigation() {
    const nav = document.querySelector('.mobile-nav');
    if (!nav) return;
    $('muteNavButton')?.remove();
    nav.style.removeProperty('grid-template-columns');
  }

  function makeSideButton(id, label, icon, target) {
    const button = document.createElement('button');
    button.id = id;
    button.className = 'side-link ux-side-link';
    button.type = 'button';
    button.innerHTML = `<span>${icon}</span>${label}`;
    button.addEventListener('click', () => scrollToSection(target, label));
    return button;
  }

  function cleanSidebar() {
    const nav = document.querySelector('.side-nav');
    if (!nav) return;
    nav.querySelector('[data-nav="recent"]')?.remove();
    const history = $('historyNavButton');
    if (history && history.dataset.uxHistory !== '1') {
      history.dataset.uxHistory = '1';
      const span = history.querySelector('span');
      history.innerHTML = `${span ? span.outerHTML : `<span>${icons.clock}</span>`}History`;
      history.title = 'Queue and listening history';
    }
    const quick = [...nav.querySelectorAll('.nav-label')].find(label =>
      /quick access/i.test(label.textContent || '')
    );
    if (!quick) return;
    if (!$('browseNavButton')) {
      quick.insertAdjacentElement(
        'beforebegin',
        makeSideButton('browseNavButton', 'Browse', browseIcon, 'browseSection')
      );
    }
    if (!$('insightsNavButton')) {
      quick.insertAdjacentElement(
        'beforebegin',
        makeSideButton('insightsNavButton', 'Insights', statsIcon, 'insightsSection')
      );
    }
  }

  function enhanceFullscreen() {
    const fullscreen = $('fullscreenNowPlaying');
    const controls = fullscreen?.querySelector('.fullscreen-controls');
    if (!fullscreen || !controls || $('fullscreenVolumeRange')) return;
    const utility = document.createElement('div');
    utility.className = 'fullscreen-utility-row';
    utility.innerHTML = `
      <label class="fullscreen-volume-control" for="fullscreenVolumeRange">${icons.output}<input id="fullscreenVolumeRange" type="range" min="0" max="100" value="${Number($('volumeRange')?.value || 0)}" aria-label="Fullscreen volume"><output id="fullscreenVolumeValue">${Number($('volumeRange')?.value || 0)}%</output></label>
      <button type="button" id="fullscreenFavoriteButton" data-ux-favorite aria-label="Add current track to Favorites">${heartOutline}</button>
      <button type="button" id="fullscreenTrackActionsButton" aria-label="Current track actions">${moreIcon}</button>
      <button type="button" id="fullscreenQueueButton" aria-label="Open queue">${icons.queue}</button>`;
    controls.insertAdjacentElement('afterend', utility);
    const fullVolume = $('fullscreenVolumeRange');
    fullVolume.addEventListener('input', () => {
      const main = $('volumeRange');
      if (!main) return;
      main.value = fullVolume.value;
      main.dispatchEvent(new Event('input', { bubbles: true }));
      syncFullscreenVolume();
    });
    fullVolume.addEventListener('change', () => {
      const main = $('volumeRange');
      if (!main) return;
      main.value = fullVolume.value;
      main.dispatchEvent(new Event('change', { bubbles: true }));
      syncFullscreenVolume();
    });
    $('fullscreenFavoriteButton').addEventListener('click', toggleCurrentFavorite);
    $('fullscreenTrackActionsButton').addEventListener('click', () => {
      fullscreen.close?.();
      setTimeout(openTrackActions, 0);
    });
    $('fullscreenQueueButton').addEventListener('click', () => {
      fullscreen.close?.();
      setTimeout(() => $('queueDrawerButton')?.click(), 0);
    });
    renderFavoriteControls();
    syncFullscreenVolume();
  }

  function syncFullscreenVolume() {
    const fullVolume = $('fullscreenVolumeRange');
    const value = $('fullscreenVolumeValue');
    if (!fullVolume || !value) return;
    const volume = Number($('volumeRange')?.value || 0);
    if (document.activeElement !== fullVolume) fullVolume.value = String(volume);
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

  function enhancePlaylistEditorIcons() {
    document.querySelectorAll('.pline [data-up]').forEach(button => {
      if (button.dataset.uxIcon === '1') return;
      button.dataset.uxIcon = '1';
      button.innerHTML = upIcon;
      button.setAttribute('aria-label', 'Move up');
      button.title = 'Move up';
    });
    document.querySelectorAll('.pline [data-down]').forEach(button => {
      if (button.dataset.uxIcon === '1') return;
      button.dataset.uxIcon = '1';
      button.innerHTML = downIcon;
      button.setAttribute('aria-label', 'Move down');
      button.title = 'Move down';
    });
    document.querySelectorAll('.pline [data-del]').forEach(button => {
      if (button.dataset.uxIcon === '1') return;
      button.dataset.uxIcon = '1';
      button.innerHTML = icons.trash;
      button.setAttribute('aria-label', 'Remove line');
      button.title = 'Remove';
    });
  }

  function armDelete(button, label) {
    const now = Date.now();
    const armedAt = Number(button.dataset.deleteArmedAt || 0);
    if (now - armedAt < 2600) {
      delete button.dataset.deleteArmedAt;
      button.classList.remove('delete-armed');
      return false;
    }
    button.dataset.deleteArmedAt = String(now);
    button.classList.add('delete-armed');
    toast(`Click delete again to remove ${label}`);
    setTimeout(() => {
      if (Number(button.dataset.deleteArmedAt || 0) === now) {
        delete button.dataset.deleteArmedAt;
        button.classList.remove('delete-armed');
      }
    }, 2600);
    return true;
  }

  function replaceCompositeCard(button) {
    if (!(button instanceof HTMLButtonElement)) return;
    if (!button.querySelector('.context-menu-trigger,.album-info-button')) return;
    const card = document.createElement('div');
    [...button.attributes].forEach(attribute => {
      if (attribute.name !== 'type') card.setAttribute(attribute.name, attribute.value);
    });
    card.classList.add('ux-composite-card');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    while (button.firstChild) card.appendChild(button.firstChild);
    if (card.classList.contains('premium-recent-card')) {
      card.addEventListener('click', event => {
        if (event.target.closest('.context-menu-trigger')) return;
        if (card.dataset.uri) app()?.playUri?.(card.dataset.uri);
      });
    }
    button.replaceWith(card);
  }

  function normalizeCompositeCards() {
    document
      .querySelectorAll(
        'button.album-card,button.playlist-card,button.search-item,button.premium-recent-card'
      )
      .forEach(replaceCompositeCard);
  }

  function enhanceDockButtons() {
    const trackMore = $('leftMoreButton');
    if (trackMore && trackMore.dataset.uxBound !== '1') {
      trackMore.dataset.uxBound = '1';
      trackMore.setAttribute('aria-label', 'Current track actions');
      trackMore.title = 'Track actions';
      trackMore.innerHTML = moreIcon;
    }
    const more = $('dockMoreButton');
    if (more && more.dataset.uxBound !== '1') {
      more.dataset.uxBound = '1';
      more.setAttribute('aria-label', 'More dashboard options');
      more.title = 'More';
      more.innerHTML = browseIcon;
    }
  }

  function enhanceTrackActionAccess() {
    const chips = $('trackChips');
    const info = $('trackInfoButton');
    if (!chips || !info || $('trackActionsButton')) return;
    const button = document.createElement('button');
    button.id = 'trackActionsButton';
    button.className = 'track-chip track-chip--info track-actions-button';
    button.type = 'button';
    button.title = 'Current track actions';
    button.setAttribute('aria-label', 'Current track actions');
    button.innerHTML = moreIcon;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openTrackActions();
    });
    info.insertAdjacentElement('afterend', button);
  }

  function enhanceAll() {
    const token = currentToken();
    if (token !== lastTrackToken) {
      lastTrackToken = token;
      syncFavoriteState();
    }
    cleanMobileNavigation();
    cleanSidebar();
    enhanceDockButtons();
    enhanceTrackActionAccess();
    enhanceFullscreen();
    enhanceManagers();
    enhancePlaylistEditorIcons();
    normalizeCompositeCards();
    renderFavoriteControls();
  }

  document.addEventListener(
    'click',
    event => {
      const favorite = event.target.closest?.('.current-favorite-control,[data-ux-favorite]');
      if (favorite) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        toggleCurrentFavorite();
        return;
      }
      const mini = event.target.closest?.('#mobileMiniPlayer');
      if (mini && !event.target.closest('.mobile-mini-play')) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        $('playerArt')?.click();
        return;
      }
      const trackMore = event.target.closest?.('#leftMoreButton');
      if (trackMore) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        openTrackActions();
        return;
      }
      const more = event.target.closest?.('#dockMoreButton');
      if (more) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        openMoreDialog();
        return;
      }
      const stationDelete = event.target.closest?.('.station-del');
      if (stationDelete && armDelete(stationDelete, 'this station')) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        return;
      }
      const playlistDelete = event.target.closest?.('#plineDelete');
      if (playlistDelete && armDelete(playlistDelete, 'this playlist')) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      }
    },
    true
  );

  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest?.('.ux-composite-card[role="button"]');
    if (!card || event.target !== card) return;
    event.preventDefault();
    card.click();
  });

  function mount() {
    enhanceAll();
    const bodyObserver = new MutationObserver(enhanceAll);
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    lastTrackToken = currentToken();
    syncFavoriteState();
    setInterval(() => {
      const fullscreen = $('fullscreenNowPlaying');
      if (fullscreen?.open) {
        syncFullscreenVolume();
        renderFavoriteControls();
      }
    }, 750);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
