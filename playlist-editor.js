(() => {
  'use strict';

  const { scheduler: api, escapeHtml, toast: say, icons } = window.OwnTone;
  const trashIcon = icons.trash;
  let dialog;
  let listEl;
  let editorEl;
  let msgEl;
  let currentSlug = '';
  let listVersion = 0;
  let editorVersion = 0;
  let mutating = false;
  let refreshTimer;

  function setBusy(value) {
    mutating = value;
    dialog.querySelectorAll('button, input').forEach(el => (el.disabled = value));
  }

  function refreshLibraryLater() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      Promise.resolve()
        .then(() => window.OWNTONE_APP?.refreshLibrary?.())
        .catch(() => {
          say('Playlist saved, but the library refresh failed');
        });
    }, 4000);
  }

  async function renderList() {
    const version = ++listVersion;
    try {
      const data = await api('/playlists', { cache: 'no-store' });
      if (version !== listVersion) return;
      const items = data?.items || [];
      listEl.innerHTML = items.length
        ? items
            .map(
              p => `
        <button type="button" class="station-row playlist-pick ${p.slug === currentSlug ? 'active' : ''}" data-slug="${escapeHtml(p.slug)}">
          <span><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.track_count)} tracks · ${escapeHtml(p.file)}</small></span>
        </button>`
            )
            .join('')
        : '<div class="station-row"><span><b>No playlists yet</b><small>Create one below.</small></span></div>';
      listEl
        .querySelectorAll('[data-slug]')
        .forEach(btn => btn.addEventListener('click', () => openEditor(btn.dataset.slug)));
    } catch (error) {
      if (version !== listVersion) return;
      listEl.innerHTML = `<div class="station-row"><span><b>Unavailable</b><small>${escapeHtml(error.message)}</small></span></div>`;
    }
  }

  async function openEditor(slug) {
    if (mutating) return;
    const version = ++editorVersion;
    currentSlug = slug || '';
    editorEl.hidden = true;
    setMsg('');
    if (!slug) {
      editorEl.hidden = true;
      return;
    }
    try {
      const data = await api('/playlists', { cache: 'no-store' });
      if (version !== editorVersion) return;
      const item = (data?.items || []).find(p => p.slug === slug);
      if (!item) throw new Error('Playlist not found');
      renderEditor(item);
      editorEl.hidden = false;
    } catch (error) {
      if (version === editorVersion) say(`Load failed: ${error.message}`);
    }
  }

  function renderEditor(item) {
    editorEl.innerHTML = `
      <h3>${escapeHtml(item.name)} <small>(${escapeHtml(item.track_count)})</small></h3>
      <div class="pline-list" id="plineList">${(item.lines || []).map((line, i) => plineRow(line, i)).join('') || '<div class="browse-empty">Empty — add stream URLs or /paths below.</div>'}</div>
      <form class="pline-add" id="plineAddForm">
        <input type="text" placeholder="Stream URL or /media/music/path/file.flac" aria-label="New line">
        <button type="submit">Add</button>
      </form>
      <div class="pline-actions">
        <button type="button" class="pline-save" id="plineSave">Save & rescan</button>
        <button type="button" class="pline-delete" id="plineDelete">${trashIcon} Delete playlist</button>
      </div>`;
    wireEditor();
  }

  // The full line lives in data-line, never in the text node. It used to be read
  // back from textContent, which had already been shortened for display -- so
  // saving a playlist rewrote every path longer than 58 characters as its own
  // truncated prefix. CSS does the shortening now, and nothing is lost.
  function plineRow(line, index) {
    return `<div class="pline" draggable="false">
      <span class="pline-text" data-line="${escapeHtml(line)}" title="${escapeHtml(line)}">${escapeHtml(line)}</span>
      <button type="button" data-up="${index}" title="Up">↑</button>
      <button type="button" data-down="${index}" title="Down">↓</button>
      <button type="button" data-del="${index}" title="Remove">×</button>
    </div>`;
  }

  function collectLines() {
    return [...editorEl.querySelectorAll('.pline-text')]
      .map(el => String(el.dataset.line ?? '').trim())
      .filter(Boolean);
  }

  function rerenderFromLines(lines) {
    editorEl.querySelector('#plineList').innerHTML = lines.map((l, i) => plineRow(l, i)).join('');
    wireEditor();
  }

  function wireEditor() {
    editorEl
      .querySelectorAll('[data-up]')
      .forEach(b => b.addEventListener('click', () => moveLine(Number(b.dataset.up), -1)));
    editorEl
      .querySelectorAll('[data-down]')
      .forEach(b => b.addEventListener('click', () => moveLine(Number(b.dataset.down), 1)));
    editorEl.querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', () => {
        const lines = collectLines();
        lines.splice(Number(b.dataset.del), 1);
        rerenderFromLines(lines);
      })
    );
    editorEl.querySelector('#plineAddForm').onsubmit = e => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      const value = input.value.trim();
      if (!value) return;
      const lines = collectLines();
      lines.push(value);
      input.value = '';
      rerenderFromLines(lines);
    };
    editorEl.querySelector('#plineSave').onclick = save;
    editorEl.querySelector('#plineDelete').onclick = removeCurrent;
  }

  function moveLine(index, delta) {
    const lines = collectLines();
    const target = index + delta;
    if (target < 0 || target >= lines.length) return;
    [lines[index], lines[target]] = [lines[target], lines[index]];
    rerenderFromLines(lines);
  }

  async function save() {
    if (mutating || !currentSlug || editorEl.hidden) return;
    setBusy(true);
    setMsg('Saving…');
    try {
      await api(`/playlists/${encodeURIComponent(currentSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: collectLines() }),
      });
      setMsg('Saved — rescan started.');
      refreshLibraryLater();
      say('Playlist saved');
      await renderList();
    } catch (error) {
      setMsg(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function removeCurrent() {
    if (mutating || !currentSlug || editorEl.hidden) return;
    setBusy(true);
    setMsg('Deleting…');
    try {
      await api(`/playlists/${encodeURIComponent(currentSlug)}`, { method: 'DELETE' });
      currentSlug = '';
      editorEl.hidden = true;
      setMsg('');
      say('Playlist deleted');
      refreshLibraryLater();
      await renderList();
    } catch (error) {
      setMsg(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  function setMsg(text, error = false) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.classList.toggle('error', !!error);
  }

  async function createPlaylist(name) {
    if (mutating) return;
    setBusy(true);
    const version = ++editorVersion;
    let created;
    try {
      await api('/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      say('Playlist created');
      await renderList();
      const data = await api('/playlists', { cache: 'no-store' });
      created = (data?.items || []).reverse().find(p => p.name.toLowerCase() === name.toLowerCase());
    } catch (error) {
      say(error.message);
    } finally {
      setBusy(false);
    }
    if (created && version === editorVersion) await openEditor(created.slug);
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'playlistsDialog';
    dialog.className = 'stations-dialog';
    dialog.style.maxWidth = '560px';
    dialog.innerHTML = `
      <div class="stations-panel">
        <span class="section-kicker">MUSIC</span>
        <h2>Playlists</h2>
        <p class="stations-sub">Plain .m3u files in the Playlists folder. Saving rescans the library.</p>
        <div class="playlist-create" style="display:flex;gap:8px;margin-bottom:12px">
          <input id="newPlaylistName" type="text" placeholder="New playlist name…" maxlength="60"
            style="flex:1;height:38px;padding:0 12px;border-radius:11px;border:1px solid rgba(20,16,12,.1);background:rgba(255,255,255,.6);font-size:12px;color:inherit;outline:0">
          <button type="button" id="newPlaylistCreate" style="height:38px;padding:0 14px;border-radius:11px;border:0;background:var(--coral);color:#fff;font-size:11.5px;font-weight:800;cursor:pointer">Create</button>
        </div>
        <div class="station-list" id="playlistsPickList"></div>
        <div id="playlistsEditor" hidden></div>
        <div class="station-msg" id="playlistsMsg"></div>
      </div>`;
    document.body.appendChild(dialog);
    listEl = dialog.querySelector('#playlistsPickList');
    editorEl = dialog.querySelector('#playlistsEditor');
    msgEl = dialog.querySelector('#playlistsMsg');
    dialog.querySelector('#newPlaylistCreate').addEventListener('click', () => {
      const input = dialog.querySelector('#newPlaylistName');
      if (input.value.trim()) createPlaylist(input.value.trim());
      input.value = '';
    });
    dialog.querySelector('#newPlaylistName').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dialog.querySelector('#newPlaylistCreate').click();
      }
    });
    dialog.addEventListener('click', e => {
      if (e.target === dialog) dialog.close();
    });
    return dialog;
  }

  function open() {
    ensureDialog();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    renderList();
  }

  function mount() {
    if (document.getElementById('managePlaylists')) return;
    const refresh = document.getElementById('refreshButton');
    if (!refresh) return;
    const button = document.createElement('button');
    button.id = 'managePlaylists';
    button.className = 'text-button';
    button.type = 'button';
    button.textContent = 'Edit playlists';
    button.addEventListener('click', open);
    refresh.insertAdjacentElement('beforebegin', button);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
