(() => {
  'use strict';

  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  let canvas;
  let ctx;
  let wave;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let seed = 0.71;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function hashText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function updateSeed() {
    const title = document.getElementById('trackTitle')?.textContent || '';
    const meta = document.getElementById('trackMeta')?.textContent || '';
    seed = hashText(`${title}|${meta}`) || 0.71;
  }

  function resize() {
    if (!canvas || !wave) return;
    const rect = wave.getBoundingClientRect();
    width = Math.max(120, Math.round(rect.width));
    height = Math.max(36, Math.round(rect.height));
    dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx = canvas.getContext('2d', {alpha:true});
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(performance.now(), true);
  }

  function draw(time, staticFrame = false) {
    if (!ctx || !width || !height) return;
    ctx.clearRect(0, 0, width, height);

    const t = staticFrame ? 0.8 : time * 0.001;
    const mid = height * 0.5;
    const pad = 2;
    const amp = Math.min(height * 0.34, 15);

    const glow = ctx.createLinearGradient(0, 0, width, 0);
    glow.addColorStop(0, 'rgba(240,90,67,.08)');
    glow.addColorStop(.18, 'rgba(240,90,67,.88)');
    glow.addColorStop(.74, 'rgba(255,126,97,.98)');
    glow.addColorStop(1, 'rgba(240,90,67,.08)');

    // soft depth line
    ctx.beginPath();
    for (let x = pad; x <= width - pad; x += 2) {
      const p = x / width;
      const envelope = Math.pow(Math.sin(Math.PI * p), .55);
      const y = mid
        + Math.sin((p * 9.5 + t * .62 + seed * 4.1) * Math.PI) * amp * .20 * envelope
        + Math.sin((p * 23.0 - t * .39 + seed * 7.3) * Math.PI) * amp * .09 * envelope;
      x === pad ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(240,90,67,.22)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 18;
    ctx.shadowColor = 'rgba(240,90,67,.18)';
    ctx.stroke();

    // crisp waveform
    ctx.beginPath();
    for (let x = pad; x <= width - pad; x += 1.5) {
      const p = x / width;
      const envelope = Math.pow(Math.sin(Math.PI * p), .42);
      const carrier = Math.sin((p * 16.5 + t * .95 + seed * 2.8) * Math.PI);
      const detail = Math.sin((p * 37.0 - t * .57 + seed * 5.9) * Math.PI);
      const slow = Math.sin((p * 5.0 + t * .21) * Math.PI);
      const energy = .48 + .28 * Math.sin(t * .83 + seed * 6.28);
      const y = mid + (carrier * .62 + detail * .28 + slow * .10) * amp * energy * envelope;
      x === pad ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.shadowBlur = 9;
    ctx.shadowColor = 'rgba(240,90,67,.26)';
    ctx.strokeStyle = glow;
    ctx.lineWidth = 2.25;
    ctx.stroke();

    // tiny travelling highlights make it feel less like a stock equalizer
    ctx.shadowBlur = 0;
    for (let i = 0; i < 4; i += 1) {
      const p = (t * (.055 + i * .006) + seed * .77 + i * .23) % 1;
      const x = 8 + p * (width - 16);
      const envelope = Math.pow(Math.sin(Math.PI * p), .6);
      const y = mid + Math.sin((p * 16.5 + t * .95 + seed * 2.8) * Math.PI) * amp * .34 * envelope;
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 1.9 : 1.25, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? 'rgba(255,241,235,.92)' : 'rgba(255,140,112,.72)';
      ctx.fill();
    }
  }

  function animate(time) {
    raf = requestAnimationFrame(animate);
    if (document.hidden || !document.body.classList.contains('radio-mode')) return;
    if (time - last < 33) return; // ~30fps, deliberately light
    last = time;
    draw(time, false);
  }

  function mount() {
    wave = document.querySelector('.radio-wave');
    if (!wave || wave.dataset.canvasVisualizer === '1') return;
    wave.dataset.canvasVisualizer = '1';
    canvas = document.createElement('canvas');
    canvas.className = 'radio-visualizer-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wave.appendChild(canvas);
    updateSeed();
    new ResizeObserver(resize).observe(wave);
    resize();

    new MutationObserver(() => {
      updateSeed();
      if (prefersReduced) draw(performance.now(), true);
    }).observe(document.querySelector('.track-copy') || document.body, {subtree:true, childList:true, characterData:true});

    if (!prefersReduced) raf = requestAnimationFrame(animate);
  }

  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();
  window.addEventListener('pagehide', () => cancelAnimationFrame(raf), {once:true});
})();
