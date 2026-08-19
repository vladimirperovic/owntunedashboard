(() => {
  'use strict';

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

  function relocateMobileFolders() {
    const button = document.getElementById('foldersMobileButton');
    const heading = document.getElementById('albumsSection');
    if (!button || !heading || button.dataset.uxRelocated === '1') return false;

    button.dataset.uxRelocated = '1';
    button.className = 'library-folders-button';
    button.innerHTML = 'Folders';
    button.setAttribute('aria-label', 'Browse music folders');
    button.title = 'Browse music folders';
    heading.appendChild(button);
    return true;
  }

  function mount() {
    syncConnectionState();
    relocateMobileFolders();

    const connection = document.getElementById('connectionText');
    if (connection && connection.dataset.uxObserved !== '1') {
      connection.dataset.uxObserved = '1';
      new MutationObserver(syncConnectionState).observe(connection, {subtree:true, childList:true, characterData:true});
    }

    if (!relocateMobileFolders()) {
      const bodyObserver = new MutationObserver(() => {
        if (relocateMobileFolders()) bodyObserver.disconnect();
      });
      bodyObserver.observe(document.body, {subtree:true, childList:true});
      setTimeout(() => bodyObserver.disconnect(), 12000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
