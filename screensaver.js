(() => {
  'use strict';

  const IDLE_MS = 60000;
  let overlay;
  let clockEl;
  let titleEl;
  let subEl;
  let idleTimer;
  let clockTimer;
  let visible = false;

  function app() {
    return window.OWNTONE_APP || null;
  }

  function playing() {
    const state = app()?.state;
    return state?.player?.state === 'play' && !state?.demo && state?.online;
  }

  function nowInfo() {
    const state = app()?.state || {};
    const item = state.current || {};
    const isRadio = item.data_kind === 'url' || /^https?:\/\//i.test(String(item.path || ''));
    return {
      title: item.title || 'OwnTone',
      sub: isRadio
        ? [item.artist, item.album].filter(Boolean).join(' · ') || 'Live radio'
        : [item.artist, item.album].filter(Boolean).join(' · ') || 'OwnTone',
      art: document.getElementById('artwork')?.getAttribute('src') || '',
    };
  }

  function tickClock() {
    if (clockEl)
      clockEl.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function show() {
    if (!playing() || document.hidden) return;
    const info = nowInfo();
    const art = overlay.querySelector('.screensaver-art');
    if ((info.art && /^data:|^blob:|^\//.test(info.art)) || /^(https?:)?\/\//.test(info.art)) {
      art.style.backgroundImage = `url("${info.art.replace(/"/g, '%22')}")`;
    } else {
      art.style.backgroundImage = '';
    }
    titleEl.textContent = info.title;
    subEl.textContent = info.sub;
    tickClock();
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    visible = true;
    clearInterval(clockTimer);
    clockTimer = setInterval(tickClock, 15000);
  }

  function hide() {
    if (!visible) return;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    visible = false;
    clearInterval(clockTimer);
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (visible) hide();
    idleTimer = setTimeout(() => show(), IDLE_MS);
  }

  function mount() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'screensaverOverlay';
    overlay.className = 'screensaver';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="screensaver-art"></div>
      <div class="screensaver-content">
        <div class="screensaver-clock" id="screensaverClock">--:--</div>
        <b class="screensaver-title" id="screensaverTitle"></b>
        <small class="screensaver-sub" id="screensaverSub"></small>
      </div>`;
    document.body.appendChild(overlay);
    clockEl = overlay.querySelector('#screensaverClock');
    titleEl = overlay.querySelector('#screensaverTitle');
    subEl = overlay.querySelector('#screensaverSub');

    ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(evt =>
      window.addEventListener(evt, resetIdle, { passive: true })
    );
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hide();
      else resetIdle();
    });
    resetIdle();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
