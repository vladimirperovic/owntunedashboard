(() => {
  'use strict';

  const cfg = Object.assign({ apiBase: '/api' }, window.OWNTONE_DASHBOARD || {});
  const base = String(cfg.apiBase || '/api').replace(/\/$/, '');
  const escapeHtml = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  let mounted = false;

  async function api(path) {
    const response = await fetch(`${base}${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  }

  function playExpression(expression, label) {
    const appInstance = window.OWNTONE_APP;
    if (appInstance?.playExpression) return appInstance.playExpression(expression, label);
    return Promise.resolve();
  }

  const quote = value => String(value || '').replace(/"/g, '\\"');
  const exprFor = (field, value) =>
    `media_kind is music AND data_kind is file AND ${field} is "${quote(value)}"`;

  function cleanName(value) {
    // OwnTone tags sometimes contain invalid UTF-8 rendered as ### runs
    return (
      String(value || '')
        .replace(/#{2,}/g, '')
        .replace(/#{1,}$/, '')
        .trim() || value
    );
  }

  function chipRow(title, items, field, emptyText, limit = 0) {
    const section = document.createElement('div');
    section.className = 'browse-section';
    section.innerHTML = `<div class="section-heading-row compact-head"><div><span class="section-kicker">BROWSE</span><h2>${escapeHtml(title)}</h2></div></div>`;
    const row = document.createElement('div');
    row.className = 'chip-row';
    if (!items.length) {
      row.innerHTML = `<span class="browse-empty">${escapeHtml(emptyText)}</span>`;
    } else {
      let expanded = false;
      const render = () => {
        row.innerHTML = '';
        const shown = expanded || !limit ? items : items.slice(0, limit);
        shown.forEach(item => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = cleanName(item);
          btn.title = `Play ${cleanName(item)}`;
          btn.addEventListener('click', () =>
            playExpression(exprFor(field, item), `${title}: ${cleanName(item)}`)
          );
          row.appendChild(btn);
        });
        if (limit && items.length > limit && !expanded) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'chip-more';
          more.textContent = `Show all ${items.length}`;
          more.addEventListener('click', () => {
            expanded = true;
            render();
          });
          row.appendChild(more);
        }
      };
      render();
    }
    section.appendChild(row);
    return section;
  }

  async function load() {
    const target = document.getElementById('playlistsSection');
    if (!target || !window.OWNTONE_APP?.state?.online) return;
    try {
      const genres = await api('/library/genres').catch(() => null);
      const artists = await api('/library/artists?limit=200').catch(() => null);
      const genreNames = (genres?.items || [])
        .map(g => g.name)
        .filter(Boolean)
        .slice(0, 40)
        .sort((a, b) => a.localeCompare(b));
      const artistNames = (artists?.items || [])
        .map(a => a.name)
        .filter(n => n && n !== 'Unknown artist')
        .slice(0, 120)
        .sort((a, b) => a.localeCompare(b));
      const wrap = document.createElement('div');
      wrap.id = 'browseSection';
      wrap.appendChild(chipRow('Genres', genreNames, 'genre', 'No genres in the library yet.', 24));
      wrap.appendChild(chipRow('Artists', artistNames, 'artist', 'No artists in the library yet.', 30));
      target.insertAdjacentElement('afterend', wrap);
      mounted = true;
    } catch (_) {
      /* library unavailable — stay hidden */
    }
  }

  function mount() {
    if (mounted) return;
    // wait for first successful library refresh so sections only appear when online
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (mounted) {
        clearInterval(timer);
        return;
      }
      if (document.getElementById('playlistsSection') && window.OWNTONE_APP?.state?.online) {
        clearInterval(timer);
        load();
      } else if (tries > 40) clearInterval(timer);
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
