(() => {
  'use strict';

  const svg = {
    play:'<svg class="ui-icon fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    pause:'<svg class="ui-icon fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>',
    home:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></svg>',
    search:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    disc:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M15.5 5.8A7 7 0 0 1 19 12"/></svg>',
    list:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
    heart:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
    shuffle:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h2.5c4 0 5 10 9 10H20M17 14l3 3-3 3M4 17h2.5c1.5 0 2.6-1.4 3.6-3M15.5 7H20M17 4l3 3-3 3"/></svg>',
    sun:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    note:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12M9 9l10-2"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    radio:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16v10H4zM7 7l9-4M8 14h.01M12 14h5M12 17h5"/></svg>',
    history:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6V4"/><path d="M12 8v4l2.7 1.6"/></svg>',
    user:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c.8-4 3.3-6 7.5-6s6.7 2 7.5 6"/></svg>',
    close:'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>'
  };

  const normalize = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const hashHue = value => {
    let h = 0;
    for (const ch of String(value || '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
    return Math.abs(h) % 360;
  };
  const initials = value => {
    const words = String(value || 'Radio').replace(/^radio\s+/i,'').trim().split(/\s+/).filter(Boolean);
    return (words.slice(0,2).map(x => x[0]).join('') || 'R').toUpperCase();
  };

  let mini;
  let heroVisible = true;
  let activeSection = 'home';

  function decorateStaticUI() {
    const sideDefs = [
      [/^home$/i,'home','home'], [/^search$/i,'search','search'], [/^albums$/i,'disc','library'], [/^playlists$/i,'list','playlists'],
      [/^favorites$/i,'heart',''], [/^recently played$/i,'history',''], [/^random 500$/i,'shuffle',''], [/^morning$/i,'sun',''], [/^my music$/i,'note','']
    ];
    document.querySelectorAll('.side-link').forEach(button => {
      if (button.dataset.dsDecorated === '1') return;
      const text = String(button.textContent || '').replace(/\s+/g,' ').trim();
      const def = sideDefs.find(([re]) => re.test(text));
      if (!def) return;
      const span = button.querySelector('span');
      if (span) span.innerHTML = svg[def[1]];
      if (def[2]) button.dataset.nav = def[2];
      button.dataset.dsDecorated = '1';
    });

    document.querySelectorAll('.mobile-nav button').forEach(button => {
      const label = button.querySelector('small')?.textContent?.trim() || '';
      const span = button.querySelector('span');
      let key='', icon='';
      if (/home/i.test(label)) { key='home'; icon='home'; }
      else if (/search/i.test(label)) { key='search'; icon='search'; }
      else if (/library/i.test(label)) { key='library'; icon='disc'; }
      else if (/playlists/i.test(label)) { key='playlists'; icon='list'; }
      else if (/radio|music/i.test(label)) { key='radio'; icon='radio'; button.id='mobileModeButton'; }
      if (!key) return;
      button.dataset.nav = key;
      if (span) { span.classList.add('mobile-nav-icon'); span.innerHTML = svg[icon]; }
      button.dataset.dsDecorated = '1';
    });

    document.querySelectorAll('.quick-card').forEach(card => {
      const slot = card.querySelector('.quick-icon');
      if (!slot) return;
      let icon='note';
      const playlist = card.dataset.playlist || '';
      if (/favorites/i.test(playlist)) icon='heart';
      else if (/random/i.test(playlist)) icon='shuffle';
      else if (/morning/i.test(playlist)) icon='sun';
      else if (card.id === 'shuffleLibraryButton') icon='note';
      slot.innerHTML = svg[icon];
    });

    document.querySelectorAll('.micro-action').forEach(button => {
      const label = button.getAttribute('aria-label') || '';
      if (/random/i.test(label)) button.innerHTML = svg.shuffle;
      else if (/favorite/i.test(label)) button.innerHTML = svg.heart;
    });
    const dockHeart = document.querySelector('.dock-heart');
    if (dockHeart) dockHeart.innerHTML = svg.heart;
    const close = document.querySelector('.search-title-row button[aria-label="Close"]');
    if (close) close.innerHTML = svg.close;
    enhanceSearchIcons();
  }

  function enhanceSearchIcons() {
    document.querySelectorAll('.search-item-icon').forEach(slot => {
      const key = String(slot.textContent || '').trim();
      if (key === 'LP') slot.innerHTML = svg.disc;
      else if (key === 'A') slot.innerHTML = svg.user;
      else if (key === '≡') slot.innerHTML = svg.list;
      else slot.innerHTML = svg.note;
    });
  }

  function syncConnectionState() {
    const text = document.getElementById('connectionText');
    const dot = document.querySelector('.status-mini');
    if (!text || !dot) return;
    const value = String(text.textContent || '').toLowerCase();
    const preview = value.includes('preview');
    const online = value.includes('connected');
    dot.classList.toggle('is-preview', preview);
    dot.classList.toggle('is-online', online && !preview);
    dot.classList.toggle('is-offline', !online && !preview);
    dot.setAttribute('aria-label', preview ? 'Preview mode' : online ? 'OwnTone connected' : 'OwnTone offline');
    dot.setAttribute('role', 'status');
  }

  function relocateFolders() {
    const button = document.getElementById('foldersMobileButton');
    const heading = document.getElementById('albumsSection');
    if (!button || !heading || button.dataset.dsRelocated === '1') return false;
    button.dataset.dsRelocated = '1';
    button.className = 'library-folders-button';
    button.innerHTML = 'Folders';
    button.setAttribute('aria-label', 'Browse music folders');
    button.title = 'Browse music folders';
    heading.appendChild(button);
    return true;
  }

  function enhanceAlbumCards() {
    document.querySelectorAll('.album-card').forEach(card => {
      if (card.dataset.dsAlbum === '1') return;
      card.dataset.dsAlbum = '1';
      const art = card.querySelector('.album-art');
      if (!art) return;
      const overlay = document.createElement('span');
      overlay.className = 'album-play-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.innerHTML = `<span>${svg.play}</span>`;
      art.appendChild(overlay);
    });
  }

  function configuredRadioArtwork(name) {
    const map = window.OWNTONE_DASHBOARD?.radioArtwork || {};
    if (map[name]) return String(map[name]);
    const wanted = normalize(name);
    for (const [key, value] of Object.entries(map)) if (normalize(key) === wanted) return String(value);
    return '';
  }

  function enhanceRadioCards() {
    document.querySelectorAll('.radio-card').forEach(card => {
      const name = card.querySelector('.radio-station-name, b')?.textContent?.trim() || 'Radio';
      if (!card.querySelector('.radio-station-identity')) {
        const mark = document.createElement('span');
        mark.className = 'radio-station-identity';
        mark.textContent = initials(name);
        mark.style.setProperty('--station-hue', String(hashHue(name)));
        const image = configuredRadioArtwork(name);
        if (image) {
          mark.classList.add('has-image');
          mark.style.backgroundImage = `url("${image.replace(/"/g, '%22')}")`;
        }
        mark.setAttribute('aria-hidden', 'true');
        card.appendChild(mark);
      }
      if (card.dataset.dsStationBound !== '1') {
        card.dataset.dsStationBound = '1';
        card.addEventListener('click', () => {
          try { sessionStorage.setItem('owntone-last-radio-station', name); } catch (_) {}
          setTimeout(syncHeroStation, 0);
        });
      }
    });
  }

  function ensureHeroStation() {
    const copy = document.querySelector('.track-copy');
    const title = document.getElementById('trackTitle');
    if (!copy || !title) return null;
    let label = copy.querySelector('.hero-station-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'hero-station-label';
      title.insertAdjacentElement('beforebegin', label);
    }
    return label;
  }

  function syncHeroStation() {
    const label = ensureHeroStation();
    if (!label) return;
    let station = document.querySelector('.radio-card.is-active .radio-station-name')?.textContent?.trim() || '';
    if (!station) {
      try { station = sessionStorage.getItem('owntone-last-radio-station') || ''; } catch (_) {}
    }
    label.textContent = station || 'Live radio';
  }

  function mountMiniPlayer() {
    if (document.getElementById('mobileMiniPlayer')) {
      mini = document.getElementById('mobileMiniPlayer');
      return;
    }
    mini = document.createElement('div');
    mini.id = 'mobileMiniPlayer';
    mini.className = 'mobile-mini-player';
    mini.setAttribute('aria-label', 'Now playing');
    mini.innerHTML = `
      <div class="mobile-mini-art"><span class="mini-fallback">${svg.note}</span><img alt="" hidden></div>
      <div class="mobile-mini-copy"><b>OwnTone</b><small>Nothing playing</small></div>
      <button class="mobile-mini-play" type="button" aria-label="Play">${svg.play}</button>`;
    const nav = document.querySelector('.mobile-nav');
    nav?.insertAdjacentElement('beforebegin', mini);
    mini.querySelector('.mobile-mini-play').addEventListener('click', event => {
      event.stopPropagation();
      document.getElementById('playButton')?.click();
    });
    mini.addEventListener('click', () => window.scrollTo({top:0, behavior:'smooth'}));
    syncMiniPlayer();
  }

  function syncMiniPlayer() {
    if (!mini) return;
    const title = document.getElementById('trackTitle')?.textContent?.trim() || 'OwnTone';
    const artist = document.getElementById('trackArtist')?.textContent?.trim() || '';
    const meta = document.getElementById('trackMeta')?.textContent?.trim() || '';
    const source = document.getElementById('artwork')?.getAttribute('src') || '';
    const mainPlay = document.getElementById('playButton');
    const playing = String(mainPlay?.getAttribute('aria-label') || '').toLowerCase().includes('pause');
    const img = mini.querySelector('.mobile-mini-art img');
    const fallback = mini.querySelector('.mini-fallback');
    mini.querySelector('.mobile-mini-copy b').textContent = title;
    mini.querySelector('.mobile-mini-copy small').textContent = artist || meta || 'OwnTone';
    if (source) {
      img.src = source;
      img.hidden = false;
      fallback.hidden = true;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      fallback.hidden = false;
    }
    const play = mini.querySelector('.mobile-mini-play');
    play.innerHTML = playing ? svg.pause : svg.play;
    play.classList.toggle('is-pause', playing);
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const generic = /^(choose something to play\.?|choose a station\.?|your music, beautifully simple\.?)$/i.test(title);
    mini.classList.toggle('visible', !heroVisible && !generic);
    syncHeroStation();
  }

  function updateModeButton() {
    const button = document.getElementById('mobileModeButton');
    if (!button) return;
    const radio = document.body.classList.contains('radio-mode');
    const icon = button.querySelector('.mobile-nav-icon');
    const label = button.querySelector('small');
    if (icon) icon.innerHTML = radio ? svg.note : svg.radio;
    if (label) label.textContent = radio ? 'Music' : 'Radio';
    button.setAttribute('aria-label', radio ? 'Open music library' : 'Open radio');
  }

  function setNavActive(key) {
    document.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === key));
  }

  function refreshNav() {
    updateModeButton();
    if (document.body.classList.contains('radio-mode')) return setNavActive('radio');
    const search = document.getElementById('searchDialog');
    if (search?.open) return setNavActive('search');
    const anchor = window.innerHeight * .38;
    const playlists = document.getElementById('playlistsSection');
    const albums = document.getElementById('albumsSection');
    if (playlists && playlists.getBoundingClientRect().top <= anchor) activeSection = 'playlists';
    else if (albums && albums.getBoundingClientRect().top <= anchor) activeSection = 'library';
    else activeSection = 'home';
    setNavActive(activeSection);
  }

  function enhanceDynamicNavIcons() {
    const history = document.querySelector('#historyNavButton > span');
    if (history && history.dataset.dsIcon !== '1') {
      history.dataset.dsIcon = '1';
      history.innerHTML = svg.history;
    }
    decorateStaticUI();
  }

  function mount() {
    decorateStaticUI();
    mountMiniPlayer();
    syncConnectionState();
    relocateFolders();
    enhanceAlbumCards();
    enhanceRadioCards();
    enhanceDynamicNavIcons();
    ensureHeroStation();
    refreshNav();

    const player = document.getElementById('playerCard');
    if (player) {
      new IntersectionObserver(entries => {
        heroVisible = !!entries[0]?.isIntersecting;
        syncMiniPlayer();
      }, {threshold:.12}).observe(player);
      new MutationObserver(syncMiniPlayer).observe(player, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['src','class','aria-label']});
    }

    const connection = document.getElementById('connectionText');
    if (connection) new MutationObserver(syncConnectionState).observe(connection, {subtree:true, childList:true, characterData:true});

    const albumGrid = document.getElementById('albumGrid');
    if (albumGrid) new MutationObserver(enhanceAlbumCards).observe(albumGrid, {childList:true});
    const searchResults = document.getElementById('searchResults');
    if (searchResults) new MutationObserver(enhanceSearchIcons).observe(searchResults, {childList:true});
    const radioGrids = [document.getElementById('radioFavoritesGrid'), document.getElementById('radioGrid')].filter(Boolean);
    radioGrids.forEach(grid => new MutationObserver(() => { enhanceRadioCards(); syncHeroStation(); }).observe(grid, {childList:true}));

    const mobileNav = document.querySelector('.mobile-nav');
    if (mobileNav) new MutationObserver(() => { decorateStaticUI(); relocateFolders(); refreshNav(); }).observe(mobileNav, {childList:true, subtree:true});
    const sideNav = document.querySelector('.side-nav');
    if (sideNav) new MutationObserver(enhanceDynamicNavIcons).observe(sideNav, {childList:true, subtree:true});

    const bodyObserver = new MutationObserver(() => { updateModeButton(); refreshNav(); syncMiniPlayer(); });
    bodyObserver.observe(document.body, {attributes:true, attributeFilter:['class']});

    const searchDialog = document.getElementById('searchDialog');
    searchDialog?.addEventListener('close', refreshNav);
    document.getElementById('searchButton')?.addEventListener('click', () => setTimeout(refreshNav, 0));
    document.getElementById('modeToggle')?.addEventListener('click', () => setTimeout(refreshNav, 0));

    let scrollRaf = 0;
    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; refreshNav(); });
    };
    window.addEventListener('scroll', onScroll, {passive:true});
    window.addEventListener('resize', onScroll, {passive:true});

    if (!relocateFolders()) {
      const late = new MutationObserver(() => { decorateStaticUI(); if (relocateFolders()) late.disconnect(); });
      late.observe(document.body, {childList:true, subtree:true});
      setTimeout(() => late.disconnect(), 12000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
