(() => {
  'use strict';

  const cfg = Object.assign({apiBase:'/api', schedulerBase:'/scheduler'}, window.OWNTONE_DASHBOARD || {});
  const schedulerBase = String(cfg.schedulerBase || '/scheduler').replace(/\/$/, '');
  const apiBase = String(cfg.apiBase || '/api').replace(/\/$/, '');
  const DAYS = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];
  const radioMatcher = p => String(p.path || '').toLowerCase().includes(String(cfg.radioPathHint || '/Radio/').toLowerCase()) || /(^|\s)(radio|naxi|s1|202|lola)(\s|$)/i.test(p.name || '');
  let dialog, list, form, schedules=[], playlists=[], outputs=[], editingId=null;

  const clockIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>';
  const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>';

  async function jsonRequest(base, path, options={}) {
    const response = await fetch(`${base}${path}`, options);
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error || ''; } catch (_) {}
      throw new Error(detail || `${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  const sched = (path, options={}) => jsonRequest(schedulerBase, path, options);
  const api = (path, options={}) => jsonRequest(apiBase, path, options);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const dayLabel = days => {
    const key = [...days].sort().join(',');
    if (key === ['fri','mon','thu','tue','wed'].sort().join(',')) return 'Weekdays';
    if (key === ['sat','sun'].sort().join(',')) return 'Weekend';
    if (days.length === 7) return 'Every day';
    return DAYS.filter(([id]) => days.includes(id)).map(([,label]) => label).join(' · ');
  };

  function mount() {
    if (document.getElementById('scheduleButton')) return;
    const topActions = document.querySelector('.top-actions');
    if (topActions) {
      const button = document.createElement('button');
      button.id = 'scheduleButton';
      button.type = 'button';
      button.className = 'icon-button schedule-button';
      button.title = 'Schedule';
      button.setAttribute('aria-label','Schedule');
      button.innerHTML = clockIcon;
      topActions.insertBefore(button, topActions.firstChild);
      button.addEventListener('click', openScheduler);
    }

    const nav = document.querySelector('.side-nav');
    const quick = [...document.querySelectorAll('.nav-label')].find(x => /quick access/i.test(x.textContent || ''));
    if (nav && quick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'side-link';
      button.innerHTML = `<span>${clockIcon}</span>Schedule`;
      button.addEventListener('click', openScheduler);
      quick.insertAdjacentElement('beforebegin', button);
    }

    dialog = document.createElement('dialog');
    dialog.className = 'schedule-dialog';
    dialog.id = 'scheduleDialog';
    dialog.innerHTML = `
      <div class="schedule-panel">
        <header class="schedule-head">
          <div><span class="section-kicker">AUTOMATION</span><h2>Schedule</h2><p>Play radio or playlists automatically, even when this dashboard is closed.</p></div>
          <button type="button" class="schedule-close" aria-label="Close">×</button>
        </header>
        <div class="schedule-layout">
          <section class="schedule-list-pane">
            <div class="schedule-summary" id="scheduleSummary"><span>Next</span><b>—</b><small>No schedules yet</small></div>
            <div class="schedule-list" id="scheduleList"></div>
          </section>
          <section class="schedule-editor-pane">
            <form id="scheduleForm" class="schedule-form">
              <div class="schedule-form-title"><div><span class="section-kicker">RULE</span><h3 id="scheduleFormHeading">New schedule</h3></div><button type="button" class="schedule-reset" id="scheduleReset">New</button></div>
              <label class="schedule-field"><span>Name</span><input id="scheduleName" type="text" placeholder="Morning music" maxlength="120"></label>
              <div class="schedule-two">
                <label class="schedule-field"><span>Start time</span><input id="scheduleTime" type="time" value="09:00" required></label>
                <label class="schedule-field"><span>Stop time <em>optional</em></span><input id="scheduleStop" type="time"></label>
              </div>
              <div class="schedule-field"><span>Days</span><div class="schedule-days" id="scheduleDays">${DAYS.map(([id,label]) => `<button type="button" data-day="${id}">${label}</button>`).join('')}</div></div>
              <div class="schedule-field"><span>Type</span><div class="schedule-kind" id="scheduleKind"><button type="button" class="active" data-kind="playlist">Playlist</button><button type="button" data-kind="radio">Radio</button></div></div>
              <label class="schedule-field"><span>What to play</span><select id="scheduleSource" required></select></label>
              <label class="schedule-field"><span>Output</span><select id="scheduleOutput" required></select></label>
              <div class="schedule-field"><span>Volume <b id="scheduleVolumeValue">10%</b></span><input id="scheduleVolume" type="range" min="0" max="100" value="10"></div>
              <div class="schedule-field"><span>Raise to <em>optional</em></span><div class="schedule-two"><label class="schedule-field"><span>after <b>min</b></span><input id="scheduleRampMinutes" type="number" min="0" max="1440" step="5" value="0"></label><label class="schedule-field"><span>to <b>%</b></span><input id="scheduleRampVolume" type="number" min="0" max="100" step="1" value="0"></label></div></div>
              <label class="schedule-field" id="scheduleFallbackField"><span>Fallback station <em>if stream is dead</em></span><select id="scheduleFallback"></select></label>
              <div class="schedule-toggles">
                <label><input id="scheduleShuffle" type="checkbox" checked><span>Shuffle</span></label>
                <label><input id="scheduleNightCap" type="checkbox"><span>Night cap 00–08</span></label>
                <label><input id="scheduleEnabled" type="checkbox" checked><span>Enabled</span></label>
              </div>
              <div class="schedule-form-actions"><button type="button" class="schedule-delete" id="scheduleDelete" hidden>Delete</button><button type="submit" class="schedule-save">Save schedule</button></div>
              <div class="schedule-message" id="scheduleMessage"></div>
            </form>
          </section>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    list = dialog.querySelector('#scheduleList');
    form = dialog.querySelector('#scheduleForm');
    dialog.querySelector('.schedule-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.querySelector('#scheduleReset').addEventListener('click', resetForm);
    dialog.querySelector('#scheduleDelete').addEventListener('click', deleteCurrent);
    dialog.querySelector('#scheduleVolume').addEventListener('input', event => dialog.querySelector('#scheduleVolumeValue').textContent = `${event.target.value}%`);
    dialog.querySelector('#scheduleKind').addEventListener('click', event => {
      const button = event.target.closest('[data-kind]'); if (!button) return;
      dialog.querySelectorAll('#scheduleKind button').forEach(x => x.classList.toggle('active', x === button));
      populateSources(button.dataset.kind);
      populateFallbacks();
      dialog.querySelector('#scheduleShuffle').checked = button.dataset.kind === 'playlist';
    });
    dialog.querySelector('#scheduleDays').addEventListener('click', event => {
      const button = event.target.closest('[data-day]'); if (button) button.classList.toggle('active');
    });
    form.addEventListener('submit', saveForm);
  }

  async function openScheduler() {
    mount();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open','');
    setMessage('Loading…');
    try {
      const [scheduleData, playlistData, outputData] = await Promise.all([
        sched('/schedules'), api('/library/playlists?limit=500'), api('/outputs')
      ]);
      schedules = scheduleData?.items || [];
      playlists = playlistData?.items || [];
      outputs = outputData?.outputs || [];
      populateOutputs();
      renderSchedules();
      if (!editingId) resetForm(); else editSchedule(editingId);
      setMessage('');
    } catch (error) {
      setMessage(`Scheduler unavailable: ${error.message}`, true);
    }
  }

  function populateOutputs(selected='') {
    const select = dialog.querySelector('#scheduleOutput');
    const preferred = outputs.find(o => String(o.name || '').toLowerCase().includes(String(cfg.preferredOutput || 'HomePod').toLowerCase()));
    const wanted = selected || preferred?.id || outputs[0]?.id || '';
    select.innerHTML = outputs.length ? outputs.map(o => `<option value="${escapeHtml(o.id)}" ${String(o.id)===String(wanted)?'selected':''}>${escapeHtml(o.name)} · ${escapeHtml(o.type)}</option>`).join('') : '<option value="">No output</option>';
  }

  function populateSources(kind='playlist', selected='') {
    const select = dialog.querySelector('#scheduleSource');
    const pool = playlists.filter(p => kind === 'radio' ? radioMatcher(p) : !radioMatcher(p) && !p.folder);
    select.innerHTML = pool.length ? pool.map(p => `<option value="${escapeHtml(p.uri)}" data-name="${escapeHtml(p.name)}" ${p.uri===selected?'selected':''}>${escapeHtml(p.name)}</option>`).join('') : `<option value="">No ${kind}s found</option>`;
  }

  function populateFallbacks(selected='') {
    const select = dialog.querySelector('#scheduleFallback');
    const kind = dialog.querySelector('#scheduleKind button.active')?.dataset.kind || 'playlist';
    const source = dialog.querySelector('#scheduleSource').value;
    const pool = playlists.filter(p => radioMatcher(p) && p.uri !== source);
    select.innerHTML = `<option value="">None</option>${pool.map(p => `<option value="${escapeHtml(p.uri)}" data-name="${escapeHtml(p.name)}" ${p.uri===selected?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}`;
    dialog.querySelector('#scheduleFallbackField').hidden = kind !== 'radio';
  }

  function resetForm() {
    editingId = null;
    dialog.querySelector('#scheduleFormHeading').textContent = 'New schedule';
    dialog.querySelector('#scheduleName').value = '';
    dialog.querySelector('#scheduleTime').value = '09:00';
    dialog.querySelector('#scheduleStop').value = '';
    dialog.querySelectorAll('#scheduleDays button').forEach(button => button.classList.toggle('active',['mon','tue','wed','thu','fri'].includes(button.dataset.day)));
    dialog.querySelectorAll('#scheduleKind button').forEach(button => button.classList.toggle('active',button.dataset.kind==='playlist'));
    populateSources('playlist');
    populateFallbacks();
    populateOutputs();
    dialog.querySelector('#scheduleVolume').value = 10;
    dialog.querySelector('#scheduleVolumeValue').textContent = '10%';
    dialog.querySelector('#scheduleRampMinutes').value = 0;
    dialog.querySelector('#scheduleRampVolume').value = 0;
    dialog.querySelector('#scheduleShuffle').checked = true;
    dialog.querySelector('#scheduleNightCap').checked = false;
    dialog.querySelector('#scheduleEnabled').checked = true;
    dialog.querySelector('#scheduleDelete').hidden = true;
    setMessage('');
  }

  function editSchedule(id) {
    const item = schedules.find(x => String(x.id) === String(id));
    if (!item) return;
    editingId = item.id;
    dialog.querySelector('#scheduleFormHeading').textContent = 'Edit schedule';
    dialog.querySelector('#scheduleName').value = item.name || '';
    dialog.querySelector('#scheduleTime').value = item.time || '09:00';
    dialog.querySelector('#scheduleStop').value = item.stop_time || '';
    dialog.querySelectorAll('#scheduleDays button').forEach(button => button.classList.toggle('active',(item.days || []).includes(button.dataset.day)));
    dialog.querySelectorAll('#scheduleKind button').forEach(button => button.classList.toggle('active',button.dataset.kind===item.kind));
    populateSources(item.kind, item.source_uri);
    populateFallbacks(item.fallback_uri || '');
    populateOutputs(item.output_id);
    dialog.querySelector('#scheduleVolume').value = item.volume ?? 55;
    dialog.querySelector('#scheduleVolumeValue').textContent = `${item.volume ?? 55}%`;
    dialog.querySelector('#scheduleRampMinutes').value = item.ramp_minutes ?? 0;
    dialog.querySelector('#scheduleRampVolume').value = item.ramp_volume ?? 0;
    dialog.querySelector('#scheduleShuffle').checked = !!item.shuffle;
    dialog.querySelector('#scheduleNightCap').checked = !!item.respect_night_cap;
    dialog.querySelector('#scheduleEnabled').checked = item.enabled !== false;
    dialog.querySelector('#scheduleDelete').hidden = false;
    setMessage('');
  }

  function formData() {
    const kind = dialog.querySelector('#scheduleKind button.active')?.dataset.kind || 'playlist';
    const source = dialog.querySelector('#scheduleSource');
    const option = source.options[source.selectedIndex];
    const fallback = dialog.querySelector('#scheduleFallback');
    const fallbackOption = fallback.options[fallback.selectedIndex];
    const output = dialog.querySelector('#scheduleOutput');
    const outputOption = output.options[output.selectedIndex];
    return {
      name: dialog.querySelector('#scheduleName').value.trim(),
      time: dialog.querySelector('#scheduleTime').value,
      stop_time: dialog.querySelector('#scheduleStop').value,
      days: [...dialog.querySelectorAll('#scheduleDays button.active')].map(x => x.dataset.day),
      kind,
      source_uri: source.value,
      source_name: option?.dataset.name || option?.textContent || '',
      fallback_uri: kind === 'radio' ? (fallback.value || '') : '',
      fallback_name: kind === 'radio' ? (fallback.value ? (fallbackOption?.dataset.name || '') : '') : '',
      respect_night_cap: dialog.querySelector('#scheduleNightCap').checked,
      output_id: output.value,
      output_name: (outputOption?.textContent || '').split(' · ')[0],
      volume: Number(dialog.querySelector('#scheduleVolume').value),
      ramp_minutes: Math.max(0, Number(dialog.querySelector('#scheduleRampMinutes').value) || 0),
      ramp_volume: Math.max(0, Number(dialog.querySelector('#scheduleRampVolume').value) || 0),
      shuffle: dialog.querySelector('#scheduleShuffle').checked,
      enabled: dialog.querySelector('#scheduleEnabled').checked,
    };
  }

  async function saveForm(event) {
    event.preventDefault();
    const data = formData();
    if (!data.days.length) return setMessage('Select at least one day.', true);
    if (!data.source_uri || !data.output_id) return setMessage('Choose a source and output.', true);
    setMessage('Saving…');
    try {
      const path = editingId ? `/schedules/${encodeURIComponent(editingId)}` : '/schedules';
      const method = editingId ? 'PUT' : 'POST';
      await sched(path, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
      const refreshed = await sched('/schedules');
      schedules = refreshed?.items || [];
      renderSchedules();
      resetForm();
      setMessage('Saved.');
    } catch (error) { setMessage(error.message, true); }
  }

  async function deleteCurrent() {
    if (!editingId) return;
    setMessage('Deleting…');
    try {
      await sched(`/schedules/${encodeURIComponent(editingId)}`, {method:'DELETE'});
      schedules = schedules.filter(x => String(x.id) !== String(editingId));
      renderSchedules();
      resetForm();
    } catch (error) { setMessage(error.message, true); }
  }

  async function runNow(id, button) {
    button.disabled = true;
    try { await sched(`/schedules/${encodeURIComponent(id)}/run`, {method:'POST'}); button.textContent = 'Playing'; setTimeout(() => button.textContent='Play now',1300); }
    catch (error) { setMessage(`Play now failed: ${error.message}`, true); }
    finally { setTimeout(() => button.disabled=false,500); }
  }

  async function toggleEnabled(id, enabled) {
    const item = schedules.find(x => String(x.id) === String(id)); if (!item) return;
    try {
      await sched(`/schedules/${encodeURIComponent(id)}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...item,enabled})});
      item.enabled = enabled;
      renderSchedules();
    } catch (error) { setMessage(error.message, true); }
  }

  function renderSchedules() {
    const enabled = schedules.filter(x => x.enabled && x.next_run).sort((a,b) => String(a.next_run).localeCompare(String(b.next_run)));
    const next = enabled[0];
    const summary = dialog.querySelector('#scheduleSummary');
    if (next) {
      const date = new Date(next.next_run);
      summary.innerHTML = `<span>NEXT</span><b>${date.toLocaleDateString(undefined,{weekday:'short'})} ${date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</b><small>${escapeHtml(next.source_name)} · ${escapeHtml(next.output_name)} · ${next.volume}%${next.ramp_minutes && next.ramp_volume?` → ${next.ramp_volume}% after ${next.ramp_minutes} min`:''}</small>`;
    } else summary.innerHTML = '<span>NEXT</span><b>—</b><small>No enabled schedules</small>';

    list.innerHTML = schedules.length ? schedules.map(item => `
      <article class="schedule-card ${item.enabled?'':'disabled'}" data-id="${escapeHtml(item.id)}">
        <button type="button" class="schedule-card-main" data-edit="${escapeHtml(item.id)}">
          <span class="schedule-time">${escapeHtml(item.time)}</span>
          <span class="schedule-card-copy"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(dayLabel(item.days || []))} · ${escapeHtml(item.source_name)}</small><em>${escapeHtml(item.output_name)} · ${item.volume}%${item.ramp_minutes && item.ramp_volume?` → ${item.ramp_volume}% after ${item.ramp_minutes} min`:''}${item.stop_time?` · stop ${escapeHtml(item.stop_time)}`:''}</em></span>
        </button>
        <div class="schedule-card-actions"><button type="button" class="schedule-run" data-run="${escapeHtml(item.id)}">Play now</button><label class="schedule-switch"><input type="checkbox" data-toggle="${escapeHtml(item.id)}" ${item.enabled?'checked':''}><span></span></label></div>
      </article>`).join('') : '<div class="schedule-empty"><b>No schedules yet</b><span>Create your first rule on the right.</span></div>';

    list.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => editSchedule(button.dataset.edit)));
    list.querySelectorAll('[data-run]').forEach(button => button.addEventListener('click', event => runNow(button.dataset.run, event.currentTarget)));
    list.querySelectorAll('[data-toggle]').forEach(input => input.addEventListener('change', () => toggleEnabled(input.dataset.toggle, input.checked)));
  }

  function setMessage(text, error=false) {
    const el = dialog?.querySelector('#scheduleMessage'); if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!error);
  }

  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();
})();
