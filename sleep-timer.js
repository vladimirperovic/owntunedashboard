(() => {
  'use strict';

  const cfg = Object.assign({ schedulerBase: '/scheduler' }, window.OWNTONE_DASHBOARD || {});
  const base = String(cfg.schedulerBase || '/scheduler').replace(/\/$/, '');
  const PRESETS = [15, 30, 45, 60, 90];
  let button;
  let popover;
  let statusEl;
  let pollTimer;

  function say(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._sleepTimer);
    el._sleepTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  async function api(path, options = {}) {
    const response = await fetch(`${base}${path}`, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  function renderStatus(status) {
    if (!statusEl || !button) return;
    if (status?.active && status.remaining_min > 0) {
      statusEl.textContent = `Sleeping — ${status.remaining_min} min left (fade in last 3)`;
      statusEl.classList.add('active');
      button.classList.add('has-timer');
      button.title = `Sleep timer: ${status.remaining_min} min left`;
    } else if (status?.active) {
      statusEl.textContent = 'Fading out…';
      statusEl.classList.add('active');
    } else {
      statusEl.textContent = 'Timer off';
      statusEl.classList.remove('active');
      button.classList.remove('has-timer');
      button.title = 'Sleep timer';
    }
  }

  async function refresh() {
    try { renderStatus(await api('/sleep', { cache: 'no-store' })); } catch (_) {}
  }

  async function set(minutes) {
    try {
      const result = await api('/sleep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      renderStatus(result);
      close();
      say(minutes > 0 ? `Sleep timer: ${minutes} min` : 'Sleep timer off');
    } catch (_) { say('Scheduler unavailable'); }
  }

  function close() { popover?.setAttribute('hidden', ''); }

  function mount() {
    if (button) return;
    const top = document.querySelector('.top-actions');
    if (!top) return;

    button = document.createElement('button');
    button.id = 'sleepButton';
    button.className = 'icon-button subtle sleep-button';
    button.type = 'button';
    button.title = 'Sleep timer';
    button.setAttribute('aria-label', 'Sleep timer');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
    const schedulerButton = document.getElementById('schedulerButton');
    top.insertBefore(button, schedulerButton || top.firstChild);

    popover = document.createElement('div');
    popover.id = 'sleepPopover';
    popover.className = 'sleep-popover';
    popover.hidden = true;
    popover.innerHTML = `
      <h4>Sleep timer</h4>
      <div class="sleep-options">${PRESETS.map(m => `<button type="button" data-min="${m}">${m}</button>`).join('')}<button type="button" data-min="0">Off</button></div>
      <div class="sleep-status" id="sleepStatus">Timer off</div>`;
    document.body.appendChild(popover);
    statusEl = popover.querySelector('#sleepStatus');

    popover.querySelectorAll('[data-min]').forEach(b => b.addEventListener('click', () => set(Number(b.dataset.min))));
    button.addEventListener('click', () => {
      const show = popover.hidden;
      popover.hidden = !show;
      if (show) refresh();
    });
    document.addEventListener('click', e => {
      if (!popover.hidden && !e.target.closest('#sleepPopover,#sleepButton')) close();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 60000);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
