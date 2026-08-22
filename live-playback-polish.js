(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const app = () => window.OWNTONE_APP || null;
  let liveStatus = null;
  let syncTimer = null;
  let observer = null;
  let syncing = false;

  function isLiveItem(item) {
    if (!item) return false;
    if (String(item.data_kind || '').toLowerCase() === 'url') return true;
    if (/^https?:\/\//i.test(String(item.path || ''))) return true;
    if (/^https?:\/\//i.test(String(item.uri || ''))) return true;
    return false;
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function stationLabel(item) {
    const active = document.querySelector('.radio-card.is-active .radio-station-name')?.textContent?.trim();
    if (active) return active;
    const title = String(item?.title || '').trim();
    if (title) return title;
    return 'Live radio';
  }

  function ensureLiveStatus() {
    const block = $('progressBlock');
    if (!block) return null;
    if (liveStatus?.isConnected) return liveStatus;
    liveStatus = document.createElement('div');
    liveStatus.id = 'liveStreamStatus';
    liveStatus.className = 'live-stream-status';
    liveStatus.hidden = true;
    liveStatus.innerHTML = `
      <span class="live-stream-badge"><i aria-hidden="true"></i><b>LIVE STREAM</b></span>
      <span class="live-stream-session" id="liveStreamSession">Connected</span>`;
    block.appendChild(liveStatus);
    return liveStatus;
  }

  function syncLivePresentation() {
    if (syncing) return;
    syncing = true;
    try {
      const state = app()?.state || {};
      const item = state.current || null;
      const live = isLiveItem(item);
      const card = $('playerCard');
      const block = $('progressBlock');
      const status = ensureLiveStatus();
      if (!card || !block || !status) return;

      card.classList.toggle('is-live-current', live);
      block.classList.toggle('is-live-stream', live);
      status.hidden = !live;

      if (live) {
        const station = stationLabel(item);
        const kicker = $('playerKicker');
        if (kicker && kicker.textContent !== 'LIVE NOW') kicker.textContent = 'LIVE NOW';

        const playingFrom = $('playingFrom');
        const source = playingFrom?.querySelector('b');
        if (source && source.textContent !== station) source.textContent = station;
        if (playingFrom) playingFrom.dataset.kind = 'radio';

        const fullscreenSource = $('fullscreenSource');
        if (fullscreenSource && fullscreenSource.textContent !== station) fullscreenSource.textContent = station;

        const elapsed = Number(state.player?.item_progress_ms || 0);
        const session = $('liveStreamSession');
        const sessionText = elapsed > 0 ? `Connected ${fmtTime(elapsed)}` : 'Live connection';
        if (session && session.textContent !== sessionText) session.textContent = sessionText;

        const range = $('progressRange');
        if (range) {
          range.disabled = true;
          range.setAttribute('aria-hidden', 'true');
          range.tabIndex = -1;
        }
      } else {
        const range = $('progressRange');
        if (range) {
          range.disabled = false;
          range.removeAttribute('aria-hidden');
          range.removeAttribute('tabindex');
        }

        const kicker = $('playerKicker');
        if (kicker && kicker.textContent !== 'NOW PLAYING') kicker.textContent = 'NOW PLAYING';

        // clear stale legacy sources (pre-bc637b1 dark layout used playingFrom/fullscreenSource)
        const playingFrom = $('playingFrom');
        if (playingFrom) {
          const staleKind = playingFrom.dataset.kind;
          if (staleKind === 'radio') {
            playingFrom.dataset.kind = 'library';
            const b = playingFrom.querySelector('b');
            if (b) b.textContent = '';
          }
        }
        const fullscreenSource = $('fullscreenSource');
        if (fullscreenSource && !live) {
          // will be refreshed by syncPremiumNowPlaying, clear stale radio label
          if (/radio/i.test(fullscreenSource.textContent || '')) fullscreenSource.textContent = '';
        }
      }
    } finally {
      syncing = false;
    }
  }

  function mount() {
    ensureLiveStatus();
    syncLivePresentation();

    observer = new MutationObserver(() => {
      window.requestAnimationFrame(syncLivePresentation);
    });
    const card = $('playerCard');
    if (card) {
      observer.observe(card, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'src'],
      });
    }

    clearInterval(syncTimer);
    syncTimer = setInterval(syncLivePresentation, 500);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncLivePresentation();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
