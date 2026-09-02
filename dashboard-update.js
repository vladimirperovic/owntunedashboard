(() => {
  'use strict';

  const { scheduler: api, toast: say } = window.OwnTone;
  let button;
  let statusEl;
  let pollTimer;
  let lastResultAt = '';

  function setBusy(busy, text = '') {
    if (!button) return;
    button.disabled = busy;
    button.querySelector('span').textContent = text || (busy ? 'Updating…' : 'Update dashboard');
  }

  function resultTimestamp(status) {
    return String(status?.result?.at || status?.result?.updated_at || '');
  }

  function render(status) {
    if (!button || !statusEl) return;
    button.hidden = false;
    const busy = Boolean(status?.pending || status?.running);
    setBusy(busy);

    if (busy) {
      statusEl.textContent = status.running ? 'Installing latest main…' : 'Update queued…';
      return;
    }

    const result = status?.result;
    if (result?.status === 'success') {
      const commit = String(result.commit || '').slice(0, 7);
      statusEl.textContent = commit ? `Installed ${commit}` : 'Update installed';
      const stamp = resultTimestamp(status);
      if (lastResultAt && stamp && stamp !== lastResultAt) {
        say('Dashboard updated — reloading');
        window.setTimeout(() => window.location.reload(), 1200);
      }
      lastResultAt = stamp || lastResultAt;
      return;
    }

    if (result?.status === 'error') {
      statusEl.textContent = String(result.message || 'Update failed').slice(0, 80);
      return;
    }

    const current = String(status?.current?.commit || '').slice(0, 7);
    statusEl.textContent = current ? `Current ${current}` : 'Install latest main';
  }

  async function refresh({ silent = true } = {}) {
    try {
      const status = await api('/update', { cache: 'no-store' });
      render(status);
      if (status?.pending || status?.running) {
        clearTimeout(pollTimer);
        pollTimer = window.setTimeout(() => refresh(), 1400);
      }
      return status;
    } catch (error) {
      if (button) button.hidden = true;
      if (!silent) say(error?.message || 'Updater unavailable');
      return null;
    }
  }

  async function requestUpdate() {
    if (!button || button.disabled) return;
    const ok = window.confirm('Install the latest dashboard from GitHub main?');
    if (!ok) return;

    setBusy(true);
    statusEl.textContent = 'Requesting update…';
    try {
      await api('/update', {
        method: 'POST',
        headers: { 'X-OwnTone-Update': '1' },
        body: {},
      });
      say('Dashboard update started');
      lastResultAt = resultTimestamp(await refresh()) || lastResultAt;
      clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => refresh(), 1400);
    } catch (error) {
      setBusy(false);
      statusEl.textContent = 'Update unavailable';
      say(error?.message || 'Update failed');
    }
  }

  function mount() {
    if (button) return;
    const footer = document.querySelector('.sidebar-foot');
    if (!footer) return;

    button = document.createElement('button');
    button.id = 'dashboardUpdateButton';
    button.className = 'dashboard-update-button';
    button.type = 'button';
    button.hidden = true;
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
      </svg>
      <span>Update dashboard</span>`;

    statusEl = document.createElement('div');
    statusEl.id = 'dashboardUpdateStatus';
    statusEl.className = 'dashboard-update-status';
    statusEl.setAttribute('aria-live', 'polite');

    footer.append(button, statusEl);
    button.addEventListener('click', requestUpdate);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
