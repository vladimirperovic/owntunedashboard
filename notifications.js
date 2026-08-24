(() => {
  'use strict';

  const cfg = Object.assign({ schedulerBase: '/scheduler' }, window.OWNTONE_DASHBOARD || {});
  const base = String(cfg.schedulerBase || '/scheduler').replace(/\/$/, '');
  const KEY = 'owntone-notify-enabled-v1';
  const SEEN_KEY = 'owntone-notify-last-seen';
  let button;
  let timer;

  const supported = typeof window.Notification !== 'undefined';

  function enabled() {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function setEnabled(value) {
    try {
      localStorage.setItem(KEY, value ? '1' : '0');
    } catch (_) {}
    render();
  }

  function render() {
    if (!button) return;
    const on = enabled();
    button.classList.toggle('on', on);
    button.title = on ? 'Notifications on' : 'Notifications off';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(on));
  }

  async function toggle() {
    if (!supported) {
      toast('Notifications are not supported in this browser');
      return;
    }
    if (enabled()) {
      setEnabled(false);
      toast('Notifications off');
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notification permission denied');
      setEnabled(false);
      return;
    }
    setEnabled(true);
    toast('Notifications on');
  }

  function notify(text) {
    if (!enabled() || !supported || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return; // tab is visible — the UI already shows activity
    try {
      new Notification('OwnTone Dashboard', { body: text, tag: 'owntone-activity', silent: false });
    } catch (_) {}
  }

  function lastSeen() {
    try {
      return localStorage.getItem(SEEN_KEY) || '';
    } catch (_) {
      return '';
    }
  }
  function markSeen(iso) {
    try {
      localStorage.setItem(SEEN_KEY, iso || new Date().toISOString());
    } catch (_) {}
  }

  function toast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._notifTimer);
    el._notifTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function poll() {
    if (!enabled()) return;
    try {
      const response = await fetch(`${base}/activity`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const items = data?.items || [];
      const seen = lastSeen();
      const fresh = items.filter(it => !seen || String(it.at) > seen);
      fresh
        .slice(0, 3)
        .reverse()
        .forEach(ev => {
          if (/^(schedule|sleep|error|station|playlist)/.test(ev.kind)) notify(ev.text);
        });
      markSeen(items[0]?.at || new Date().toISOString());
    } catch (_) {}
  }

  function mount() {
    if (button) return;
    const top = document.querySelector('.top-actions');
    if (!top) return;
    button = document.createElement('button');
    button.id = 'notifyButton';
    button.className = 'icon-button subtle notify-button';
    button.type = 'button';
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>';
    const schedulerButton = document.getElementById('schedulerButton');
    top.insertBefore(button, schedulerButton || top.firstChild);
    button.addEventListener('click', toggle);
    render();

    clearInterval(timer);
    timer = setInterval(poll, 45000);
    poll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
