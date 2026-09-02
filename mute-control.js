(() => {
  'use strict';

  const { config: cfg, setOutputVolume } = window.OwnTone;
  const STORAGE_KEY = 'owntone-dashboard-last-volume-v1';
  let button;
  let busy = false;

  const icons = {
    sound:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 9.5a4 4 0 0 1 0 5"/><path d="M19 7a7.5 7.5 0 0 1 0 10"/></svg>',
    muted:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m17 9 5 5M22 9l-5 5"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };

  const STEP = 5;

  function selectedOutputId() {
    return document.getElementById('outputSelect')?.value || '';
  }

  function selectedOutputKey() {
    const select = document.getElementById('outputSelect');
    if (!select) return 'default';
    const option = select.options?.[select.selectedIndex];
    return String(option?.textContent || select.value || 'default').trim();
  }

  function currentVolume() {
    const range = document.getElementById('volumeRange');
    return Math.max(0, Math.min(100, Number(range?.value || 0)));
  }

  function readLastVolume() {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return Number(all[selectedOutputKey()] || 0);
    } catch (_) {
      return 0;
    }
  }

  function saveLastVolume(value) {
    if (!(value > 0)) return;
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      all[selectedOutputKey()] = Math.round(value);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (_) {}
  }

  function setLocalVolume(value) {
    const volume = Math.max(0, Math.min(100, Math.round(value)));
    const range = document.getElementById('volumeRange');
    const label = document.getElementById('volumeValue');
    if (range) {
      range.value = String(volume);
      range.style.setProperty('--range-progress', `${volume}%`);
    }
    if (label) label.textContent = `${volume}%`;
    render();
  }

  async function setServerVolume(value) {
    await setOutputVolume(selectedOutputId(), value);
  }

  function render() {
    if (!button) return;
    const muted = currentVolume() === 0;
    button.classList.toggle('is-muted', muted);
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    button.title = muted ? 'Unmute (M)' : 'Mute (M)';
    const key = muted ? 'muted' : 'sound';
    if (button.dataset.icon !== key) {
      button.innerHTML = icons[key];
      button.dataset.icon = key;
    }
  }

  async function toggleMute() {
    if (busy) return;
    busy = true;
    button?.classList.add('is-busy');
    try {
      const volume = currentVolume();
      if (volume > 0) {
        saveLastVolume(volume);
        setLocalVolume(0);
        await setServerVolume(0);
      } else {
        const restore = Math.max(1, Math.min(100, readLastVolume() || Number(cfg.safeUnmuteVolume) || 10));
        setLocalVolume(restore);
        await setServerVolume(restore);
      }
    } catch (error) {
      console.warn('Mute control failed:', error);
      // Let the normal OwnTone poll restore the real value if the API request failed.
    } finally {
      busy = false;
      button?.classList.remove('is-busy');
      render();
    }
  }

  async function stepVolume(delta) {
    if (busy) return;
    busy = true;
    const stepBtn = delta > 0 ? plusButton : minusButton;
    stepBtn?.classList.add('is-busy');
    try {
      const next = Math.max(0, Math.min(100, Math.round(currentVolume() + delta)));
      setLocalVolume(next);
      if (next > 0) saveLastVolume(next);
      await setServerVolume(next);
    } catch (error) {
      console.warn('Volume step failed:', error);
    } finally {
      busy = false;
      stepBtn?.classList.remove('is-busy');
      render();
    }
  }

  let plusButton;
  let minusButton;

  function mount() {
    if (document.getElementById('muteButton')) {
      button = document.getElementById('muteButton');
      plusButton = document.getElementById('volumePlusButton');
      minusButton = document.getElementById('volumeMinusButton');
      render();
      return;
    }

    const dock = document.querySelector('.audio-dock');
    const volumeRow = dock?.querySelector('.volume-output-row');
    if (!dock || !volumeRow) return;

    button = document.createElement('button');
    button.id = 'muteButton';
    button.className = 'mute-button';
    button.type = 'button';
    button.addEventListener('click', toggleMute);

    const volumeWrap = volumeRow.querySelector('.volume-wrap');
    if (volumeWrap) volumeWrap.insertBefore(button, volumeWrap.firstChild);
    else volumeRow.insertBefore(button, volumeRow.firstChild);

    plusButton = document.createElement('button');
    plusButton.id = 'volumePlusButton';
    plusButton.className = 'volume-step volume-step--plus';
    plusButton.type = 'button';
    plusButton.title = `Volume up (+${STEP}%)`;
    plusButton.setAttribute('aria-label', `Volume up ${STEP} percent`);
    plusButton.innerHTML = icons.plus;
    plusButton.addEventListener('click', () => stepVolume(STEP));

    minusButton = document.createElement('button');
    minusButton.id = 'volumeMinusButton';
    minusButton.className = 'volume-step volume-step--minus';
    minusButton.type = 'button';
    minusButton.title = `Volume down (-${STEP}%)`;
    minusButton.setAttribute('aria-label', `Volume down ${STEP} percent`);
    minusButton.innerHTML = icons.minus;
    minusButton.addEventListener('click', () => stepVolume(-STEP));

    if (volumeWrap) volumeWrap.appendChild(minusButton);
    if (volumeWrap) volumeWrap.appendChild(plusButton);

    const mobileNav = document.querySelector('.mobile-nav');
    if (mobileNav && !document.getElementById('muteNavButton')) {
      const navMute = document.createElement('button');
      navMute.id = 'muteNavButton';
      navMute.type = 'button';
      navMute.setAttribute('aria-label', 'Mute');
      const updateNavMute = () => {
        const muted = currentVolume() === 0;
        const raw = muted ? icons.muted : icons.sound;
        const withClass = raw.replace('<svg', '<svg class="ui-icon"');
        navMute.innerHTML = `<span class="mobile-nav-icon" aria-hidden="true">${withClass}</span><small>${muted ? 'Unmute' : 'Mute'}</small>`;
        navMute.classList.toggle('is-muted', muted);
      };
      navMute.addEventListener('click', toggleMute);
      mobileNav.appendChild(navMute);
      setInterval(updateNavMute, 1500);
      updateNavMute();
      mobileNav.style.gridTemplateColumns = `repeat(${mobileNav.querySelectorAll('button').length}, 1fr)`;
    }

    function layoutDockSecondRow() {
      if (window.innerWidth > 620) return false;
      const sleepBtn = document.getElementById('sleepButton');
      const outputBtn = document.getElementById('premiumOutputButton');
      const dock = document.querySelector('.audio-dock');
      if (!sleepBtn || !outputBtn || !dock) return false;

      let secondRow = dock.querySelector('.dock-second-row');
      if (!secondRow) {
        secondRow = document.createElement('div');
        secondRow.className = 'dock-second-row';
        outputBtn.parentElement?.appendChild(secondRow);
      }
      if (outputBtn.parentElement !== secondRow) secondRow.appendChild(outputBtn);

      let leftMoreBtn = document.getElementById('leftMoreButton');
      if (!leftMoreBtn) {
        leftMoreBtn = document.createElement('button');
        leftMoreBtn.id = 'leftMoreButton';
        leftMoreBtn.className = 'dock-more-button left-more';
        leftMoreBtn.type = 'button';
        leftMoreBtn.setAttribute('aria-label', 'More actions');
        leftMoreBtn.title = 'More';
        leftMoreBtn.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="17" r="1" fill="currentColor" stroke="none"/></svg>';
        leftMoreBtn.addEventListener('click', () => {
          const cur = document.querySelector('.album-card[data-uri]');
          const trig = cur?.querySelector('.context-menu-trigger');
          if (trig) trig.click();
          else document.getElementById('queueDrawerButton')?.click();
        });
      }

      let moreBtn = document.getElementById('dockMoreButton');
      if (!moreBtn) {
        moreBtn = document.createElement('button');
        moreBtn.id = 'dockMoreButton';
        moreBtn.className = 'dock-more-button';
        moreBtn.type = 'button';
        moreBtn.setAttribute('aria-label', 'More options');
        moreBtn.title = 'More';
        moreBtn.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;fill:currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>';
        const qBtn = document.getElementById('queueDrawerButton');
        if (qBtn) moreBtn.addEventListener('click', () => qBtn.click());
        else moreBtn.addEventListener('click', () => document.getElementById('premiumOutputButton')?.click());
      }

      if (leftMoreBtn.parentElement !== secondRow) secondRow.insertBefore(leftMoreBtn, secondRow.firstChild);
      if (sleepBtn.parentElement !== secondRow) secondRow.appendChild(sleepBtn);
      if (moreBtn.parentElement !== secondRow) secondRow.appendChild(moreBtn);
      sleepBtn.style.position = 'static';
      sleepBtn.style.margin = '0';
      return true;
    }

    if (!layoutDockSecondRow()) {
      const obs = new MutationObserver(() => {
        if (layoutDockSecondRow()) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 4000);
    }
    window.addEventListener('owntone:sleep-mounted', layoutDockSecondRow);
    window.addEventListener('resize', layoutDockSecondRow);

    const range = document.getElementById('volumeRange');
    if (range && volumeWrap && !volumeWrap.querySelector('.volume-tooltip')) {
      const tip = document.createElement('output');
      tip.className = 'volume-tooltip';
      tip.setAttribute('aria-hidden', 'true');
      volumeWrap.appendChild(tip);
      const positionTip = () => {
        const v = Number(range.value) || 0;
        const width = range.offsetWidth;
        const thumb = 13;
        tip.textContent = `${v}%`;
        tip.style.left = `${range.offsetLeft + thumb / 2 + ((width - thumb) * v) / 100}px`;
        tip.classList.add('show');
      };
      range.addEventListener('input', positionTip);
      range.addEventListener('pointerdown', positionTip);
      range.addEventListener('change', () => setTimeout(() => tip.classList.remove('show'), 450));
      range.addEventListener('pointerup', () => setTimeout(() => tip.classList.remove('show'), 450));
    }
    range?.addEventListener('input', render);
    document.getElementById('outputSelect')?.addEventListener('change', () => setTimeout(render, 50));
    render();
  }

  // Mute + up/down steppers share one keyboard handler: M toggles mute,
  // arrow-up / arrow-right raise the volume, arrow-down / arrow-left lower it.
  document.addEventListener('keydown', event => {
    const tag = String(event.target?.tagName || '').toLowerCase();
    if (event.metaKey || event.ctrlKey || event.altKey || /input|textarea|select/.test(tag)) return;
    if (event.key?.toLowerCase() === 'm') {
      event.preventDefault();
      toggleMute();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault();
      stepVolume(STEP);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault();
      stepVolume(-STEP);
    }
  });

  // Scoped to the dock the button lives in. This used to watch every node in
  // the document and re-render on each change the 3 s poll caused — the same
  // pattern index.html dropped for being far too expensive. Remounting is all
  // the observer is needed for; the interval below keeps the icon in step with
  // volume changes the server pushes into the slider.
  const dock = document.querySelector('.audio-dock');
  if (dock) {
    new MutationObserver(() => {
      if (!button || !document.body.contains(button)) mount();
    }).observe(dock, { subtree: true, childList: true });
  }

  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();
  setInterval(render, 1500);
})();
