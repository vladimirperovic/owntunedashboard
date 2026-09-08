(() => {
  'use strict';

  const { toast: say } = window.OwnTone;
  const DEFAULT_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
  const RETRY_CHECK_MS = 60 * 60 * 1000;
  let button;
  let statusEl;
  let pollTimer;
  let checkTimer;
  let baselineResultAt = '';
  let updateRequested = false;
  let updateAvailable = false;
  let latestCommit = '';
  let lastCheckAt = 0;
  let checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS;
  let installed = {};

  function installationLabel() {
    const date = new Date(installed.deployed_at || '');
    const dateLabel = Number.isNaN(date.getTime())
      ? 'Date unavailable'
      : `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
    const version = String(window.OWNTONE_DASHBOARD_VERSION || '');
    return version ? `${dateLabel} · v${version}` : dateLabel;
  }

  function setStatus(text = '') {
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

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
    button.querySelector('.dashboard-update-label').textContent =
      text || (busy ? 'Updating…' : updateAvailable ? 'Update available' : 'Last update');
    button.querySelector('small').textContent = installationLabel();
    button.title = busy
      ? 'Dashboard update in progress'
      : updateAvailable
        ? 'Install the available dashboard update'
        : 'Check GitHub for updates';
    document.dispatchEvent(new CustomEvent('owntone:updater'));
  }

  function setAvailability(available, latest = '') {
    updateAvailable = Boolean(available);
    latestCommit = String(latest || '');
    button?.classList.toggle('update-available', updateAvailable);
    if (button) button.dataset.updateAvailable = String(updateAvailable);
    if (!button?.disabled) setBusy(false);
  }

  function resultTimestamp(status) {
    return String(status?.result?.at || status?.result?.updated_at || '');
  }

  function scheduleRefresh(delay = 1400) {
    clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => refresh(), delay);
  }

  function scheduleCheck(delay = checkIntervalMs) {
    clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => checkForUpdate(), delay);
  }

  async function reloadFresh(commit = '') {
    try {
      if ('caches' in window) {
        const names = await window.caches.keys();
        await Promise.all(names.map(name => window.caches.delete(name)));
      }
    } catch (_) {}

    const url = new URL(window.location.href);
    url.searchParams.set('_updated', String(commit || Date.now()).slice(0, 12));
    window.location.replace(url.toString());
  }

  function render(status) {
    if (!button || !statusEl) return;
    button.hidden = false;
    installed = status?.current || installed;
    if ((status?.pending || status?.running) && !updateRequested) {
      baselineResultAt = resultTimestamp(status);
      updateRequested = true;
    }
    const busy = Boolean(status?.pending || status?.running || updateRequested);
    setBusy(busy);

    if (status?.pending || status?.running) {
      setStatus(status.running ? 'Installing update…' : 'Update queued…');
      return;
    }

    const result = status?.result;
    const stamp = resultTimestamp(status);
    if (updateRequested && result?.status === 'success' && stamp && stamp !== baselineResultAt) {
      setAvailability(false, result.commit || latestCommit);
      setStatus('Update installed — reloading…');
      updateRequested = false;
      say('Dashboard updated — reloading fresh files');
      window.setTimeout(() => reloadFresh(result.commit), 1200);
      return;
    }

    if (updateRequested && result?.status === 'error' && stamp && stamp !== baselineResultAt) {
      updateRequested = false;
      setBusy(false);
      setStatus(String(result.message || 'Update failed').slice(0, 80));
      say(String(result.message || 'Dashboard update failed — check update status'));
      scheduleCheck(RETRY_CHECK_MS);
      return;
    }

    if (!updateRequested) baselineResultAt = stamp || baselineResultAt;
    setStatus();
  }

  function renderCheck(value) {
    if (!button || !statusEl || updateRequested) return;
    installed = value?.current || installed;
    const latest = String(value?.latest?.commit || '');
    const seconds = Number(value?.check_interval_seconds || 0);
    if (Number.isFinite(seconds) && seconds >= 60) checkIntervalMs = seconds * 1000;
    setAvailability(Boolean(value?.update_available), latest);
    setStatus();
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
        setStatus('Restarting dashboard services…');
        scheduleRefresh(1800);
      } else if (button) {
        button.hidden = true;
        setStatus();
        document.dispatchEvent(new CustomEvent('owntone:updater'));
      }
      if (!silent && !updateRequested) say(error?.message || 'Updater unavailable');
      return null;
    }
  }

  async function checkForUpdate({ silent = true, force = false } = {}) {
    if (updateRequested) return null;
    if (force) setBusy(true, 'Checking…');
    try {
      const value = await updater(force ? '/check?force=1' : '/check');
      lastCheckAt = Date.now();
      if (force) setBusy(false);
      renderCheck(value);
      if (!silent && !updateAvailable) say('Dashboard is up to date');
      scheduleCheck();
      return value;
    } catch (error) {
      if (force) setBusy(false);
      scheduleCheck(RETRY_CHECK_MS);
      if (!silent) say(error?.message || 'Update check unavailable');
      return null;
    }
  }

  async function requestUpdate() {
    if (!button || button.disabled) return;
    if (!updateAvailable) {
      await checkForUpdate({ silent: false, force: true });
      return;
    }
    const ok = window.confirm('Install the latest dashboard from GitHub main?');
    if (!ok) return;

    updateRequested = true;
    clearTimeout(checkTimer);
    setBusy(true);
    setStatus('Requesting update…');
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
      setStatus('Update unavailable');
      say(error?.message || 'Update failed');
      scheduleCheck(RETRY_CHECK_MS);
    }
  }

  function cleanReloadMarker() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('_updated')) return;
    url.searchParams.delete('_updated');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function mount() {
    if (button) return;
    const footer = document.querySelector('.sidebar-foot');
    if (!footer) return;

    cleanReloadMarker();
    button = document.createElement('button');
    button.id = 'dashboardUpdateButton';
    button.className = 'dashboard-update-button';
    button.type = 'button';
    button.hidden = true;
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
      </svg>
      <span class="dashboard-update-copy"><span class="dashboard-update-label">Last update</span><small></small></span>`;

    statusEl = document.createElement('div');
    statusEl.id = 'dashboardUpdateStatus';
    statusEl.className = 'dashboard-update-status';
    statusEl.setAttribute('aria-live', 'polite');

    footer.append(button, statusEl);
    button.addEventListener('click', requestUpdate);
    refresh().then(status => {
      if (status) checkForUpdate();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastCheckAt >= checkIntervalMs) checkForUpdate();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
