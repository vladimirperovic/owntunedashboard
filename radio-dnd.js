(() => {
  'use strict';

  const ORDER_KEY = 'owntone-radio-order-v1';
  const FAVORITES_KEY = 'owntone-radio-favorites-v1';
  const companionBase = String(window.OWNTONE_DASHBOARD?.schedulerBase || '/scheduler').replace(/\/$/, '');
  const grid = () => document.getElementById('radioGrid');
  const favGrid = () => document.getElementById('radioFavoritesGrid');
  const grids = () => [favGrid(), grid()].filter(Boolean);
  const allCards = () => grids().flatMap(el => [...el.querySelectorAll('.radio-card')]);
  let dragged = null;
  let moved = false;
  let suppressClickUntil = 0;
  let touchPointerId = null;
  let touchCard = null;
  let touchActive = false;
  let touchStartTimer = null;
  const healthCache = new Map();

  const normalize = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const stationName = card => card?.querySelector('.radio-station-name, .radio-card-copy b, b')?.textContent?.trim() || '';
  const cardKey = card => String(card?.dataset.uri || stationName(card) || '').trim();
  const playlistId = card => (String(card?.dataset.uri || '').match(/^library:playlist:([^,]+)$/) || [])[1] || '';

  function displayName(name) {
    const source = String(name || '').replace(/\s+/g, ' ').trim();
    return source.replace(/^radio\s+/i, '').replace(/\s+radio$/i, '').trim() || source || 'LIVE';
  }
  function readArray(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
    catch (_) { return []; }
  }
  function writeArray(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  function favoriteSet() { return new Set(readArray(FAVORITES_KEY)); }
  function isFavorite(card, set=favoriteSet()) { return set.has(cardKey(card)) || set.has(stationName(card)); }

  function saveOrder() {
    writeArray(ORDER_KEY, allCards().map(stationName).filter(Boolean));
  }

  function applyPartition() {
    const cards = allCards();
    if (!cards.length) return;
    const saved = readArray(ORDER_KEY);
    const byName = new Map(cards.map(card => [normalize(stationName(card)), card]));
    const ordered = [], used = new Set();
    saved.forEach(name => {
      const card = byName.get(normalize(name));
      if (card && !used.has(card)) { ordered.push(card); used.add(card); }
    });
    cards.forEach(card => { if (!used.has(card)) ordered.push(card); });
    const favorites = favoriteSet();
    const pinned = ordered.filter(card => isFavorite(card, favorites));
    const normal = ordered.filter(card => !isFavorite(card, favorites));
    const fg = favGrid(), g = grid();
    const targets = [];
    if (fg) targets.push(...pinned.map(card => [card, fg]));
    if (g) targets.push(...normal.map(card => [card, g]));
    const current = grids().map(el => [...el.querySelectorAll('.radio-card')].map(cardKey).join('|')).join('|');
    const wanted = targets.map(([card]) => cardKey(card)).join('|');
    if (current !== wanted) targets.forEach(([card, target]) => target.appendChild(card));
    ordered.forEach(card => card.classList.toggle('is-favorite', isFavorite(card, favorites)));
  }

  function toggleFavorite(card) {
    const key = cardKey(card); if (!key) return;
    const values = readArray(FAVORITES_KEY);
    const set = new Set(values);
    if (set.has(key)) set.delete(key); else set.add(key);
    writeArray(FAVORITES_KEY, [...set]);
    applyPartition();
    saveOrder();
    animateSettle(grids()[0]);
    updateActiveAndQuality();
  }

  function extractQuality(text) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '';
    const lossless = source.match(/\b(FLAC|ALAC)\b/i); if (lossless) return lossless[1].toUpperCase();
    const codecRate = source.match(/\b(MP3|AAC(?:-LC)?|HE-?AAC|OPUS|OGG)\b[^0-9]{0,10}(\d{2,4})\s*(?:k|kbps)?\b/i);
    if (codecRate) return `${codecRate[1].toUpperCase()} ${codecRate[2]}k`;
    const rateCodec = source.match(/\b(\d{2,4})\s*(?:k|kbps)\b[^A-Z]{0,10}\b(MP3|AAC(?:-LC)?|HE-?AAC|OPUS|OGG)\b/i);
    if (rateCodec) return `${rateCodec[2].toUpperCase()} ${rateCodec[1]}k`;
    const bareRate = source.match(/\b(\d{2,4})\s*(?:k|kbps)\b/i); return bareRate ? `${bareRate[1]}k` : '';
  }
  function configuredQuality(name) {
    const configured = window.OWNTONE_DASHBOARD?.radioQuality || {};
    if (configured[name]) return String(configured[name]);
    const key = normalize(name);
    for (const [station, value] of Object.entries(configured)) if (normalize(station) === key) return String(value);
    return '';
  }
  function nowPlayingQuality(name) {
    const currentName = document.getElementById('trackTitle')?.textContent || '';
    const a = normalize(name), b = normalize(currentName);
    if (!a || !b || !(a.includes(b) || b.includes(a))) return '';
    const pill = document.getElementById('formatPill')?.textContent || '';
    const meta = document.getElementById('trackMeta')?.textContent || '';
    return extractQuality(`${pill} ${meta}`) || pill.trim();
  }
  function qualityFor(card) {
    const health = healthCache.get(playlistId(card));
    return configuredQuality(stationName(card)) || nowPlayingQuality(stationName(card)) || (health?.online ? health.quality : '') || extractQuality(card.textContent) || 'STREAM';
  }

  function renderHealth(card) {
    const id = playlistId(card), health = healthCache.get(id);
    const pill = card.querySelector('.radio-health-pill');
    if (!pill) return;
    const status = health ? (health.online ? 'LIVE' : 'OFFLINE') : 'LIVE';
    if (pill.textContent !== status) pill.textContent = status;
    if (pill.dataset.status !== status.toLowerCase()) pill.dataset.status = status.toLowerCase();
    card.classList.toggle('is-offline', status === 'OFFLINE');
    card.classList.toggle('is-health-live', status === 'LIVE');
    if (health?.checked_at) pill.title = `${status} · checked ${new Date(health.checked_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
  }

  async function checkHealth(card, force=false) {
    const id = playlistId(card); if (!id) return;
    const existing = healthCache.get(id);
    if (!force && existing && Date.now() - Number(existing._checked || 0) < 75000) { renderHealth(card); return; }
    const healthPill = card.querySelector('.radio-health-pill');
    if (healthPill && healthPill.dataset.status !== 'checking') healthPill.dataset.status = 'checking';
    try {
      const response = await fetch(`${companionBase}/radio-health?playlist_id=${encodeURIComponent(id)}${force ? '&force=1' : ''}`, {cache:'no-store'});
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      healthCache.set(id, {...data, _checked:Date.now()});
    } catch (error) {
      healthCache.set(id, {online:false,status:'OFFLINE',quality:'STREAM',error:String(error),_checked:Date.now()});
    }
    renderHealth(card);
    const quality = card.querySelector('.radio-quality-pill'); if (quality) { const value=qualityFor(card); if(quality.textContent!==value) quality.textContent=value; }
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
      const name = stationName(card), station = normalize(name);
      const active = !!station && !!currentTitle && (station.includes(currentTitle) || currentTitle.includes(station));
      card.classList.toggle('is-active', active);
      card.classList.toggle('is-favorite', isFavorite(card, favorites));
      card.title = `${name}${active ? ' · On air' : ''}`;
      const favorite = card.querySelector('.radio-favorite');
      if (favorite) {
        const mark = isFavorite(card, favorites) ? '♥' : '♡';
        if (favorite.textContent !== mark) favorite.textContent = mark;
        favorite.title = isFavorite(card, favorites) ? 'Unpin favorite' : 'Pin to first row';
      }
      const quality = card.querySelector('.radio-quality-pill');
      const qVal = qualityFor(card);
      if (quality) { if (quality.textContent !== qVal) quality.textContent = qVal; quality.title = `Stream quality: ${qVal}`; }
      
      const sub = card.querySelector('.radio-station-sub, .radio-card-copy small');
      if (card.classList.contains('is-starting')) {
        if (active) {
          card.classList.remove('is-starting');
          const playBtn = card.querySelector('.radio-play-btn');
          if (playBtn) playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>';
        } else {
          if (sub) {
            sub.textContent = 'Connecting to stream…';
            sub.classList.add('is-live-meta');
          }
          return;
        }
      }
      if (sub) {
        if (active) {
          const liveText = [currentArtist !== 'OwnTone' && currentArtist, currentMeta].filter(Boolean).join(' · ');
          sub.textContent = liveText ? `▶ ${liveText}` : '▶ Live on air';
          sub.classList.add('is-live-meta');
        } else {
          sub.textContent = `${qVal} · Direct stream`;
          sub.classList.remove('is-live-meta');
        }
      }
      renderHealth(card);
    });
  }

  function animateSettle(el) {
    if (!el) return;
    [...el.querySelectorAll('.radio-card')].forEach((node, index) => {
      node.classList.remove('drop-settle'); void node.offsetWidth;
      setTimeout(() => node.classList.add('drop-settle'), Math.min(index * 18, 110));
      setTimeout(() => node.classList.remove('drop-settle'), 650);
    });
  }
  function finishReorder(card, el) {
    card?.classList.remove('dragging', 'touch-dragging'); card?.setAttribute('aria-grabbed', 'false');
    el?.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
    if (moved && el) { saveOrder(); applyPartition(); animateSettle(el); suppressClickUntil = Date.now() + 400; }
    dragged = null; moved = false; updateActiveAndQuality();
  }

  function enhanceCard(card) {
    if (card.dataset.dragEnhanced === '1') return;
    card.dataset.dragEnhanced = '1';
    card.draggable = false;
    card.setAttribute('aria-grabbed', 'false');
    
    // Ensure top container
    let top = card.querySelector('.radio-card-top');
    if (!top) {
      top = document.createElement('span');
      top.className = 'radio-card-top';
      card.insertBefore(top, card.firstChild);
    }
    
    let badges = top.querySelector('.radio-card-badges');
    if (!badges) {
      badges = document.createElement('span');
      badges.className = 'radio-card-badges';
      top.insertBefore(badges, top.firstChild);
    }
    
    if (!badges.querySelector('.radio-health-pill')) {
      const health = document.createElement('span');
      health.className = 'radio-health-pill';
      health.dataset.status = 'live';
      health.textContent = 'LIVE';
      badges.appendChild(health);
    }
    if (!badges.querySelector('.radio-quality-pill')) {
      const quality = document.createElement('span');
      quality.className = 'radio-quality-pill';
      quality.textContent = qualityFor(card);
      badges.appendChild(quality);
    }
    
    let actions = top.querySelector('.radio-card-actions');
    if (!actions) {
      actions = document.createElement('span');
      actions.className = 'radio-card-actions';
      top.appendChild(actions);
    }
    
    let handle = actions.querySelector('.radio-drag-handle');
    if (!handle) {
      handle = document.createElement('span');
      handle.className = 'radio-drag-handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to reorder';
      handle.textContent = '⠿';
      actions.appendChild(handle);
    }
    handle.setAttribute('draggable', 'true');
    handle.addEventListener('mousedown', () => { card.draggable = true; });
    handle.addEventListener('mouseup', () => { card.draggable = false; });

    if (!actions.querySelector('.radio-favorite')) {
      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'radio-favorite';
      favorite.setAttribute('aria-label', 'Pin favorite station');
      favorite.textContent = '♡';
      favorite.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(card);
      });
      actions.appendChild(favorite);
    }
    
    // Ensure body container with station name and subtitle
    let body = card.querySelector('.radio-card-body');
    if (!body) {
      const existingCopy = card.querySelector('.radio-card-copy');
      const nameText = existingCopy?.querySelector('b')?.textContent?.trim() || stationName(card);
      const subText = existingCopy?.querySelector('small')?.textContent?.trim() || 'OwnTone radio preset';
      
      body = document.createElement('span');
      body.className = 'radio-card-body';
      body.innerHTML = `<b class="radio-station-name">${escapeHtml(nameText)}</b><small class="radio-station-sub">${escapeHtml(subText)}</small>`;
      if (existingCopy) existingCopy.replaceWith(body);
      else card.appendChild(body);
    }
    
    // Ensure foot
    if (!card.querySelector('.radio-card-foot')) {
      const foot = document.createElement('span');
      foot.className = 'radio-card-foot';
      foot.innerHTML = `<span class="radio-play-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg></span>`;
      card.appendChild(foot);
    }

    card.addEventListener('dragstart', event => {
      if (!event.target.closest('.radio-drag-handle') && !card.draggable) {
        event.preventDefault();
        return;
      }
      dragged = card; moved = false; card.classList.add('dragging'); card.setAttribute('aria-grabbed','true'); event.dataTransfer.effectAllowed='move';
      try { event.dataTransfer.setData('text/plain', stationName(card)); } catch (_) {}
    });
    card.addEventListener('dragend', () => {
      card.draggable = false;
      finishReorder(card, grid());
    });

    // Direct click handler to ensure instant playback without relying solely on document bubbling
    card.addEventListener('click', event => {
      if (event.target.closest('.radio-favorite, .radio-drag-handle')) return;
      if (Date.now() < suppressClickUntil) return;
      const uri = card.dataset.uri;
      if (uri) {
        if (typeof window.OWNTONE_PLAY_URI === 'function') {
          window.OWNTONE_PLAY_URI(uri);
        }
      }
    });

    setTimeout(() => checkHealth(card), Math.random() * 650);
  }

  function reorderTowardPoint(el, card, x, y) {
    const hit = document.elementFromPoint(x, y)?.closest('.radio-card'); if (!hit || hit === card || !el.contains(hit)) return;
    el.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target')); hit.classList.add('drop-target');
    const rect = hit.getBoundingClientRect(); const rowBias = Math.abs(y - (rect.top + rect.height/2)) > rect.height*.34;
    const before = rowBias ? y < rect.top + rect.height/2 : x < rect.left + rect.width/2; const anchor = before ? hit : hit.nextSibling;
    if (anchor !== card) { el.insertBefore(card, anchor); moved = true; }
  }

  function wireGrid(el) {
    if (!el || el.dataset.dragGridEnhanced === '1') return; el.dataset.dragGridEnhanced='1';
    el.addEventListener('dragover', event => { if (!dragged) return; event.preventDefault(); event.dataTransfer.dropEffect='move'; reorderTowardPoint(el, dragged, event.clientX, event.clientY); });
    el.addEventListener('drop', event => { if (!dragged) return; event.preventDefault(); moved=true; el.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target')); });
    el.addEventListener('pointerdown', event => {
      const handle = event.target.closest('.radio-drag-handle'); if (!handle) return; const card=handle.closest('.radio-card'); if (!card) return;
      touchPointerId=event.pointerId; touchCard=card; touchActive=false; moved=false; clearTimeout(touchStartTimer);
      touchStartTimer=setTimeout(()=>{touchActive=true;dragged=card;card.classList.add('touch-dragging');card.setAttribute('aria-grabbed','true');try{handle.setPointerCapture(touchPointerId);}catch(_){}if(navigator.vibrate)navigator.vibrate(15);},120);
    });
    el.addEventListener('pointermove', event => { if(!touchActive||event.pointerId!==touchPointerId||!touchCard)return;event.preventDefault();reorderTowardPoint(el,touchCard,event.clientX,event.clientY); }, {passive:false});
    const endPointer = event => { if(event.pointerId!==touchPointerId)return;clearTimeout(touchStartTimer);if(touchActive&&touchCard)finishReorder(touchCard,el);touchPointerId=null;touchCard=null;touchActive=false; };
    el.addEventListener('pointerup',endPointer);el.addEventListener('pointercancel',endPointer);
  }

  function enhance() {
    applyPartition();
    grids().forEach(el => { wireGrid(el); el.querySelectorAll('.radio-card').forEach(enhanceCard); });
    updateActiveAndQuality();
  }
  let scheduled=false;
  const scheduleEnhance=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;enhance();});};
  const observer=new MutationObserver(scheduleEnhance);observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  document.addEventListener('DOMContentLoaded',scheduleEnhance);window.addEventListener('load',scheduleEnhance);
  setInterval(updateActiveAndQuality,3000);setInterval(checkAllHealth,90000);
})();
