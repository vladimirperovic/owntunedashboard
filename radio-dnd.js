(() => {
  'use strict';

  const { scheduler } = window.OwnTone;
  const FAVORITES_KEY = 'owntone-radio-favorites-v1';
  const grid = () => document.getElementById('radioGrid');
  const favGrid = () => document.getElementById('radioFavoritesGrid');
  const grids = () => [favGrid(), grid()].filter(Boolean);
  const allCards = () => grids().flatMap(el => [...el.querySelectorAll('.radio-card')]);
  const healthCache = new Map();
  const heartOutline =
    '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
  const heartFilled =
    '<svg class="ui-icon fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>';

  const normalize = value =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const stationName = card =>
    card?.querySelector('.radio-station-name, .radio-card-copy b, b')?.textContent?.trim() || '';
  const cardKey = card => String(card?.dataset.uri || stationName(card) || '').trim();
  const playlistId = card =>
    (String(card?.dataset.uri || '').match(/^library:playlist:([^,]+)$/) || [])[1] || '';

  function readArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }
  function writeArray(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }
  function favoriteSet() {
    return new Set(readArray(FAVORITES_KEY));
  }
  function isFavorite(card, set = favoriteSet()) {
    return set.has(cardKey(card)) || set.has(stationName(card));
  }

  function applyPartition() {
    const cards = allCards();
    if (!cards.length) return;
    const favorites = favoriteSet();
    const fg = favGrid(),
      g = grid();
    if (!fg || !g) return;
    cards.forEach(card => {
      const fav = isFavorite(card, favorites);
      card.classList.toggle('is-favorite', fav);
      const target = fav ? fg : g;
      if (card.parentElement !== target) target.appendChild(card);
    });
    const favSection = fg.closest('.radio-section');
    if (favSection) favSection.style.display = fg.querySelectorAll('.radio-card').length ? '' : 'none';
  }

  function toggleFavorite(card) {
    const key = cardKey(card);
    if (!key) return;
    const set = new Set(readArray(FAVORITES_KEY));
    if (set.has(key)) set.delete(key);
    else set.add(key);
    writeArray(FAVORITES_KEY, [...set]);
    applyPartition();
    updateActiveAndQuality();
  }

  function extractQuality(text) {
    const source = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!source) return '';
    const lossless = source.match(/\b(FLAC|ALAC)\b/i);
    if (lossless) return lossless[1].toUpperCase();
    const codecRate = source.match(
      /\b(MP3|AAC(?:-LC)?|HE-?AAC|OPUS|OGG)\b[^0-9]{0,10}(\d{2,4})\s*(?:k|kbps)?\b/i
    );
    if (codecRate) return `${codecRate[1].toUpperCase()} ${codecRate[2]}k`;
    const rateCodec = source.match(
      /\b(\d{2,4})\s*(?:k|kbps)\b[^A-Z]{0,10}\b(MP3|AAC(?:-LC)?|HE-?AAC|OPUS|OGG)\b/i
    );
    if (rateCodec) return `${rateCodec[2].toUpperCase()} ${rateCodec[1]}k`;
    const bareRate = source.match(/\b(\d{2,4})\s*(?:k|kbps)\b/i);
    return bareRate ? `${bareRate[1]}k` : '';
  }

  function configuredQuality(name) {
    const configured = window.OWNTONE_DASHBOARD?.radioQuality || {};
    if (configured[name]) return String(configured[name]);
    const key = normalize(name);
    for (const [station, value] of Object.entries(configured))
      if (normalize(station) === key) return String(value);
    return '';
  }

  function nowPlayingQuality(name) {
    const currentName = document.getElementById('trackTitle')?.textContent || '';
    const a = normalize(name),
      b = normalize(currentName);
    if (!a || !b || !(a.includes(b) || b.includes(a))) return '';
    const pill = document.getElementById('formatPill')?.textContent || '';
    const meta = document.getElementById('trackMeta')?.textContent || '';
    return extractQuality(`${pill} ${meta}`) || pill.trim();
  }

  function qualityFor(card) {
    const health = healthCache.get(playlistId(card));
    return (
      configuredQuality(stationName(card)) ||
      nowPlayingQuality(stationName(card)) ||
      (health?.online ? health.quality : '') ||
      extractQuality(card.textContent) ||
      'STREAM'
    );
  }

  function renderHealth(card) {
    const id = playlistId(card),
      health = healthCache.get(id);
    const pill = card.querySelector('.radio-health-pill');
    if (!pill) return;
    const status = health ? (health.online ? 'LIVE' : 'OFFLINE') : 'CHECKING';
    if (pill.textContent !== status) pill.textContent = status;
    if (pill.dataset.status !== status.toLowerCase()) pill.dataset.status = status.toLowerCase();
    card.classList.toggle('is-offline', status === 'OFFLINE');
    card.classList.toggle('is-health-live', status === 'LIVE');
    if (health?.checked_at)
      pill.title = `${status} · checked ${new Date(health.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    else pill.title = status === 'CHECKING' ? 'Checking stream availability' : status;
  }

  async function checkHealth(card, force = false) {
    const id = playlistId(card);
    if (!id) return;
    // demo mode has no companion — always present stations as live
    if (window.OWNTONE_APP?.state?.demo) {
      healthCache.set(id, { online: true, status: 'LIVE', quality: 'STREAM', _checked: Date.now() });
      renderHealth(card);
      const q = card.querySelector('.radio-quality-pill');
      if (q) {
        const v = qualityFor(card);
        if (q.textContent !== v) q.textContent = v;
      }
      return;
    }
    const existing = healthCache.get(id);
    if (!force && existing && Date.now() - Number(existing._checked || 0) < 75000) {
      renderHealth(card);
      return;
    }
    const healthPill = card.querySelector('.radio-health-pill');
    if (healthPill) {
      healthPill.textContent = 'CHECKING';
      healthPill.dataset.status = 'checking';
      healthPill.title = 'Checking stream availability';
    }
    try {
      const data = await scheduler(
        `/radio-health?playlist_id=${encodeURIComponent(id)}${force ? '&force=1' : ''}`
      );
      healthCache.set(id, { ...data, _checked: Date.now() });
    } catch (error) {
      healthCache.set(id, {
        online: false,
        status: 'OFFLINE',
        quality: 'STREAM',
        error: String(error),
        _checked: Date.now(),
      });
    }
    renderHealth(card);
    const quality = card.querySelector('.radio-quality-pill');
    if (quality) {
      const value = qualityFor(card);
      if (quality.textContent !== value) quality.textContent = value;
    }
  }

  function checkAllHealth() {
    allCards().forEach((card, index) => setTimeout(() => checkHealth(card), index * 280));
  }

  function updateActiveAndQuality() {
    const currentTitle = normalize(document.getElementById('trackTitle')?.textContent || '');
    const currentArtist = document.getElementById('trackArtist')?.textContent || '';
    const currentMeta = document.getElementById('trackMeta')?.textContent || '';
    const favorites = favoriteSet();
    allCards().forEach(card => {
      const name = stationName(card),
        station = normalize(name);
      const active =
        !!station && !!currentTitle && (station.includes(currentTitle) || currentTitle.includes(station));
      const fav = isFavorite(card, favorites);
      card.classList.toggle('is-active', active);
      card.classList.toggle('is-favorite', fav);
      card.title = `${name}${active ? ' · On air' : ''}`;
      card.setAttribute('aria-label', `${active ? 'Playing' : 'Play'} ${name || 'radio station'}`);
      const favorite = card.querySelector('.radio-favorite');
      if (favorite) {
        favorite.innerHTML = fav ? heartFilled : heartOutline;
        favorite.title = fav ? 'Unpin favorite' : 'Pin to favorite streams';
        favorite.setAttribute(
          'aria-label',
          fav ? `Unpin ${name || 'station'} from favorites` : `Pin ${name || 'station'} to favorites`
        );
        favorite.setAttribute('aria-pressed', String(fav));
      }
      const quality = card.querySelector('.radio-quality-pill');
      const qVal = qualityFor(card);
      if (quality) {
        if (quality.textContent !== qVal) quality.textContent = qVal;
        quality.title = `Stream quality: ${qVal}`;
      }

      const sub = card.querySelector('.radio-station-sub, .radio-card-copy small');
      if (card.classList.contains('is-starting')) {
        if (active) {
          card.classList.remove('is-starting');
          const playBtn = card.querySelector('.radio-play-btn');
          if (playBtn)
            playBtn.innerHTML =
              '<svg class="ui-icon fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>';
        } else {
          if (sub) {
            sub.textContent = 'Connecting to stream…';
            sub.classList.add('is-live-meta');
          }
          renderHealth(card);
          return;
        }
      }
      if (sub) {
        if (active) {
          const liveText = [currentArtist !== 'OwnTone' && currentArtist, currentMeta]
            .filter(Boolean)
            .join(' · ');
          sub.textContent = liveText ? `Live · ${liveText}` : 'Live on air';
          sub.classList.add('is-live-meta');
        } else {
          sub.textContent = `${qVal} · Direct stream`;
          sub.classList.remove('is-live-meta');
        }
      }
      renderHealth(card);
    });
  }

  function enhanceCard(card) {
    if (card.dataset.enhancedCard === '1') return;
    card.dataset.enhancedCard = '1';
    const favorite = card.querySelector('.radio-favorite');
    if (favorite && !favorite.dataset.favBound) {
      favorite.dataset.favBound = '1';
      favorite.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(card);
      });
    }
    // app.js owns radio-card playback. Keeping one playback path prevents duplicate queue requests.
    renderHealth(card);
    setTimeout(() => checkHealth(card), Math.random() * 650);
  }

  function enhance() {
    applyPartition();
    allCards().forEach(enhanceCard);
    updateActiveAndQuality();
  }

  window.OWNTONE_ENHANCE_RADIO = enhance;
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', enhance, { once: true });
  else enhance();
  window.addEventListener('load', enhance, { once: true });
  setInterval(updateActiveAndQuality, 3000);
  setInterval(checkAllHealth, 90000);
})();
