(() => {
  'use strict';

  const { scheduler, escapeHtml, whenReady } = window.OwnTone;
  let section;
  let timer;

  function fmtDay(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
      return iso?.slice(5) || '';
    }
  }
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function barChart(days) {
    if (!days.length) return '<div class="browse-empty">Nothing played in this window yet.</div>';
    const max = Math.max(...days.map(d => d.count), 1);
    const last = days.slice(-21);
    return `<div class="stats-bars">${last
      .map(
        d => `
      <div class="stats-bar" style="--h:${Math.max(8, Math.round((d.count / max) * 100))}%" title="${escapeHtml(fmtDay(d.date))}: ${d.count}">
        <i></i><small>${escapeHtml(fmtDay(d.date).split(' ')[1] || '')}</small>
      </div>`
      )
      .join('')}</div>`;
  }

  function topList(items, emptyText) {
    if (!items?.length) return `<span class="browse-empty">${escapeHtml(emptyText)}</span>`;
    const max = items[0].count || 1;
    return `<ol class="stats-list">${items
      .map(
        it => `
      <li><span class="stats-name">${escapeHtml(it.name)}</span>
      <span class="stats-countbar" style="--w:${Math.round((it.count / max) * 100)}%"></span>
      <b>${it.count}</b></li>`
      )
      .join('')}</ol>`;
  }

  function activityFeed(items) {
    if (!items?.length) return '<span class="browse-empty">No recent activity.</span>';
    return `<ul class="activity-feed">${items
      .slice(0, 12)
      .map(
        ev => `
      <li><em>${escapeHtml(fmtTime(ev.at))}</em><span>${escapeHtml(ev.text)}</span></li>`
      )
      .join('')}</ul>`;
  }

  async function render() {
    if (!section || !window.OWNTONE_APP?.state?.online) return;
    try {
      const [stats, activity] = await Promise.all([
        scheduler('/stats?days=30').catch(() => null),
        scheduler('/activity').catch(() => null),
      ]);
      if (!stats && !activity) return;
      section.innerHTML = `
        <div class="section-heading-row compact-head"><div><span class="section-kicker">INSIGHTS</span><h2>Your last 30 days</h2></div>${stats ? `<div class="library-count">${stats.total_plays ?? 0} plays · ${stats.radio_plays ?? 0} radio</div>` : ''}</div>
        ${stats ? barChart(stats.days || []) : ''}
        <div class="stats-columns">
          <div><h3>Top stations</h3>${topList(stats?.top_stations, 'No radio plays yet.')}</div>
          <div><h3>Top artists</h3>${topList(stats?.top_artists, 'No local plays yet.')}</div>
        </div>
        <h3 class="activity-title">Activity</h3>
        ${activityFeed(activity?.items)}`;
    } catch (_) {}
  }

  function mount() {
    const anchor = document.getElementById('browseSection') || document.getElementById('playlistsSection');
    if (section || !anchor) return;
    section = document.createElement('section');
    section.id = 'insightsSection';
    section.className = 'browse-section';
    section.innerHTML =
      '<div class="premium-loading" style="color:var(--muted);font-size:11px">Loading insights…</div>';
    anchor.insertAdjacentElement('afterend', section);
    render();
    clearInterval(timer);
    timer = setInterval(render, 120000);
  }

  // Same as browse.js: wait for the ready event rather than polling for it.
  whenReady(({ detail }) => {
    if (detail?.demo) return;
    mount();
  });
})();
