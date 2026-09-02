(() => {
  'use strict';

  const MOBILE_MAX = 620;

  function restoreDesktopDock() {
    if (window.innerWidth <= MOBILE_MAX) return false;

    const dock = document.querySelector('.audio-dock');
    const row = dock?.querySelector('.volume-output-row');
    if (!dock || !row) return false;

    const secondRow = dock.querySelector('.dock-second-row');
    const output = document.getElementById('premiumOutputButton');
    const outputSelect = document.getElementById('outputSelect');
    const sleep = document.getElementById('sleepButton');

    if (output && output.parentElement !== row) {
      if (outputSelect?.parentElement === row) outputSelect.insertAdjacentElement('afterend', output);
      else row.appendChild(output);
    }

    if (sleep && sleep.parentElement !== row) row.appendChild(sleep);
    sleep?.style.removeProperty('position');
    sleep?.style.removeProperty('margin');

    document.getElementById('leftMoreButton')?.remove();
    document.getElementById('dockMoreButton')?.remove();
    secondRow?.remove();
    return Boolean(output && sleep);
  }

  function reconcile() {
    if (window.innerWidth > MOBILE_MAX) restoreDesktopDock();
  }

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(reconcile);
  });
  window.addEventListener('owntone:sleep-mounted', reconcile);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reconcile, { once: true });
  else reconcile();
})();
