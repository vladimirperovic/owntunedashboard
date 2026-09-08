(() => {
  'use strict';

  const { api: requestJson, escapeHtml, toast, icons: shared, outputLabel: labelFor } = window.OwnTone;

  const $ = id => document.getElementById(id);
  const app = () => window.OWNTONE_APP || null;
  const state = () => app()?.state || {};
  const normalize = value =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const icons = {
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
    play: shared.play,
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l9 6-9 6V6ZM18 5v14"/></svg>',
    queue:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10M7 12h10M7 17h6"/><path d="M17 15v5M14.5 17.5h5"/></svg>',
    last: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h10M5 12h10M5 17h7"/><path d="M17 15v5M14.5 17.5h5"/></svg>',
    album:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.3"/></svg>',
    artist:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c.8-4 3-6 6.5-6s5.7 2 6.5 6"/></svg>',
    output: shared.output,
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>',
    close: shared.close,
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h12l2 2v14H5zM8 4v6h8V4M8 20v-6h8v6"/></svg>',
    trash: shared.trash,
    speakers:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="7" height="14" rx="2"/><circle cx="6.5" cy="14" r="2"/><rect x="14" y="5" width="7" height="14" rx="2"/><circle cx="17.5" cy="14" r="2"/></svg>',
  };

  let contextMenu;
  let multiroomSheet;
  let currentContext = null;
  let lastAlbumContext = null;
  let exactTrackRewrite = false;
  let exactTrackTimer = null;
  let changingOutputs = false;
  const pairingOutputs = new Set();

  function updateOutputControls() {
    multiroomSheet
      ?.querySelectorAll('.multiroom-toggle, #multiroomAll, [data-scene-apply], .multiroom-auth button')
      .forEach(button => (button.disabled = changingOutputs));
  }

  async function changeOutputs(action) {
    if (changingOutputs) return;
    changingOutputs = true;
    updateOutputControls();
    try {
      await action();
    } catch (error) {
      toast(`Output change failed: ${error.message}`);
    } finally {
      changingOutputs = false;
      updateOutputControls();
    }
  }
  const SCENES_KEY = 'owntone-output-scenes-v1';
  const BROWSER_OUTPUT_ID = 'browser';

  function isDemo() {
    return !!state().demo;
  }
  function browserController() {
    return window.OWNTONE_BROWSER_OUTPUT || null;
  }
  function browserOutput() {
    return (
      browserController()?.getState?.() || {
        id: BROWSER_OUTPUT_ID,
        name: 'This browser',
        type: 'Browser',
        format: 'mp3',
        volume: 50,
        selected: false,
        active: false,
      }
    );
  }
  function physicalOutputs() {
    return state().outputs || [];
  }
  function selectedOutputs() {
    return allOutputs().filter(output => output.selected);
  }
  function selectedPhysicalOutputs() {
    return physicalOutputs().filter(output => output.selected);
  }
  function allOutputs() {
    return [...physicalOutputs(), browserOutput()];
  }
  function needsOutputAuth(output) {
    return !!(output?.requires_auth || output?.needs_auth_key || output?.has_password);
  }
  // Shared with app.js, which writes the same hero label on every poll.
  function outputLabel() {
    return labelFor(allOutputs());
  }

  async function setPhysicalOutputs(ids) {
    await app().selectPhysicalOutputs(ids);
    return true;
  }

  async function enableBrowserOutput() {
    const controller = browserController();
    if (!controller?.start) {
      toast('Browser output is unavailable');
      return false;
    }
    if (browserOutput().active) return true;
    const volume = selectedPhysicalOutputs()[0]?.volume ?? state().player?.volume ?? 50;
    try {
      await controller.start(volume);
      syncGroupLabel();
      renderMultiroomSheet();
      toast('Playing in this browser — now in sync with AirPlay');
      return true;
    } catch (error) {
      controller.stop?.();
      syncGroupLabel();
      renderMultiroomSheet();
      toast(`Browser playback failed: ${error.message || 'stream unavailable'}`);
      return false;
    }
  }

  async function disableBrowserOutput() {
    const controller = browserController();
    try {
      controller?.stop?.();
      syncGroupLabel();
      renderMultiroomSheet();
      return true;
    } catch (error) {
      toast(`Output change failed: ${error.message}`);
      return false;
    }
  }

  function syncLegacyOutputSelect() {
    const select = $('outputSelect');
    const selected = selectedOutputs();
    if (!select || !selected.length) return;
    const primary = selected[0];
    if ([...select.options].some(option => String(option.value) === String(primary.id))) {
      select.value = String(primary.id);
    }
  }

  function syncGroupLabel() {
    if (document.hidden) return;
    const label = outputLabel();
    const button = $('premiumOutputButton');
    const b = button?.querySelector('b');
    if (b && b.textContent !== label) b.textContent = label;
    const hero = $('outputName');
    if (hero && hero.textContent !== label) hero.textContent = label;
    const full = $('fullscreenOutputName');
    if (full && full.textContent !== label) full.textContent = label;
    syncLegacyOutputSelect();
  }

  function readScenes() {
    try {
      const scenes = JSON.parse(localStorage.getItem(SCENES_KEY) || '[]');
      return Array.isArray(scenes)
        ? scenes.filter(
            scene =>
              scene &&
              typeof scene.id === 'string' &&
              typeof scene.name === 'string' &&
              Array.isArray(scene.outputs) &&
              scene.outputs.every(output => output && output.id != null)
          )
        : [];
    } catch (_) {
      return [];
    }
  }
  function writeScenes(scenes) {
    try {
      localStorage.setItem(SCENES_KEY, JSON.stringify(scenes.slice(0, 12)));
    } catch (_) {}
  }

  async function setEnabledOutputs(ids) {
    const unique = [...new Set(ids.map(String))];
    const wantBrowser = unique.includes(BROWSER_OUTPUT_ID);
    const wantPhysical = unique.filter(id => id !== BROWSER_OUTPUT_ID);
    const browserActive = browserOutput().active;

    if (!wantPhysical.length && !wantBrowser) {
      toast('Keep at least one output active');
      return false;
    }

    const locked = physicalOutputs().filter(
      output => wantPhysical.includes(String(output.id)) && !output.selected && needsOutputAuth(output)
    );
    if (locked.length) {
      locked.forEach(output => {
        pairingOutputs.add(String(output.id));
      });
      renderMultiroomSheet();
      toast(`Enter the AirPlay code for ${locked[0].name || 'this output'}`);
      return false;
    }
    // Browser is independent — toggle it without touching AirPlay
    if (wantBrowser && !browserActive) {
      if (!(await enableBrowserOutput())) return false;
    } else if (!wantBrowser && browserActive) {
      if (!(await disableBrowserOutput())) return false;
    }

    try {
      await setPhysicalOutputs(wantPhysical);
      syncGroupLabel();
      return true;
    } catch (error) {
      toast(`Output change failed: ${error.message}`);
      return false;
    }
  }

  async function beginOutputPairing(output) {
    if (!output) return;
    pairingOutputs.add(String(output.id));
    renderMultiroomSheet();
    try {
      await requestJson(`/outputs/${encodeURIComponent(output.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: true }),
      });
      await app()?.refreshPlayback?.();
      const connected = allOutputs().find(item => String(item.id) === String(output.id));
      if (connected?.selected) {
        syncGroupLabel();
        renderMultiroomSheet();
        toast(`${connected.name || 'Output'} connected`);
        return;
      }
    } catch (_) {
      // Selecting the output failed, which is how OwnTone reports that the
      // device wants a pairing code. Fall through to the code prompt.
    }
    toast(`Enter the code shown on ${output.name || 'your AirPlay device'}`);
    document.querySelector(`[data-mr-output="${CSS.escape(String(output.id))}"] .multiroom-pin`)?.focus();
  }

  async function authorizeOutput(output, pin, button) {
    const code = String(pin || '').trim();
    if (!/^\d{4,8}$/.test(code)) {
      toast('Enter the 4–8 digit AirPlay code');
      return false;
    }
    button?.setAttribute('disabled', '');
    if (button) button.textContent = 'Connecting…';
    try {
      await requestJson(`/outputs/${encodeURIComponent(output.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: true, pin: code }),
      });
      await app()?.refreshPlayback?.();
      const connected = allOutputs().find(item => String(item.id) === String(output.id));
      if (!connected?.selected) throw new Error('OwnTone did not confirm the connection');
      syncGroupLabel();
      renderMultiroomSheet();
      toast(`${connected.name || 'Output'} connected`);
      return true;
    } catch (error) {
      toast(`Pairing failed — check the code (${error.message})`);
      button?.removeAttribute('disabled');
      if (button) button.textContent = 'Connect';
      return false;
    }
  }

  async function setOutputVolume(id, value, { quiet = false } = {}) {
    const volume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (String(id) === BROWSER_OUTPUT_ID) {
      browserController()?.setVolume?.(volume);
      syncGroupLabel();
      return true;
    }
    try {
      await app().setPhysicalOutputVolume(id, volume);
      return true;
    } catch (error) {
      if (!quiet) toast(`Volume failed: ${error.message}`);
      return false;
    }
  }

  async function applyScene(scene) {
    const outputs = allOutputs();
    const matched = (scene.outputs || [])
      .map(
        saved =>
          outputs.find(output => String(output.id) === String(saved.id)) ||
          outputs.find(output => normalize(output.name) === normalize(saved.name))
      )
      .filter(Boolean);
    if (!matched.length) {
      toast('No matching outputs for this scene');
      return;
    }
    const ids = matched.map(output => String(output.id));
    const enabled = await setEnabledOutputs(ids);
    if (!enabled) return;
    const volumes = await Promise.all(
      matched.map(output => {
        const saved =
          scene.outputs.find(item => String(item.id) === String(output.id)) ||
          scene.outputs.find(item => normalize(item.name) === normalize(output.name));
        return setOutputVolume(output.id, saved?.volume ?? output.volume ?? 20, { quiet: true });
      })
    );
    syncGroupLabel();
    renderMultiroomSheet();
    toast(
      volumes.every(Boolean) ? `${scene.name} scene applied` : `${scene.name}: some volumes could not be set`
    );
  }

  function saveCurrentScene() {
    const input = $('multiroomSceneName');
    const name = String(input?.value || '').trim();
    if (!name) {
      input?.focus();
      toast('Name the scene first');
      return;
    }
    const selected = selectedOutputs();
    if (!selected.length) {
      toast('Select at least one output');
      return;
    }
    const scenes = readScenes();
    const scene = {
      id: `scene-${Date.now()}`,
      name: name.slice(0, 40),
      outputs: selected.map(output => ({
        id: String(output.id),
        name: output.name,
        volume: Number(output.volume ?? 20),
      })),
    };
    const existing = scenes.findIndex(item => normalize(item.name) === normalize(scene.name));
    if (existing >= 0) scenes.splice(existing, 1, scene);
    else scenes.unshift(scene);
    writeScenes(scenes);
    if (input) input.value = '';
    renderMultiroomSheet();
    toast(`${scene.name} saved`);
  }

  function deleteScene(id) {
    writeScenes(readScenes().filter(scene => scene.id !== id));
    renderMultiroomSheet();
  }

  function ensureMultiroomSheet() {
    if (multiroomSheet) return multiroomSheet;
    multiroomSheet = document.createElement('aside');
    multiroomSheet.id = 'multiroomSheet';
    multiroomSheet.className = 'multiroom-sheet';
    multiroomSheet.setAttribute('aria-hidden', 'true');
    multiroomSheet.innerHTML =
      '<div class="multiroom-backdrop" data-mr-close></div><section class="multiroom-panel" role="dialog" aria-modal="true" aria-label="Multi-room AirPlay outputs"><header class="multiroom-head"><div><span class="section-kicker">AIRPLAY</span><h2>Multi-room</h2><p>Select rooms and tune each speaker independently.</p></div><button type="button" class="multiroom-close" aria-label="Close">' +
      icons.close +
      '</button></header><div id="multiroomBody" class="multiroom-body"></div></section>';
    document.body.appendChild(multiroomSheet);
    multiroomSheet.querySelector('[data-mr-close]').addEventListener('click', closeMultiroomSheet);
    multiroomSheet.querySelector('.multiroom-close').addEventListener('click', closeMultiroomSheet);
    return multiroomSheet;
  }

  function openMultiroomSheet() {
    ensureMultiroomSheet();
    renderMultiroomSheet();
    multiroomSheet.classList.add('open');
    multiroomSheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('multiroom-open');
  }
  function closeMultiroomSheet() {
    multiroomSheet?.classList.remove('open');
    multiroomSheet?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('multiroom-open');
  }

  function renderMultiroomSheet() {
    if (!multiroomSheet) return;
    const outputs = allOutputs();
    const scenes = readScenes();
    const selectedCount = outputs.filter(output => output.selected).length;
    const rows = outputs
      .map(output => {
        const authNeeded = needsOutputAuth(output) && !output.selected;
        const outputMeta =
          output.id === BROWSER_OUTPUT_ID
            ? 'Browser · MP3 stream'
            : `${output.type || 'AirPlay'} · ${output.format || 'audio'}`;
        return `
      <div class="multiroom-output-row ${output.selected ? 'active' : ''} ${authNeeded ? 'requires-auth' : ''}" data-mr-output="${escapeHtml(output.id)}">
        <button type="button" class="multiroom-toggle" aria-pressed="${output.selected ? 'true' : 'false'}" aria-label="${output.selected ? 'Disable' : 'Enable'} ${escapeHtml(output.name)}"><span>${icons.check}</span></button>
        <span class="multiroom-output-copy"><b>${escapeHtml(output.name || 'Output')}</b><small>${escapeHtml(outputMeta)}${output.selected ? (output.id === BROWSER_OUTPUT_ID ? ' · Playing' : ' · Connected') : authNeeded ? ' · AirPlay code required' : ''}</small></span>
        <span class="multiroom-volume-value">${Number(output.volume ?? 0)}%</span>
        <input class="multiroom-volume" type="range" min="0" max="100" value="${Number(output.volume ?? 0)}" aria-label="${escapeHtml(output.name)} volume" ${output.selected ? '' : 'disabled'}>
        ${authNeeded && pairingOutputs.has(String(output.id)) ? `<form class="multiroom-auth"><p>Enter the code shown on ${escapeHtml(output.name || 'your AirPlay device')}.</p><input class="multiroom-pin" type="text" inputmode="numeric" autocomplete="one-time-code" minlength="4" maxlength="8" pattern="[0-9]{4,8}" placeholder="AirPlay code" aria-label="AirPlay code for ${escapeHtml(output.name)}" required><button type="submit">Connect</button></form>` : ''}
      </div>`;
      })
      .join('');
    const sceneHtml = scenes.length
      ? scenes
          .map(
            scene =>
              `<span class="multiroom-scene"><button type="button" data-scene-apply="${escapeHtml(scene.id)}">${escapeHtml(scene.name)}</button><button type="button" data-scene-delete="${escapeHtml(scene.id)}" aria-label="Delete ${escapeHtml(scene.name)}">${icons.close}</button></span>`
          )
          .join('')
      : '<span class="multiroom-scenes-empty">Save room combinations for one-tap recall.</span>';
    $('multiroomBody').innerHTML = `
      <section class="multiroom-summary"><span>${icons.speakers}</span><div><b>${selectedCount ? `${selectedCount} active ${selectedCount === 1 ? 'room' : 'rooms'}` : 'No active rooms'}</b><small>OwnTone keeps every selected AirPlay output in sync.</small></div><button type="button" id="multiroomAll">All speakers</button></section>
      <section class="multiroom-output-list">${rows || '<p class="multiroom-empty">No outputs available.</p>'}</section>
      <section class="multiroom-scenes"><div class="multiroom-scenes-title"><div><span class="section-kicker">SCENES</span><h3>Room presets</h3></div></div><div class="multiroom-scene-list">${sceneHtml}</div><div class="multiroom-scene-save"><input id="multiroomSceneName" type="text" maxlength="40" placeholder="e.g. Whole home"><button id="multiroomSaveScene" type="button">${icons.save}<span>Save current</span></button></div></section>`;

    $('multiroomAll')?.addEventListener('click', () =>
      changeOutputs(async () => {
        await setEnabledOutputs([
          ...physicalOutputs().map(output => String(output.id)),
          ...(browserOutput().active ? [BROWSER_OUTPUT_ID] : []),
        ]);
        renderMultiroomSheet();
      })
    );
    $('multiroomSaveScene')?.addEventListener('click', saveCurrentScene);
    $('multiroomSceneName')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveCurrentScene();
      }
    });
    multiroomSheet.querySelectorAll('[data-scene-apply]').forEach(button =>
      button.addEventListener('click', () => {
        const scene = readScenes().find(item => item.id === button.dataset.sceneApply);
        if (scene) changeOutputs(() => applyScene(scene));
      })
    );
    multiroomSheet
      .querySelectorAll('[data-scene-delete]')
      .forEach(button => button.addEventListener('click', () => deleteScene(button.dataset.sceneDelete)));
    multiroomSheet.querySelectorAll('[data-mr-output]').forEach(row => {
      const id = row.dataset.mrOutput;
      row.querySelector('.multiroom-toggle')?.addEventListener('click', () =>
        changeOutputs(async () => {
          if (id === BROWSER_OUTPUT_ID) {
            if (browserOutput().active) await disableBrowserOutput();
            else await enableBrowserOutput();
            renderMultiroomSheet();
            return;
          }
          const output = allOutputs().find(item => String(item.id) === id);
          if (output && !output.selected && needsOutputAuth(output)) {
            await beginOutputPairing(output);
            return;
          }
          const active = selectedOutputs().map(output => String(output.id));
          const next = active.includes(id) ? active.filter(item => item !== id) : [...active, id];
          const changed = await setEnabledOutputs(next);
          if (changed) renderMultiroomSheet();
        })
      );
      row.querySelector('.multiroom-auth')?.addEventListener('submit', async event => {
        event.preventDefault();
        const output = allOutputs().find(item => String(item.id) === id);
        if (output)
          await changeOutputs(() =>
            authorizeOutput(
              output,
              row.querySelector('.multiroom-pin')?.value,
              row.querySelector('.multiroom-auth button')
            )
          );
      });
      const slider = row.querySelector('.multiroom-volume');
      const value = row.querySelector('.multiroom-volume-value');
      slider?.addEventListener('input', () => {
        if (value) value.textContent = `${slider.value}%`;
      });
      slider?.addEventListener('change', async () => {
        await setOutputVolume(id, slider.value);
        syncGroupLabel();
      });
    });
    updateOutputControls();
  }

  function interceptOutputButtons() {
    document.addEventListener(
      'click',
      event => {
        if (!event.target.closest?.('#premiumOutputButton,#fullscreenOutputButton')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openMultiroomSheet();
      },
      true
    );
  }

  function contextFromElement(element) {
    const albumCard = element.closest('.album-card[data-uri]');
    if (albumCard)
      return {
        kind: 'album',
        uri: albumCard.dataset.uri,
        label: albumCard.querySelector('.album-copy b')?.textContent?.trim() || 'Album',
        artist: albumCard.querySelector('.album-copy small')?.textContent?.trim() || '',
        album: albumCard.querySelector('.album-copy b')?.textContent?.trim() || '',
        element: albumCard,
      };
    const playlist = element.closest('.playlist-card[data-uri]');
    if (playlist)
      return {
        kind: 'playlist',
        uri: playlist.dataset.uri,
        label: playlist.querySelector('.playlist-copy b')?.textContent?.trim() || 'Playlist',
        element: playlist,
      };
    const search = element.closest('.search-item[data-uri]');
    if (search) {
      const sub = search.querySelector('.search-item-copy small')?.textContent?.trim() || '';
      return {
        kind: 'search',
        uri: search.dataset.uri,
        label: search.querySelector('.search-item-copy b')?.textContent?.trim() || 'Search result',
        artist: sub.split(' · ')[0] || '',
        album: sub.split(' · ')[1] || '',
        element: search,
      };
    }
    const recent = element.closest('.premium-recent-card[data-uri]');
    if (recent)
      return {
        kind: 'history',
        uri: recent.dataset.uri,
        label: recent.querySelector('b')?.textContent?.trim() || 'Recently played',
        artist: recent.querySelector('small')?.textContent?.trim() || '',
        element: recent,
      };
    const exactTrack = element.closest('.album-track-row[data-context-uri]');
    if (exactTrack)
      return {
        kind: 'track',
        uri: exactTrack.dataset.contextUri,
        label: exactTrack.querySelector('b')?.textContent?.trim() || 'Track',
        artist: exactTrack.dataset.contextArtist || '',
        album: exactTrack.dataset.contextAlbum || '',
        element: exactTrack,
      };
    return null;
  }

  function addContextTrigger(element, className = 'context-menu-trigger') {
    if (!element || element.querySelector(':scope > .context-menu-trigger')) return;
    const trigger = document.createElement('span');
    trigger.className = className;
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('aria-label', 'More actions');
    trigger.innerHTML = icons.more;
    const open = event => {
      event.preventDefault();
      event.stopPropagation();
      currentContext = contextFromElement(trigger);
      if (currentContext?.uri) openContextMenu(trigger, currentContext);
    };
    trigger.addEventListener('click', open);
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') open(event);
    });
    element.appendChild(trigger);
  }

  const contextTargets =
    '.album-card[data-uri],.playlist-card[data-uri],.search-item[data-uri],.premium-recent-card[data-uri],.album-track-row[data-context-uri]';
  function enhanceContextTargets(root = document) {
    if (root.matches?.(contextTargets)) addContextTrigger(root);
    root.querySelectorAll(contextTargets).forEach(element => addContextTrigger(element));
  }

  function ensureContextMenu() {
    if (contextMenu) return contextMenu;
    contextMenu = document.createElement('div');
    contextMenu.id = 'contextActionMenu';
    contextMenu.className = 'context-action-menu';
    contextMenu.setAttribute('role', 'menu');
    contextMenu.hidden = true;
    document.body.appendChild(contextMenu);
    return contextMenu;
  }

  function openContextMenu(anchor, context) {
    ensureContextMenu();
    const menuHost = anchor.closest('dialog[open]') || document.body;
    if (contextMenu.parentElement !== menuHost) menuHost.appendChild(contextMenu);
    const navActions = [];
    if (context.kind === 'album')
      navActions.push(
        `<button type="button" data-context-action="open-album">${icons.album}<span>Open album</span></button>`
      );
    else if (context.album)
      navActions.push(
        `<button type="button" data-context-action="go-album">${icons.album}<span>Go to album</span></button>`
      );
    if (context.artist)
      navActions.push(
        `<button type="button" data-context-action="go-artist">${icons.artist}<span>Go to artist</span></button>`
      );
    contextMenu.innerHTML = `
      <div class="context-menu-title"><span>${escapeHtml(context.label)}</span><button type="button" data-context-close aria-label="Close">${icons.close}</button></div>
      <button type="button" data-context-action="play-now">${icons.play}<span>Play now</span></button>
      <button type="button" data-context-action="play-next">${icons.next}<span>Play next</span></button>
      <button type="button" data-context-action="add-queue">${icons.queue}<span>Add to queue</span></button>
      <button type="button" data-context-action="play-last">${icons.last}<span>Play last</span></button>
      ${navActions.length ? `<div class="context-menu-divider"></div>${navActions.join('')}` : ''}`;
    contextMenu.hidden = false;
    contextMenu.classList.add('open');
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 20);
    contextMenu.style.width = `${width}px`;
    const menuHeight = contextMenu.offsetHeight || 330;
    const left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.right - width));
    const top = Math.min(window.innerHeight - menuHeight - 10, rect.bottom + 8);
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${Math.max(10, top)}px`;
    contextMenu.querySelector('[data-context-close]')?.addEventListener('click', closeContextMenu);
    contextMenu
      .querySelectorAll('[data-context-action]')
      .forEach(button =>
        button.addEventListener('click', () => runContextAction(button.dataset.contextAction, context))
      );
    setTimeout(() => contextMenu.querySelector('[data-context-action]')?.focus(), 0);
  }
  function closeContextMenu() {
    if (!contextMenu) return;
    contextMenu.classList.remove('open');
    contextMenu.hidden = true;
    currentContext = null;
  }

  async function queuePositionForNext() {
    const now = await requestJson('/queue?id=now_playing', { cache: 'no-store' });
    const current = now?.items?.[0];
    return current?.position != null ? Number(current.position) + 1 : 0;
  }
  async function queueCount() {
    const queue = await requestJson('/queue?start=0&end=1', { cache: 'no-store' });
    return Number(queue?.count || 0);
  }
  async function addUriAt(uri, position) {
    if (isDemo()) return { count: 1 };
    const qs = new URLSearchParams({ uris: uri, clear: 'false' });
    if (position != null) qs.set('position', String(position));
    return requestJson(`/queue/items/add?${qs}`, { method: 'POST' });
  }

  function openSearchFor(query) {
    const input = $('searchInput');
    const button = $('searchButton');
    if (!input || !button || !query) return;
    button.click();
    setTimeout(() => {
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }, 80);
  }

  async function runContextAction(action, context) {
    closeContextMenu();
    if (!context?.uri) return;
    try {
      if (action === 'play-now') {
        if (context.element && !context.element.matches('.album-track-row')) context.element.click();
        else await app()?.playUri?.(context.uri);
        return;
      }
      if (action === 'play-next') {
        const position = isDemo() ? 1 : await queuePositionForNext();
        await addUriAt(context.uri, position);
        toast(`${context.label} will play next`);
      }
      if (action === 'add-queue') {
        await addUriAt(context.uri, null);
        toast(`${context.label} added to queue`);
      }
      if (action === 'play-last') {
        const position = isDemo() ? 99 : await queueCount();
        await addUriAt(context.uri, position);
        toast(`${context.label} added last`);
      }
      if (action === 'open-album') {
        context.element?.querySelector('.album-info-button')?.click();
        return;
      }
      if (action === 'go-album') {
        openSearchFor(context.album);
        return;
      }
      if (action === 'go-artist') {
        openSearchFor(context.artist);
        return;
      }
      await app()?.refreshPlayback?.();
      if (typeof window.OWNTONE_REFRESH_QUEUE === 'function') await window.OWNTONE_REFRESH_QUEUE();
    } catch (error) {
      toast(`Queue action failed: ${error.message}`);
    }
  }

  function captureAlbumContext() {
    document.addEventListener(
      'click',
      event => {
        const info = event.target.closest?.('.album-info-button');
        if (!info) return;
        const card = info.closest('.album-card[data-uri]');
        if (!card) return;
        lastAlbumContext = {
          uri: card.dataset.uri || '',
          name: card.querySelector('.album-copy b')?.textContent?.trim() || 'Album',
          artist: card.querySelector('.album-copy small')?.textContent?.trim() || '',
        };
        scheduleExactAlbumTracks();
      },
      true
    );
  }

  function albumIdFromUri(uri) {
    const match = String(uri || '').match(/^library:album:(.+)$/);
    return match ? match[1] : '';
  }

  function scheduleExactAlbumTracks() {
    clearTimeout(exactTrackTimer);
    exactTrackTimer = setTimeout(rewriteExactAlbumTracks, 120);
  }

  async function rewriteExactAlbumTracks() {
    const list = $('albumTrackList');
    if (!list || !lastAlbumContext || exactTrackRewrite) return;
    if (
      list.dataset.contextAlbumUri === lastAlbumContext.uri &&
      list.querySelector('[data-context-uri], .premium-empty')
    ) {
      enhanceContextTargets();
      return;
    }
    const context = lastAlbumContext;
    const albumId = albumIdFromUri(context.uri);
    exactTrackRewrite = true;
    try {
      let tracks;
      if (isDemo()) {
        tracks = ['Opening track', 'Side A', 'Interlude', 'Deep cut', 'Side B', 'Finale'].map(
          (title, index) => ({
            uri: `library:track:demo-${index + 1}`,
            title,
            artist: context.artist,
            album: context.name,
            track_number: index + 1,
            length_ms: (188 + index * 17) * 1000,
          })
        );
      } else if (albumId) {
        const data = await requestJson(`/library/albums/${encodeURIComponent(albumId)}/tracks?limit=100`, {
          cache: 'no-store',
        });
        tracks = data?.items || [];
      } else return;
      if (lastAlbumContext !== context || $('albumTrackList') !== list) return;
      list.dataset.contextAlbumUri = context.uri;
      const count = $('albumTrackCount');
      if (count) count.textContent = `${tracks.length} tracks`;
      list.innerHTML = tracks.length
        ? tracks
            .map(
              (track, index) =>
                `<div class="album-track-row" data-context-uri="${escapeHtml(track.uri || '')}" data-context-artist="${escapeHtml(track.artist || context.artist)}" data-context-album="${escapeHtml(track.album || context.name)}"><span>${escapeHtml(String(track.track_number || index + 1).padStart(2, '0'))}</span><span><b>${escapeHtml(track.title || 'Untitled')}</b><small>${escapeHtml(track.artist || context.artist)}</small></span><em>${formatDuration(track.length_ms)}</em></div>`
            )
            .join('')
        : '<div class="premium-empty">No tracks found for this album.</div>';
      enhanceContextTargets();
    } catch (error) {
      console.warn('Exact album tracklist failed:', error);
    } finally {
      exactTrackRewrite = false;
      if (lastAlbumContext !== context) scheduleExactAlbumTracks();
    }
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    return total ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` : '';
  }

  function observeDynamicContent() {
    const observer = new MutationObserver(mutations => {
      // Enhance only new elements, rather than rescanning the entire library
      // whenever any player label, clock or unrelated dialog changes.
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element && node.isConnected) enhanceContextTargets(node);
        }
      }
      if (
        $('albumTrackList') &&
        lastAlbumContext &&
        mutations.some(
          mutation =>
            mutation.target === $('albumTrackList') || $('albumTrackList')?.contains(mutation.target)
        )
      )
        scheduleExactAlbumTracks();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function openHistoryCorrectly() {
    document.addEventListener(
      'click',
      event => {
        if (!event.target.closest?.('#premiumOpenHistory')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        $('queueDrawerButton')?.click();
        setTimeout(() => document.querySelector('#playbackDrawer [data-tab="history"]')?.click(), 30);
      },
      true
    );
  }

  function installGroupVolumeBridge() {
    const main = $('volumeRange');
    if (!main) return;
    main.addEventListener('change', async () => {
      const selected = selectedOutputs();
      if (selected.length < 2) return;
      const value = Number(main.value || 0);
      await Promise.all(selected.map(output => setOutputVolume(output.id, value, { quiet: true })));
      syncGroupLabel();
    });
  }

  function mount() {
    ensureContextMenu();
    ensureMultiroomSheet();
    interceptOutputButtons();
    captureAlbumContext();
    openHistoryCorrectly();
    enhanceContextTargets();
    observeDynamicContent();
    installGroupVolumeBridge();
    syncGroupLabel();
    window.addEventListener('owntone-browser-output-change', () => {
      syncGroupLabel();
      if (multiroomSheet?.classList.contains('open')) renderMultiroomSheet();
    });
    window.OwnTone.on('owntone:player-updated', syncGroupLabel);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        syncGroupLabel();
        enhanceContextTargets();
      }
    });

    document.addEventListener('click', event => {
      if (contextMenu?.hidden) return;
      if (event.target.closest?.('#contextActionMenu,.context-menu-trigger')) return;
      closeContextMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (contextMenu && !contextMenu.hidden) closeContextMenu();
      if (multiroomSheet?.classList.contains('open')) closeMultiroomSheet();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
