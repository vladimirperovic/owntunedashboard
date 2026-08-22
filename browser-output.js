(() => {
  'use strict';

  const cfg = window.OWNTONE_DASHBOARD || {};
  const outputId = 'browser';
  const outputName = 'This browser';
  const streamPath = String(cfg.browserStreamPath || '/stream.mp3');
  let audio;
  let active = false;
  let lastError = '';

  function ensureAudio() {
    if (audio) return audio;
    audio = document.createElement('audio');
    audio.id = 'browserAudioOutput';
    audio.preload = 'none';
    audio.setAttribute('aria-hidden', 'true');
    audio.style.display = 'none';
    document.body.appendChild(audio);
    audio.addEventListener('error', () => {
      lastError = 'The browser stream could not be opened';
      active = false;
      emit();
    });
    return audio;
  }

  function streamUrl() {
    const separator = streamPath.includes('?') ? '&' : '?';
    return `${streamPath}${separator}browser=${Date.now()}`;
  }

  function emit() {
    window.dispatchEvent(new CustomEvent('owntone-browser-output-change', {
      detail: getState(),
    }));
  }

  function getState() {
    const current = ensureAudio();
    return {
      id: outputId,
      name: outputName,
      type: 'Browser',
      format: 'mp3',
      volume: Math.round((current.volume || 0) * 100),
      selected: active,
      active,
      error: lastError,
    };
  }

  async function start(volume = 50) {
    const current = ensureAudio();
    lastError = '';
    current.volume = Math.max(0, Math.min(1, Number(volume) / 100));
    if (!current.src) {
      current.src = streamUrl();
      current.load();
    }
    try {
      await current.play();
      active = true;
      emit();
      return true;
    } catch (error) {
      active = false;
      lastError = error?.message || 'Browser playback was blocked';
      current.pause();
      current.removeAttribute('src');
      current.load();
      emit();
      throw error;
    }
  }

  function stop() {
    const current = ensureAudio();
    active = false;
    current.pause();
    current.removeAttribute('src');
    current.load();
    lastError = '';
    emit();
  }

  function setVolume(value) {
    const current = ensureAudio();
    current.volume = Math.max(0, Math.min(1, Number(value) / 100));
    emit();
  }

  window.OWNTONE_BROWSER_OUTPUT = { getState, start, stop, setVolume };
})();
