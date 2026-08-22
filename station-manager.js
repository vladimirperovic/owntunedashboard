(() => {
  'use strict';

  const cfg = Object.assign({ schedulerBase: '/scheduler' }, window.OWNTONE_DASHBOARD || {});
  const base = String(cfg.schedulerBase || '/scheduler').replace(/\/$/, '');
  const trashIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>';
  let dialog;
  let listEl;
  let msgEl;
  let nameInput;
  let urlInput;

  function say(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._stationTimer);
    el._stationTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  async function api(path, options = {}) {
    const response = await fetch(`${base}${path}`, options);
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try { detail = (await response.json()).error || detail; } catch (_) {}
      throw new Error(detail);
    }
    return response.json();
  }

  function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function refreshList() {
    try {
      const data = await api('/stations', { cache: 'no-store' });
      const items = data?.items || [];
      listEl.innerHTML = items.length ? items.map(s => `
        <div class="station-row">
          <span><b>${escapeHtml(s.name)}</b><small>${escapeHtml(s.url || s.file)}</small></span>
          <button class="station-del" type="button" data-slug="${escapeHtml(s.slug)}" title="Delete ${escapeHtml(s.name)}" aria-label="Delete ${escapeHtml(s.name)}">${trashIcon}</button>
        </div>`).join('') : '<div class="station-row"><span><b>No station files yet</b><small>Add one below — it lands in the Radio folder.</small></span></div>';
      listEl.querySelectorAll('[data-slug]').forEach(btn => btn.addEventListener('click', () => removeStation(btn.dataset.slug)));
    } catch (error) {
      listEl.innerHTML = `<div class="station-row"><span><b>Unavailable</b><small>${escapeHtml(error.message)}</small></span></div>`;
    }
  }

  async function addStation() {
    msgEl.textContent = 'Saving…';
    msgEl.classList.remove('error');
    try {
      await api('/stations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value.trim(), url: urlInput.value.trim() }),
      });
      nameInput.value = '';
      urlInput.value = '';
      msgEl.textContent = 'Saved — library rescan started.';
      await refreshList();
      setTimeout(() => window.OWNTONE_APP?.refreshLibrary?.(), 4000);
      say('Station added');
    } catch (error) {
      msgEl.textContent = error.message;
      msgEl.classList.add('error');
    }
  }

  async function removeStation(slug) {
    try {
      await api(`/stations/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      msgEl.textContent = 'Deleted — library rescan started.';
      await refreshList();
      setTimeout(() => window.OWNTONE_APP?.refreshLibrary?.(), 4000);
      say('Station deleted');
    } catch (error) {
      msgEl.textContent = error.message;
      msgEl.classList.add('error');
    }
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'stationsDialog';
    dialog.className = 'stations-dialog';
    dialog.innerHTML = `
      <div class="stations-panel">
        <span class="section-kicker">RADIO</span>
        <h2>Stations</h2>
        <p class="stations-sub">Files in the Radio folder. Deleting removes the .m3u and rescans.</p>
        <div class="station-list" id="stationList"><div class="station-row"><span><b>Loading…</b></span></div></div>
        <form class="station-form" id="stationForm">
          <input id="stationName" type="text" placeholder="Station name" maxlength="60" autocomplete="off" required>
          <input id="stationUrl" type="url" placeholder="https://stream.example/live" autocomplete="off" required>
          <button type="submit">Add</button>
          <div class="station-msg" id="stationMsg"></div>
        </form>
      </div>`;
    document.body.appendChild(dialog);
    listEl = dialog.querySelector('#stationList');
    msgEl = dialog.querySelector('#stationMsg');
    nameInput = dialog.querySelector('#stationName');
    urlInput = dialog.querySelector('#stationUrl');
    dialog.querySelector('#stationForm').addEventListener('submit', e => { e.preventDefault(); addStation(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    return dialog;
  }

  function openManager() {
    ensureDialog();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    refreshList();
  }

  function mount() {
    if (document.getElementById('manageStations')) return;
    const intro = document.querySelector('.radio-intro');
    if (!intro) return;
    const button = document.createElement('button');
    button.id = 'manageStations';
    button.className = 'text-button';
    button.type = 'button';
    button.textContent = 'Manage stations';
    button.addEventListener('click', openManager);
    intro.appendChild(button);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
