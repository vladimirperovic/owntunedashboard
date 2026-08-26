(() => {
  'use strict';

  const app = () => window.OWNTONE_APP || null;
  const TYPING = /input|textarea|select|button|a|summary/i;

  function ensureLegend() {
    let dialog = document.getElementById('shortcutsDialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'shortcutsDialog';
    dialog.className = 'shortcuts-dialog';
    dialog.innerHTML = `
      <div class="shortcuts-panel">
        <span class="section-kicker">KEYBOARD</span>
        <h2>Shortcuts</h2>
        <div class="shortcuts-grid">
          <kbd>M</kbd><span>Mute / unmute</span>
          <kbd>Space</kbd><span>Play / pause</span>
          <kbd>N</kbd><span>Next track</span>
          <kbd>P</kbd><span>Previous track</span>
          <kbd>← →</kbd><span>Seek −/+ 10 s</span>
          <kbd>↑ ↓</kbd><span>Volume +/− 5%</span>
          <kbd>R</kbd><span>Toggle radio / music view</span>
          <kbd>?</kbd><span>This panel</span>
          <kbd>Esc</kbd><span>Close panels and dialogs</span>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', e => {
      if (e.target === dialog) dialog.close();
    });
    return dialog;
  }

  function seekBy(deltaMs) {
    const state = app()?.state;
    if (!state) return;
    const len = Number(state.player?.item_length_ms || state.current?.length_ms || 0);
    const pos = Number(state.player?.item_progress_ms || 0);
    const ratio = len ? Math.min(1, Math.max(0, (pos + deltaMs) / len)) : 0;
    app()?.seekTo?.(ratio);
  }

  function volumeBy(delta) {
    const appInstance = app();
    if (!appInstance) return;
    const current = Number(document.getElementById('volumeRange')?.value || 0);
    appInstance.setVolume?.(Math.max(0, Math.min(100, current + delta)));
  }

  document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // app.js registers its own document handler first (config.js guarantees the
    // load order) and calls preventDefault() when it has claimed the key --
    // Space or Enter on a focused .radio-card, for one. Without this guard the
    // station started *and* the player toggled on the same keystroke.
    if (event.defaultPrevented) return;
    const tag = String(event.target?.tagName || '').toLowerCase();
    // TYPING also covers <button> and <a>: Space is their own activation key,
    // and preventDefault() below would otherwise swallow it, leaving every
    // button in the dashboard unusable from the keyboard.
    if (TYPING.test(tag) || event.target?.isContentEditable) return;
    if (event.target?.closest?.('[role="button"],[contenteditable="true"]')) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        app()?.playerCommand?.('toggle');
        break;
      case 'ArrowRight':
        event.preventDefault();
        seekBy(10000);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        seekBy(-10000);
        break;
      case 'ArrowUp':
        event.preventDefault();
        volumeBy(5);
        break;
      case 'ArrowDown':
        event.preventDefault();
        volumeBy(-5);
        break;
      case 'n':
      case 'N':
        app()?.playerCommand?.('next');
        break;
      case 'p':
      case 'P':
        app()?.playerCommand?.('previous');
        break;
      case 'r':
      case 'R':
        // A real toggle, as the legend promises. Switching view does not touch
        // playback, so there was never a reason to refuse it while radio plays.
        document.getElementById('modeToggle')?.click();
        break;
      case '?': {
        const d = ensureLegend();
        typeof d.showModal === 'function' ? d.showModal() : d.setAttribute('open', '');
        break;
      }
      default:
        break;
    }
  });
})();
