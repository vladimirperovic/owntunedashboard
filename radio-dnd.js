(() => {
  'use strict';

  const STORAGE_KEY = 'owntone-radio-order-v1';
  const grid = () => document.getElementById('radioGrid');
  let dragged = null;
  let moved = false;
  let suppressClickUntil = 0;
  let touchPointerId = null;
  let touchCard = null;
  let touchActive = false;
  let touchStartTimer = null;

  const normalize = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  function stationName(card) {
    return card?.querySelector('.radio-card-copy b')?.textContent?.trim() || '';
  }

  function displayName(name) {
    const source = String(name || '').replace(/\s+/g, ' ').trim();
    const withoutPrefix = source.replace(/^radio\s+/i, '');
    const withoutSuffix = withoutPrefix.replace(/\s+radio$/i, '');
    return withoutSuffix.trim() || source || 'LIVE';
  }

  function readSavedOrder() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function saveOrder() {
    const el = grid();
    if (!el) return;
    const order = [...el.querySelectorAll('.radio-card')].map(stationName).filter(Boolean);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch (_) {}
  }

  function applySavedOrder(el) {
    const saved = readSavedOrder();
    if (!saved.length) return;
    const cards = [...el.querySelectorAll('.radio-card')];
    if (!cards.length) return;

    const byName = new Map(cards.map(card => [normalize(stationName(card)), card]));
    const ordered = [];
    const used = new Set();
    saved.forEach(name => {
      const card = byName.get(normalize(name));
      if (card && !used.has(card)) {
        ordered.push(card);
        used.add(card);
      }
    });
    cards.forEach(card => { if (!used.has(card)) ordered.push(card); });

    const current = cards.map(card => normalize(stationName(card))).join('|');
    const wanted = ordered.map(card => normalize(stationName(card))).join('|');
    if (current === wanted) return;
    ordered.forEach(card => el.appendChild(card));
  }

  function extractQuality(text) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '';
    const lossless = source.match(/\b(FLAC|ALAC)\b/i);
    if (lossless) return lossless[1].toUpperCase();
    const codecRate = source.match(/\b(MP3|AAC(?:-LC)?|HE-?AAC|OPUS|OGG)\b[^0-9]{0,10}(\d{2,4})\s*(?:k|kbps)?\b/i);
    if (codecRate) return `${codecRate[1].toUpperCase()} ${codecRate[2]}k`;
    const rateCodec = source.match(/\b(\d{2,4})\s*(?:k|kbps)\b[^A-Z]{0,10}\b(MP3|AAC(?:-LC)?|HE-?AAC|OPUS|OGG)\b/i);
    if (rateCodec) return `${rateCodec[2].toUpperCase()} ${rateCodec[1]}k`;
    const bareRate = source.match(/\b(\d{2,4})\s*(?:k|kbps)\b/i);
    if (bareRate) return `${bareRate[1]}k`;
    return '';
  }

  function configuredQuality(name) {
    const configured = window.OWNTONE_DASHBOARD?.radioQuality || {};
    if (configured[name]) return String(configured[name]);
    const key = normalize(name);
    for (const [station, value] of Object.entries(configured)) {
      if (normalize(station) === key) return String(value);
    }
    return '';
  }

  function nowPlayingQuality(name) {
    const currentName = document.getElementById('trackTitle')?.textContent || '';
    const a = normalize(name);
    const b = normalize(currentName);
    if (!a || !b || !(a.includes(b) || b.includes(a))) return '';
    const pill = document.getElementById('formatPill')?.textContent || '';
    const meta = document.getElementById('trackMeta')?.textContent || '';
    return extractQuality(`${pill} ${meta}`) || pill.trim();
  }

  function qualityFor(card) {
    const name = stationName(card);
    return configuredQuality(name)
      || nowPlayingQuality(name)
      || extractQuality(card.textContent)
      || 'STREAM';
  }

  function updateActiveAndQuality() {
    const currentTitle = normalize(document.getElementById('trackTitle')?.textContent || '');
    document.querySelectorAll('#radioGrid .radio-card').forEach(card => {
      const name = stationName(card);
      const station = normalize(name);
      const active = !!station && !!currentTitle && (station.includes(currentTitle) || currentTitle.includes(station));
      card.classList.toggle('is-active', active);
      card.dataset.monogram = displayName(name);
      card.title = `${name}${active ? ' · On air' : ''}`;
      const quality = card.querySelector('.radio-quality-pill');
      if (quality) {
        const value = qualityFor(card);
        if (quality.textContent !== value) quality.textContent = value;
        quality.title = value === 'STREAM'
          ? 'Exact codec/bitrate is not available in the playlist metadata'
          : `Stream quality: ${value}`;
      }
    });
  }

  function animateSettle(el) {
    [...el.querySelectorAll('.radio-card')].forEach((node, index) => {
      node.classList.remove('drop-settle');
      void node.offsetWidth;
      setTimeout(() => node.classList.add('drop-settle'), Math.min(index * 18, 110));
      setTimeout(() => node.classList.remove('drop-settle'), 650);
    });
  }

  function finishReorder(card, el) {
    card?.classList.remove('dragging', 'touch-dragging');
    card?.setAttribute('aria-grabbed', 'false');
    el?.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
    if (moved && el) {
      saveOrder();
      animateSettle(el);
      suppressClickUntil = Date.now() + 400;
    }
    dragged = null;
    moved = false;
    updateActiveAndQuality();
  }

  function enhanceCard(card) {
    if (card.dataset.dragEnhanced === '1') return;
    card.dataset.dragEnhanced = '1';
    card.draggable = true;
    card.setAttribute('aria-grabbed', 'false');
    card.dataset.monogram = displayName(stationName(card));

    const top = card.querySelector('.radio-card-top');
    if (top && !top.querySelector('.radio-drag-handle')) {
      const handle = document.createElement('span');
      handle.className = 'radio-drag-handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to reorder';
      handle.textContent = '⠿';
      const play = top.querySelector('.radio-play');
      top.insertBefore(handle, play || null);
    }

    const copy = card.querySelector('.radio-card-copy');
    if (copy && !copy.querySelector('.radio-quality-pill')) {
      const quality = document.createElement('span');
      quality.className = 'radio-quality-pill';
      const oldSmall = copy.querySelector('small');
      copy.insertBefore(quality, oldSmall || null);
    }

    card.addEventListener('dragstart', (event) => {
      dragged = card;
      moved = false;
      card.classList.add('dragging');
      card.setAttribute('aria-grabbed', 'true');
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', stationName(card)); } catch (_) {}
    });

    card.addEventListener('dragend', () => finishReorder(card, grid()));
  }

  function reorderTowardPoint(el, card, x, y) {
    const hit = document.elementFromPoint(x, y)?.closest('.radio-card');
    if (!hit || hit === card || !el.contains(hit)) return;
    el.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
    hit.classList.add('drop-target');
    const rect = hit.getBoundingClientRect();
    const rowBias = Math.abs(y - (rect.top + rect.height / 2)) > rect.height * .34;
    const before = rowBias ? y < rect.top + rect.height / 2 : x < rect.left + rect.width / 2;
    const anchor = before ? hit : hit.nextSibling;
    if (anchor !== card) {
      el.insertBefore(card, anchor);
      moved = true;
    }
  }

  function wireGrid(el) {
    if (!el || el.dataset.dragGridEnhanced === '1') return;
    el.dataset.dragGridEnhanced = '1';

    el.addEventListener('dragover', (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      reorderTowardPoint(el, dragged, event.clientX, event.clientY);
    });

    el.addEventListener('drop', (event) => {
      if (!dragged) return;
      event.preventDefault();
      moved = true;
      el.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
    });

    /* Pointer based reordering makes the drag handle work on iPhone/iPad as well. */
    el.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('.radio-drag-handle');
      if (!handle) return;
      const card = handle.closest('.radio-card');
      if (!card) return;
      touchPointerId = event.pointerId;
      touchCard = card;
      touchActive = false;
      moved = false;
      clearTimeout(touchStartTimer);
      touchStartTimer = setTimeout(() => {
        touchActive = true;
        dragged = card;
        card.classList.add('touch-dragging');
        card.setAttribute('aria-grabbed', 'true');
        try { handle.setPointerCapture(touchPointerId); } catch (_) {}
        if (navigator.vibrate) navigator.vibrate(15);
      }, 120);
    });

    el.addEventListener('pointermove', (event) => {
      if (!touchActive || event.pointerId !== touchPointerId || !touchCard) return;
      event.preventDefault();
      reorderTowardPoint(el, touchCard, event.clientX, event.clientY);
    }, {passive:false});

    const endPointer = (event) => {
      if (event.pointerId !== touchPointerId) return;
      clearTimeout(touchStartTimer);
      if (touchActive && touchCard) finishReorder(touchCard, el);
      touchPointerId = null;
      touchCard = null;
      touchActive = false;
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);

    el.addEventListener('click', (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function enhance() {
    const el = grid();
    if (!el) return;
    applySavedOrder(el);
    wireGrid(el);
    el.querySelectorAll('.radio-card').forEach(enhanceCard);
    updateActiveAndQuality();
  }

  let scheduled = false;
  const scheduleEnhance = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhance();
    });
  };

  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(document.documentElement, {subtree:true, childList:true, characterData:true});
  document.addEventListener('DOMContentLoaded', scheduleEnhance);
  window.addEventListener('load', scheduleEnhance);

  /* Keep the active station's quality pill in sync with live ICY metadata / codec changes. */
  setInterval(updateActiveAndQuality, 3000);
})();
