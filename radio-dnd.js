(() => {
  'use strict';

  const STORAGE_KEY = 'owntone-radio-order-v1';
  const grid = () => document.getElementById('radioGrid');
  let dragged = null;
  let moved = false;
  let suppressClickUntil = 0;

  const normalize = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  function stationName(card) {
    return card?.querySelector('.radio-card-copy b')?.textContent?.trim() || '';
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
    const byName = new Map(cards.map(card => [normalize(stationName(card)), card]));
    const used = new Set();
    saved.forEach(name => {
      const card = byName.get(normalize(name));
      if (card) {
        el.appendChild(card);
        used.add(card);
      }
    });
    cards.forEach(card => { if (!used.has(card)) el.appendChild(card); });
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

  function monogram(name) {
    const cleaned = String(name || '').replace(/\bradio\b/ig, '').trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (!words.length) return 'LIVE';
    if (words.length === 1) return words[0].slice(0, 7);
    return words.slice(0, 2).map(word => word.slice(0, 5)).join('\n');
  }

  function updateActiveAndQuality() {
    const currentTitle = normalize(document.getElementById('trackTitle')?.textContent || '');
    document.querySelectorAll('#radioGrid .radio-card').forEach(card => {
      const name = stationName(card);
      const station = normalize(name);
      const active = !!station && !!currentTitle && (station.includes(currentTitle) || currentTitle.includes(station));
      card.classList.toggle('is-active', active);
      card.dataset.monogram = monogram(name);
      const quality = card.querySelector('.radio-quality-pill');
      if (quality) {
        const value = qualityFor(card);
        quality.textContent = value;
        quality.title = value === 'STREAM'
          ? 'Exact codec/bitrate is not available in the playlist metadata'
          : `Stream quality: ${value}`;
      }
    });
  }

  function enhanceCard(card) {
    if (card.dataset.dragEnhanced === '1') return;
    card.dataset.dragEnhanced = '1';
    card.draggable = true;
    card.setAttribute('aria-grabbed', 'false');
    card.dataset.monogram = monogram(stationName(card));

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
      requestAnimationFrame(() => card.classList.add('dragging'));
    });

    card.addEventListener('dragend', () => {
      const el = grid();
      card.classList.remove('dragging');
      card.setAttribute('aria-grabbed', 'false');
      el?.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
      if (moved && el) {
        saveOrder();
        [...el.querySelectorAll('.radio-card')].forEach((node, index) => {
          node.classList.remove('drop-settle');
          void node.offsetWidth;
          setTimeout(() => node.classList.add('drop-settle'), Math.min(index * 18, 110));
          setTimeout(() => node.classList.remove('drop-settle'), 650);
        });
        suppressClickUntil = Date.now() + 350;
      }
      dragged = null;
      moved = false;
      updateActiveAndQuality();
    });
  }

  function wireGrid(el) {
    if (!el || el.dataset.dragGridEnhanced === '1') return;
    el.dataset.dragGridEnhanced = '1';

    el.addEventListener('dragover', (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const target = event.target.closest('.radio-card');
      if (!target || target === dragged || !el.contains(target)) return;
      el.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
      target.classList.add('drop-target');
      const rect = target.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      const anchor = before ? target : target.nextSibling;
      if (anchor !== dragged && target !== dragged.nextSibling) {
        el.insertBefore(dragged, anchor);
        moved = true;
      }
    });

    el.addEventListener('drop', (event) => {
      if (!dragged) return;
      event.preventDefault();
      moved = true;
      el.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
    });

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
