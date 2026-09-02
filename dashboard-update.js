(() => {
  'use strict';

  const { toast: say } = window.OwnTone;
  let button;
  let statusEl;
  let pollTimer;
  let baselineResultAt = '';
  let updateRequested = false;

  async function updater(path, options = {}) {
    const response = await fetch(`/updater${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.clone().json())?.error || '';
      } catch (_) {}
      throw new Error(detail || `${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  function setBusy(busy, text = '') {
    if (!button) return;
    button.disabled = busy;
    button.querySelector('span').textContent = text || (busy ? 'Updating…' : 'Update dashboard');
  }

  function resultTimestamp(status) {
    return String(status?.result?.at || status?.result?.updated_at || '');
  }

  function scheduleRefresh(delay = 1400) {
    clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => refresh(), delay);
  }

  function render(status) {
    if (!button || !statusEl) return;
    button.hidden = false;
    const busy = Boolean(status?.pending || status?.running || updateRequested);
    setBusy(busy);

    if (status?.pending || status?.running) {
      statusEl.textContent = status.running ? 'Installing latest main…' : 'Update queued…';
      return;
    }

    const result = status?.result;
    const stamp = resultTimestamp(status);
    if (updateRequested && result?.status === 'success' && stamp && stamp !== baselineResultAt) {
      const commit = String(result.commit || '').slice(0, 7);
      statusEl.textContent = commit ? `Installed ${commit}` : 'Update installed';
      updateRequested = false;
      say('Dashboard updated — reloading');
      window.setTimeout(() => window.location.reload(), 1200);
      return;
    }

    if (updateRequested && result?.status === 'error' && stamp && stamp !== baselineResultAt) {
      updateRequested = false;
      setBusy(false);
      statusEl.textContent = String(result.message || 'Update failed').slice(0, 80);
      say('Dashboard update failed — previous version restored');
      return;
    }

    if (!updateRequested) baselineResultAt = stamp || baselineResultAt;
    const current = String(status?.current?.commit || '').slice(0, 7);
    statusEl.textContent = current ? `Current ${current}` : 'Install latest main';
  }

  async function refresh({ silent = true } = {}) {
    try {
      const status = await updater('/status');
      render(status);
      if (status?.pending || status?.running || updateRequested) scheduleRefresh();
      return status;
    } catch (error) {
      if (updateRequested) {
        button.hidden = false;
        setBusy(true, 'Updating…');
        statusEl.textContent = 'Restarting dashboard services…';
        scheduleRefresh(1800);
      } else if (button) {
        button.hidden = true;
      }
      if (!silent && !updateRequested) say(error?.message || 'Updater unavailable');
      return null;
    }
  }

  async function requestUpdate() {
    if (!button || button.disabled) return;
    const ok = window.confirm('Install the latest dashboard from GitHub main?');
    if (!ok) return;

    const before = await refresh();
    baselineResultAt = resultTimestamp(before) || baselineResultAt;
    updateRequested = true;
    setBusy(true);
    statusEl.textContent = 'Requesting update…';
    try {
      await updater('/request', {
        method: 'POST',
        headers: { 'X-OwnTone-Update': '1' },
      });
      say('Dashboard update started');
      scheduleRefresh(500);
    } catch (error) {
      updateRequested = false;
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
