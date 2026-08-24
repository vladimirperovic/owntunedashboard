(() => {
  'use strict';
  const cfg = Object.assign(
    { apiBase: '/api', nightSafeStartHour: 0, nightSafeEndHour: 8, nightSafeMaxVolume: 8 },
    window.OWNTONE_DASHBOARD || {}
  );
  const base = String(cfg.apiBase || '/api').replace(/\/$/, '');
  const isNight = () => {
    const now = new Date(),
      hour = now.getHours() + now.getMinutes() / 60;
    const start = Number(cfg.nightSafeStartHour ?? 0),
      end = Number(cfg.nightSafeEndHour ?? 8);
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  };
  document.addEventListener(
    'click',
    async event => {
      const row = event.target.closest?.('.history-row[data-uri]');
      if (!row || row.dataset.nightSafeReplay === '1' || !isNight()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const cap = Math.max(0, Math.min(100, Number(cfg.nightSafeMaxVolume ?? 8)));
      const output = document.getElementById('outputSelect')?.value || '';
      const params = new URLSearchParams({ volume: String(cap) });
      if (output) params.set('output_id', output);
      try {
        await fetch(`${base}/player/volume?${params}`, { method: 'PUT' });
      } catch (_) {}
      const range = document.getElementById('volumeRange'),
        label = document.getElementById('volumeValue');
      if (range) {
        range.value = String(cap);
        range.style.setProperty('--range-progress', `${cap}%`);
      }
      if (label) label.textContent = `${cap}%`;
      row.dataset.nightSafeReplay = '1';
      row.click();
      setTimeout(() => delete row.dataset.nightSafeReplay, 0);
    },
    true
  );
})();
