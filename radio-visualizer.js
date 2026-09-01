(() => {
  'use strict';

  const BAR_COUNT = 30;
  const FFT_SIZE = 64;
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  let wave;
  let canvas;
  let ctx;
  let raf = 0;
  let last = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;

  // Smoothed bar heights, one per bar.
  let bars = new Float32Array(BAR_COUNT);

  // Procedural fallback seed (changes with the track so it doesn't loop identically).
  let seed = 0.71;
  let phase = 0;

  // Live audio plumbing — only created on demand, only when Browser output exists.
  let analyser = null;
  let freqData = null;
  let audioEl = null;

  function isPlaying() {
    const state = window.OWNTONE_APP?.state;
    return !!state && state.player?.state === 'play' && !state.demo && state.online;
  }

  function isBrowserOutputActive() {
    return !!window.OWNTONE_BROWSER_OUTPUT?.getState?.().active;
  }

  function ensureAnalyser() {
    if (analyser) return analyser;
    const audio = document.getElementById('browserAudioOutput');
    if (!audio || typeof window.AudioContext === 'undefined') return null;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ac = new Ctor();
      const src = ac.createMediaElementSource(audio);
      const node = ac.createAnalyser();
      node.fftSize = FFT_SIZE;
      node.smoothingTimeConstant = 0.7;
      src.connect(node);
      // The analyser must be in the graph for it to produce data, but we do
      // NOT want to mute the speakers. The browser-output module already drives
      // the audio element's volume directly, so connecting source -> node and
      // leaving node -> destination missing would silence playback. Bridge it.
      node.connect(ac.destination);
      analyser = node;
      freqData = new Uint8Array(node.frequencyBinCount);
      audioEl = audio;
      return analyser;
    } catch (_) {
      return null;
    }
  }

  function disconnectAnalyser() {
    if (!analyser) return;
    try {
      analyser.disconnect();
    } catch (_) {}
    analyser = null;
    freqData = null;
    audioEl = null;
  }

  function updateSeed() {
    const title = document.getElementById('trackTitle')?.textContent || '';
    const meta = document.getElementById('trackMeta')?.textContent || '';
    let h = 2166136261;
    const text = `${title}|${meta}`;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    seed = (h >>> 0) / 4294967295 || 0.71;
  }

  function resize() {
    if (!canvas || !wave) return;
    const rect = wave.getBoundingClientRect();
    width = Math.max(120, Math.round(rect.width));
    height = Math.max(28, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx = canvas.getContext('2d', { alpha: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Read live FFT bins (0..1) when we have them, otherwise synthesise bars
  // from sin waves + the track seed. Output is normalised 0..1 per bar.
  function computeBars(time) {
    let next;
    if (analyser && freqData && audioEl && !audioEl.paused) {
      analyser.getByteFrequencyData(freqData);
      // Map FFT bins onto our BAR_COUNT bars. freqData has frequencyBinCount
      // bins; lower indexes are bass, higher are treble. We want bars that
      // feel like a dancing floor — strong bass, mid, treble. So bin i maps
      // to bar i * (binCount / BAR_COUNT).
      const binCount = freqData.length;
      next = new Float32Array(BAR_COUNT);
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const idx = Math.floor((i / BAR_COUNT) * binCount);
        next[i] = freqData[idx] / 255;
      }
    } else {
      const t = time * 0.001;
      phase += 1;
      next = new Float32Array(BAR_COUNT);
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const p = i / BAR_COUNT;
        // Bass envelope: loud on the left, dies off toward the right, with a
        // slow pulse so the floor visibly breathes.
        const envelope = Math.pow(1 - p, 0.7);
        const bass = Math.sin(t * 3.1 + seed * 6.28 + p * 4.0) * 0.5 + 0.5;
        const mid = Math.sin(t * 6.4 + seed * 9.1 + p * 9.0) * 0.5 + 0.5;
        const hi = Math.sin(t * 11.2 + seed * 12.7 + p * 17.0) * 0.5 + 0.5;
        const pulse = 0.55 + 0.35 * Math.sin(t * 1.3 + seed * 4.2);
        next[i] = (bass * 0.55 + mid * 0.3 + hi * 0.15) * envelope * pulse;
      }
    }
    // Smooth toward target so spikes don't snap.
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const target = next[i];
      const cur = bars[i];
      // Asymmetric smoothing: fast attack, slower release — feels musical.
      const k = target > cur ? 0.55 : 0.18;
      bars[i] = cur + (target - cur) * k;
    }
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const gap = 3;
    const barWidth = Math.max(2, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const maxHalf = (height - 4) / 2;

    for (let i = 0; i < BAR_COUNT; i += 1) {
      // Square the height so quiet bars stay visible but loud bars punch.
      const amp = Math.pow(bars[i], 1.6);
      const h = Math.max(2, amp * maxHalf);
      const x = i * (barWidth + gap);
      const y = mid - h;

      // Gradient per bar: warm coral core, soft top fade so bars feel lit,
      // not stamped. Cheap — one gradient cached below per draw.
      const grad = ctx.createLinearGradient(0, y, 0, y + h * 2);
      grad.addColorStop(0, 'rgba(255, 126, 97, 0.15)');
      grad.addColorStop(0.45, 'rgba(240, 90, 67, 0.95)');
      grad.addColorStop(1, 'rgba(240, 90, 67, 0.85)');

      ctx.fillStyle = grad;
      roundRect(ctx, x, y, barWidth, h * 2, barWidth / 2);
      ctx.fill();
    }
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.lineTo(x + w - rr, y);
    c.quadraticCurveTo(x + w, y, x + w, y + rr);
    c.lineTo(x + w, y + h - rr);
    c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    c.lineTo(x + rr, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - rr);
    c.lineTo(x, y + rr);
    c.quadraticCurveTo(x, y, x + rr, y);
    c.closePath();
  }

  function tick(time) {
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    if (time - last < 33) return; // ~30 fps, deliberately light
    last = time;

    if (!isPlaying()) {
      // Paused / no playback: hide the visualizer entirely.
      if (wave.dataset.vizVisible === '1') {
        wave.dataset.vizVisible = '0';
        ctx?.clearRect(0, 0, width, height);
        for (let i = 0; i < BAR_COUNT; i += 1) bars[i] = 0;
      }
      return;
    }

    if (wave.dataset.vizVisible !== '1') wave.dataset.vizVisible = '1';
    computeBars(time);
    draw();
  }

  function mount() {
    wave = document.querySelector('.radio-wave');
    if (!wave || wave.dataset.vizMounted === '1') return;
    wave.dataset.vizMounted = '1';

    // The static <i> bars are dead weight now; the canvas paints everything.
    // Keep the elements so layout doesn't shift, but hide them.
    wave.querySelectorAll('i').forEach(el => {
      el.style.display = 'none';
    });

    canvas = document.createElement('canvas');
    canvas.className = 'radio-visualizer-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wave.appendChild(canvas);

    resize();
    new ResizeObserver(resize).observe(wave);

    updateSeed();
    new MutationObserver(updateSeed).observe(document.querySelector('.track-copy') || document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    // Bind/unbind the analyser when browser output toggles.
    window.addEventListener('owntone-browser-output-change', () => {
      if (isBrowserOutputActive()) ensureAnalyser();
      else disconnectAnalyser();
    });

    if (!prefersReduced) raf = requestAnimationFrame(tick);
  }

  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();
  window.addEventListener('pagehide', () => cancelAnimationFrame(raf), { once: true });
})();