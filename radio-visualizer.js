(() => {
  'use strict';

  const BAR_COUNT = 30;
  const BAR_GAP = 4;
  const BAR_WIDTH = 3;
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
    // Clamp the visible size: if the container is display:none (paused)
    // the rect is 0×0. Use a safe default so the canvas still has a buffer;
    // tick() will re-run resize() the moment the wave becomes visible.
    width = rect.width >= 4 ? Math.round(rect.width) : 360;
    height = rect.height >= 4 ? Math.round(rect.height) : 30;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx = canvas.getContext('2d', { alpha: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Sample the FFT once. Returns true if the bars look "alive" (something
  // other than silence), false if every bin is near zero — in which case
  // we fall back to the procedural pattern instead of letting everything
  // collapse to the floor.
  function sampleFFT() {
    if (!analyser || !freqData || !audioEl) return null;
    if (audioEl.paused || audioEl.ended) return null;
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < freqData.length; i += 1) {
      const v = freqData[i];
      sum += v;
      if (v > peak) peak = v;
    }
    const avg = sum / freqData.length;
    if (avg < 4 && peak < 12) return null; // silence / dead stream
    return freqData;
  }

  // Compute target heights (0..1) for all bars.
  function computeBars(time) {
    let next;
    const live = sampleFFT();
    if (live) {
      // Bin count is FFT_SIZE/2. Spread across the bar count. Bass gets the
      // outsized share so the left of the floor visibly pumps.
      const binCount = live.length;
      next = new Float32Array(BAR_COUNT);
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const idx = Math.floor((i / BAR_COUNT) * binCount);
        next[i] = live[idx] / 255;
      }
    } else {
      const t = time * 0.001;
      next = new Float32Array(BAR_COUNT);
      // Build a spectrum: each bar has its own (slowly drifting) carrier
      // frequency, an independent envelope, and a few bass/mid kicks that
      // land on a tempo so the floor visibly dances.
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const p = i / BAR_COUNT;
        // Per-bar carrier: stagger phases so adjacent bars never peak together.
        const carrierPhase = i * 0.71 + seed * 6.28;
        const carrierHz = 0.7 + (i % 5) * 0.35;
        // Sharper attack/release cycle per bar — not a slow sin, a pulse.
        const pulse = Math.max(0, Math.sin(t * carrierHz + carrierPhase)) ** 1.8;
        // Spectral shape: bass strong on the left, mids dominant in the
        // middle, treble tapering off. This mirrors what a real mix looks
        // like (vocals/instruments cluster in 200 Hz - 4 kHz).
        const spectral = Math.pow(1 - Math.abs(p - 0.45) * 1.6, 0.6);
        // Three kicks land on a regular tempo. Beat frequency is in human
        // dance range, slightly varies per track.
        const bpm = (90 + seed * 60) | 0; // 90..150 bpm
        const beatPhase = (t * bpm) / 60;
        const kick1 = Math.max(0, Math.sin(beatPhase * Math.PI)) ** 4;
        const kick2 = Math.max(0, Math.sin((beatPhase - 0.5) * Math.PI)) ** 6;
        const kick3 = Math.max(0, Math.sin((beatPhase - 0.25) * Math.PI)) ** 8;
        // Bass-side bars get the kick weight; right side mostly pulses.
        const kickWeight = Math.pow(1 - p, 1.2);
        const kicks = (kick1 * 0.55 + kick2 * 0.3 + kick3 * 0.15) * kickWeight;
        // Combine. Use Math.min to avoid clipping past 1.
        next[i] = Math.min(1, pulse * spectral * 0.85 + kicks * 0.9);
      }
    }
    // Smooth toward target so spikes don't snap.
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const target = next[i];
      const cur = bars[i];
      // Asymmetric smoothing: fast attack, slower release — feels musical.
      const k = target > cur ? 0.7 : 0.28;
      bars[i] = cur + (target - cur) * k;
    }
  }

  function draw() {
    if (!ctx || !width || !height) return;
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const barWidth = BAR_WIDTH;
    const gap = BAR_GAP;
    const maxHalf = (height - 4) / 2;

    for (let i = 0; i < BAR_COUNT; i += 1) {
      // Square the height so quiet bars stay visible but loud bars punch.
      const amp = Math.pow(bars[i], 1.4);
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

    if (wave.dataset.vizVisible !== '1') {
      // Pre-sizing matters: the moment the container flips from
      // display:none to display:flex, getBoundingClientRect already returns
      // a usable size, so size the canvas up front rather than waiting on a
      // ResizeObserver tick.
      resize();
      wave.dataset.vizVisible = '1';
    } else if (!width || !height) {
      resize();
    }

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

    // Bind/unbind the analyser when browser output toggles. Only when the
    // browser is actually streaming — if it is paused (e.g. user picked a
    // non-browser output) the AnalyserNode would happily report silence
    // every frame and make the floor look dead.
    window.addEventListener('owntone-browser-output-change', () => {
      const active = isBrowserOutputActive();
      if (active) ensureAnalyser();
      else disconnectAnalyser();
    });

    if (!prefersReduced) raf = requestAnimationFrame(tick);
  }

  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();
  window.addEventListener('pagehide', () => cancelAnimationFrame(raf), { once: true });
})();
