/* editor-v — app.js
   UI, live preview and export. Everything runs in this page; there is no
   network code anywhere in this file (and the page's CSP forbids it). */
(function () {
  'use strict';

  /* ------------------------------------------------------------ helpers */
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };
  const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
  const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const raf = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(2) + ' MB';

  /* ------------------------------------------------------------- state */
  const DEF = Pipeline.defaults();
  const P = Pipeline.defaults();
  const S = {
    name: 'image', full: null, fullW: 0, fullH: 0, note: '',
    previewFull: null, previewQuick: null,       // { img, k }
    srcPreviewRGBA: null,                        // ImageData of the untouched preview, for compare
    lastResult: null, lastResultRGBA: null, lastK: 1,
    zoom: 'fit', previewMax: 1000, comparing: false,
    fullCache: null,                             // { key, img } for export
    rendering: false, pending: null, timer: null, fullTimer: null,
    drag: null,
  };

  /* ---------------------------------------------------- browser scaler */
  // Plugs the browser's own (canvas) resampler into the pipeline as the "Browser" method.
  Pipeline.browserResample = function (img, dw, dh) {
    const c1 = document.createElement('canvas'); c1.width = img.w; c1.height = img.h;
    c1.getContext('2d').putImageData(new ImageData(Pipeline.toRGBA(img), img.w, img.h), 0, 0);
    const c2 = document.createElement('canvas'); c2.width = dw; c2.height = dh;
    const ctx = c2.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c1, 0, 0, dw, dh);
    const d = ctx.getImageData(0, 0, dw, dh);
    return Pipeline.fromRGBA(d.data, dw, dh);
  };

  /* ------------------------------------------------------ control spec */
  const KERNEL_OPTIONS = [
    ['lanczos3', 'Lanczos — sharpest, best quality'],
    ['catmull', 'Bicubic (Catmull-Rom) — sharp'],
    ['mitchell', 'Bicubic (Mitchell) — balanced'],
    ['lanczos2', 'Lanczos-2 — sharp, a little softer'],
    ['bilinear', 'Bilinear — soft, simple'],
    ['bspline', 'B-spline — very soft, smeary'],
    ['nearest', 'Nearest — blocky, no blending'],
    ['browser', "Browser's own scaler — fast"],
  ];
  const slider = (path, label, min, max, step, unit, hintL, hintR, extra) =>
    Object.assign({ type: 'slider', path, label, min, max, step, unit, hintL, hintR }, extra || {});
  const check = (path, label, hint) => ({ type: 'check', path, label, hint });
  const select = (path, label, options, hint) => ({ type: 'select', path, label, options, hint });
  const seg = (path, label, options, hint) => ({ type: 'seg', path, label, options, hint });
  const button = (label, onClick, extra) => Object.assign({ type: 'button', label, onClick }, extra || {});
  const note = (text) => ({ type: 'note', text });
  const group = (title, swatch) => ({ type: 'group', title, swatch });
  const readout = (id) => ({ type: 'readout', id });

  const channelControls = () => {
    const out = [];
    for (const [c, name, sw] of [['r', 'Red', 'swatch-r'], ['g', 'Green', 'swatch-g'], ['b', 'Blue', 'swatch-b']]) {
      const n = name.toLowerCase();
      out.push(group(name + ' layer', sw));
      out.push(slider(`ch.${c}.x`, `${name} — sideways (X)`, -24, 24, 0.25, 'px', `${n} layer slides left`, `${n} layer slides right`));
      out.push(slider(`ch.${c}.y`, `${name} — up / down (Y)`, -24, 24, 0.25, 'px', `${n} layer slides up`, `${n} layer slides down`));
      out.push(slider(`ch.${c}.z`, `${name} — zoom (Z)`, -6, 6, 0.05, '%', `${n} layer shrinks toward the centre`, `${n} layer grows out from the centre`));
    }
    return out;
  };
  const bandControls = (b, title, strengthL, strengthR, noiseWord) => [
    group(title),
    slider(`freq.${b}.gain`, 'Strength', -100, 200, 1, '%', strengthL, strengthR),
    slider(`freq.${b}.noise`, 'Add noise', 0, 40, 0.5, 'levels', 'no noise added', `more random ${noiseWord} in this layer`),
    slider(`freq.${b}.blur`, 'Blur this layer', 0, 12, 0.1, 'px', 'layer stays as it is', 'layer smears more'),
    slider(`freq.${b}.smooth`, 'Smooth this layer', 0, 100, 1, '', 'untouched', 'evens out small bumps but keeps this layer\'s strong edges'),
  ];

  const SECTIONS = [
    {
      id: 'ch', title: 'Colour channel shifts', open: true,
      blurb: 'Moves and zooms the red, green and blue layers separately, like the colour fringing of a cheap lens. Any edge that ends up missing a colour is trimmed off the frame automatically, so no smeared borders.',
      controls: [...channelControls(), button('Reset channel shifts', () => resetSection('ch'), { small: true })],
    },
    {
      id: 'freq', title: 'Frequency bands (detail layers)',
      blurb: 'Splits the picture into three layers by the size of detail: Fine (grain, hair, edges), Medium (textures, small shapes) and Coarse (big shapes, lighting). Each layer can be boosted or cut, blurred, smoothed, or given its own noise.',
      controls: [
        slider('freq.fine', 'Fine ↔ medium boundary', 0.5, 8, 0.1, 'px', 'fine layer keeps only the tiniest detail', 'fine layer takes in bigger detail too'),
        slider('freq.coarse', 'Medium ↔ coarse boundary', 4, 80, 0.5, 'px', 'coarse layer holds only the very largest shapes', 'coarse layer swallows more mid-size shapes'),
        seg('freq.view', 'Show in the preview', [['full', 'Everything'], ['low', 'Coarse'], ['mid', 'Medium'], ['high', 'Fine']],
          'Look at one layer on its own to understand what you are editing. The downloaded file always contains everything.'),
        check('freq.colorNoise', 'Colour noise', 'On: each colour channel gets its own noise pattern (coloured speckle). Off: the same pattern on all three (neutral grain).'),
        ...bandControls('low', 'Coarse layer — big shapes & lighting', 'big shapes flatten toward an even tone', 'big shapes get more contrast', 'soft blotches'),
        ...bandControls('mid', 'Medium layer — textures & small shapes', 'textures fade away', 'textures stand out harder', 'speckle'),
        ...bandControls('high', 'Fine layer — grain, hair & edges', 'fine detail softens away', 'fine detail sharpens, grain shows', 'fine grain'),
        button('Reset frequency bands', () => resetSection('freq'), { small: true }),
      ],
    },
    {
      id: 'grad', title: 'Gradient perturbation',
      blurb: 'Adds slow, smooth changes of brightness and colour across the picture — like faint uneven lighting — plus a random variation in how strong edges are. Subtle amounts are invisible to the eye but change every pixel.',
      controls: [
        group('Random drift'),
        slider('grad.drift', 'Amount', 0, 40, 0.5, 'levels', 'none', 'stronger patches of light, dark and colour drift'),
        slider('grad.driftCell', 'Patch size', 20, 1500, 10, 'px', 'small, busy patches', 'huge, gentle sweeps'),
        check('grad.driftColor', 'Drift colour, not just brightness', 'On: each colour channel drifts its own way, giving faint colour casts. Off: brightness only.'),
        group('Lighting tilt'),
        slider('grad.tilt', 'Strength', -40, 40, 0.5, 'levels', 'light fades toward the angle (that side darker)', 'light grows toward the angle (that side brighter)'),
        slider('grad.tiltAngle', 'Angle', 0, 360, 1, '°', 'turns the tilt direction anticlockwise', 'turns the tilt direction clockwise', { note: '0° = across (right side changes), 90° = down (bottom changes).' }),
        group('Edge jitter'),
        slider('grad.jitter', 'Amount', 0, 100, 1, '%', 'edges untouched', 'edges randomly sharpened and softened in patches'),
        slider('grad.jitterCell', 'Patch size', 10, 600, 5, 'px', 'tiny patches, almost grainy', 'broad regions'),
        group('Random pattern'),
        { type: 'seed' },
        button('Reset gradient perturbation', () => resetSection('grad'), { small: true }),
      ],
    },
    {
      id: 'geo', title: 'Frame — micro crop, tilt & rotate',
      blurb: 'Fine adjustments to the framing. The frame always shrinks to the area that has real picture in it, so you never get empty, black or white corners.',
      controls: [
        slider('geo.rotate', 'Rotate', -15, 15, 0.05, '°', 'turns the picture anticlockwise', 'turns the picture clockwise'),
        slider('geo.tiltX', 'Tilt top / bottom', -15, 15, 0.1, '°', 'top edge leans away (top looks narrower)', 'bottom edge leans away (bottom looks narrower)'),
        slider('geo.tiltY', 'Tilt left / right', -15, 15, 0.1, '°', 'right edge leans away (right looks shorter)', 'left edge leans away (left looks shorter)'),
        slider('geo.crop', 'Trim edges', 0, 25, 0.1, '%', 'keep the whole valid area', 'cut more off every side'),
        slider('geo.posX', 'Window position — sideways', -100, 100, 1, '', 'window slides left (keeps more of the left side)', 'window slides right (keeps more of the right side)', { note: 'Only does something once some edge has been trimmed.' }),
        slider('geo.posY', 'Window position — up / down', -100, 100, 1, '', 'window slides up (keeps more of the top)', 'window slides down (keeps more of the bottom)'),
        check('geo.restoreSize', 'Stretch the result back to the original pixel size', 'On: the trimmed frame is scaled up so the saved image has the same width and height as the original (uses the resampling method below). Off: the saved image is simply smaller.'),
        readout('frame-readout'),
        button('Reset frame', () => resetSection('geo'), { small: true }),
      ],
    },
    {
      id: 'rs', title: 'Resampling',
      blurb: 'Re-computes every pixel by scaling the picture to a temporary size and straight back. The dimensions stay the same, but each pixel value is re-interpolated. Can be done to the whole image and, separately, to one region.',
      controls: [
        select('rs.kernel', 'Method (quality / kernel)', KERNEL_OPTIONS, 'Sharper methods keep more detail; softer ones smear fine detail. Also used for the final size and the "stretch back" option above.'),
        slider('rs.roundTrip', 'Whole image — temporary size', 25, 200, 1, '%', 'shrinks then enlarges back: loses fine detail, softer', 'enlarges then shrinks back: keeps detail, subtler change', { note: '100% = off. Every other value re-interpolates the whole picture.' }),
        slider('rs.outScale', 'Final output size', 10, 200, 1, '%', 'saved image gets smaller', 'saved image gets bigger'),
        group('Region'),
        check('rs.region.on', 'Resample a region on its own', 'Draw the region by dragging on the preview. It gets its own temporary size and method, blended back with a soft edge.'),
        slider('rs.region.scale', 'Region — temporary size', 25, 200, 1, '%', 'region shrinks then enlarges back: softer', 'region enlarges then shrinks back: subtler'),
        select('rs.region.kernel', 'Region method', KERNEL_OPTIONS),
        slider('rs.region.feather', 'Soft edge', 0, 60, 1, 'px', 'hard edge (a seam may show)', 'wider blend into the surroundings'),
        slider('rs.region.x', 'Region — left edge', 0, 0.95, 0.005, 'frac', 'region starts further left', 'region starts further right', { pct: true }),
        slider('rs.region.y', 'Region — top edge', 0, 0.95, 0.005, 'frac', 'region starts higher', 'region starts lower', { pct: true }),
        slider('rs.region.w', 'Region — width', 0.02, 1, 0.005, 'frac', 'narrower', 'wider', { pct: true }),
        slider('rs.region.h', 'Region — height', 0.02, 1, 0.005, 'frac', 'shorter', 'taller', { pct: true }),
        button('Reset resampling', () => resetSection('rs'), { small: true }),
      ],
    },
    {
      id: 'out', title: 'Save', open: true,
      blurb: 'Saves a JPEG at full resolution with all the settings above applied. Saving goes through the browser\'s own encoder, which also drops any camera metadata (EXIF, GPS…).',
      controls: [
        slider('out.quality', 'JPEG quality', 1, 100, 1, '', 'smaller file, more compression artefacts', 'bigger file, cleaner'),
        { type: 'export' },
      ],
    },
  ];

  /* ------------------------------------------------------- build panel */
  const controls = new Map(); // path → { spec, input, val, update }
  const panel = $('#panel');

  function digitsFor(step) { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; }
  function fmtVal(spec, v) {
    if (spec.pct) return Math.round(v * 100) + ' %';
    const d = digitsFor(spec.step);
    const sign = spec.min < 0 && v > 0 ? '+' : '';
    return sign + Number(v).toFixed(d) + (spec.unit ? ' ' + spec.unit : '');
  }
  function paintFill(input, spec, v) {
    const lo = +spec.min, hi = +spec.max;
    const pct = (x) => ((x - lo) / (hi - lo) * 100).toFixed(2) + '%';
    const zeroInRange = lo < 0 && hi > 0;
    const a = zeroInRange ? Math.min(0, v) : lo, b = zeroInRange ? Math.max(0, v) : v;
    input.style.setProperty('--fill', `linear-gradient(90deg, var(--line-2) 0 ${pct(a)}, var(--accent) ${pct(a)} ${pct(b)}, var(--line-2) ${pct(b)} 100%)`);
  }

  function buildSlider(spec) {
    const def = getPath(DEF, spec.path);
    const input = el('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: getPath(P, spec.path) });
    const val = el('button', { class: 'val', type: 'button', title: 'Click to reset to ' + fmtVal(spec, def) });
    const update = () => {
      const v = getPath(P, spec.path);
      input.value = v; val.textContent = fmtVal(spec, v);
      val.classList.toggle('changed', Math.abs(v - def) > 1e-9);
      paintFill(input, spec, v);
    };
    input.addEventListener('input', () => { setPath(P, spec.path, +input.value); update(); onParamChange(spec.path, 'quick'); });
    input.addEventListener('change', () => { setPath(P, spec.path, +input.value); update(); onParamChange(spec.path, 'full'); });
    input.addEventListener('dblclick', () => { setPath(P, spec.path, def); update(); onParamChange(spec.path, 'full'); });
    val.addEventListener('click', () => { setPath(P, spec.path, def); update(); onParamChange(spec.path, 'full'); });
    const wrap = el('div', { class: 'ctl' },
      el('div', { class: 'ctl-top' }, el('label', { text: spec.label }), val),
      input,
      el('div', { class: 'hint' }, el('span', { class: 'l', text: spec.hintL }), el('span', { class: 'r', text: spec.hintR })),
      spec.note ? el('div', { class: 'note', text: spec.note }) : null);
    controls.set(spec.path, { spec, input, update });
    update();
    return wrap;
  }
  function buildCheck(spec) {
    const input = el('input', { type: 'checkbox' });
    const update = () => { input.checked = !!getPath(P, spec.path); };
    input.addEventListener('change', () => { setPath(P, spec.path, input.checked); onParamChange(spec.path, 'full'); });
    controls.set(spec.path, { spec, input, update });
    update();
    return el('label', { class: 'check' }, input, el('div', {}, el('div', { class: 'lbl', text: spec.label }), spec.hint ? el('div', { class: 'hint single' }, el('span', { class: 'l', text: spec.hint })) : null));
  }
  function buildSelect(spec) {
    const sel = el('select', {}, ...spec.options.map(([v, t]) => el('option', { value: v, text: t })));
    const update = () => { sel.value = getPath(P, spec.path); };
    sel.addEventListener('change', () => { setPath(P, spec.path, sel.value); onParamChange(spec.path, 'full'); });
    controls.set(spec.path, { spec, input: sel, update });
    update();
    return el('div', { class: 'sel' }, el('label', { text: spec.label }), sel, spec.hint ? el('div', { class: 'hint single' }, el('span', { class: 'l', text: spec.hint })) : null);
  }
  function buildSeg(spec) {
    const btns = spec.options.map(([v, t]) => el('button', { type: 'button', text: t, 'data-v': v }));
    const update = () => { const cur = getPath(P, spec.path); btns.forEach((b) => b.classList.toggle('on', b.dataset.v === cur)); };
    btns.forEach((b) => b.addEventListener('click', () => { setPath(P, spec.path, b.dataset.v); update(); onParamChange(spec.path, 'full'); }));
    controls.set(spec.path, { spec, update });
    update();
    return el('div', { class: 'seg-ctl' }, el('div', { class: 'lbl', text: spec.label }), el('div', { class: 'segmented' }, ...btns), spec.hint ? el('div', { class: 'hint single' }, el('span', { class: 'l', text: spec.hint })) : null);
  }
  function buildSeed() {
    const num = el('input', { type: 'number', min: 0, max: 999999999, step: 1, value: P.seed });
    const update = () => { num.value = P.seed; };
    num.addEventListener('change', () => { P.seed = Math.max(0, Math.floor(+num.value || 0)); update(); onParamChange('seed', 'full'); });
    controls.set('seed', { spec: { path: 'seed' }, input: num, update });
    const reroll = el('button', { class: 'btn small', type: 'button', text: 'New random pattern', onclick: () => { P.seed = Math.floor(Math.random() * 1e9); update(); onParamChange('seed', 'full'); } });
    return el('div', {},
      el('div', { class: 'row' }, el('label', { class: 'lbl', text: 'Pattern number' }), num, reroll),
      el('div', { class: 'hint single' }, el('span', { class: 'l', text: 'All noise and drift in this tool comes from this number. Same number = same pattern, so results are repeatable. Change it for a different random pattern.' })));
  }
  function buildExport() {
    const dl = el('button', { class: 'btn primary', type: 'button', text: 'Download JPEG', onclick: downloadJpeg });
    const est = el('button', { class: 'btn', type: 'button', text: 'Estimate file size', onclick: estimateSize });
    const size = el('span', { class: 'readout', id: 'size-readout' });
    const reset = el('button', { class: 'btn small ghost', type: 'button', text: 'Reset everything', onclick: resetAll });
    const save = el('button', { class: 'btn small ghost', type: 'button', text: 'Save settings (.json)', onclick: saveSettings });
    const load = el('button', { class: 'btn small ghost', type: 'button', text: 'Load settings…', onclick: () => $('#settings-input').click() });
    return el('div', {},
      el('div', { class: 'row' }, dl, est, size),
      el('div', { class: 'readout', id: 'export-readout' }),
      el('div', { class: 'group' }, el('div', { class: 'group-title', text: 'Settings' }), el('div', { class: 'row' }, reset, save, load)),
    );
  }
  function buildControl(spec) {
    switch (spec.type) {
      case 'slider': return buildSlider(spec);
      case 'check': return buildCheck(spec);
      case 'select': return buildSelect(spec);
      case 'seg': return buildSeg(spec);
      case 'button': return el('div', { class: 'row' }, el('button', { class: 'btn' + (spec.small ? ' small ghost' : ''), type: 'button', text: spec.label, onclick: spec.onClick }));
      case 'note': return el('div', { class: 'note', text: spec.text });
      case 'group': return el('div', { class: 'group' }, el('div', { class: 'group-title' }, spec.swatch ? el('span', { class: 'swatch ' + spec.swatch }) : null, document.createTextNode(spec.title)));
      case 'readout': return el('div', { class: 'readout', id: spec.id });
      case 'seed': return buildSeed();
      case 'export': return buildExport();
    }
  }
  const sectionEls = new Map();
  for (const sec of SECTIONS) {
    const body = el('div', { class: 'section-body' }, el('p', { class: 'blurb', text: sec.blurb }), ...sec.controls.map(buildControl));
    const d = el('details', { class: 'section', id: 'sec-' + sec.id, open: !!sec.open },
      el('summary', {}, el('h2', { text: sec.title }), el('span', { class: 'badge', text: 'edited' })), body);
    panel.append(d);
    sectionEls.set(sec.id, d);
  }

  function syncAll() { for (const c of controls.values()) c.update(); markTouched(); updateInfo(); }
  function markTouched() {
    for (const [id, d] of sectionEls) {
      const a = JSON.stringify(P[id]), b = JSON.stringify(DEF[id]);
      d.classList.toggle('touched', id === 'out' ? false : a !== b);
    }
  }
  function resetSection(id) { P[id] = JSON.parse(JSON.stringify(DEF[id])); syncAll(); onParamChange(id, 'full'); }
  function resetAll() { for (const k of Object.keys(DEF)) P[k] = JSON.parse(JSON.stringify(DEF[k])); syncAll(); onParamChange('*', 'full'); }

  /* ----------------------------------------------------- param change */
  function onParamChange(path, mode) {
    markTouched();
    if (path.startsWith('out.')) { if (S.fullCache) estimateSize(); return; }
    S.fullCache = null;
    $('#size-readout').textContent = '';
    if (path.startsWith('rs.region')) { $('#ov').classList.toggle('active', P.rs.region.on); drawOverlay(); }
    updateInfo();
    schedule(mode);
  }

  /* ------------------------------------------------------- scheduling */
  // 'quick' renders a half-size preview while a slider is being dragged; 'full'
  // renders the proper preview on release (and a little after any quick render).
  function schedule(mode) {
    if (!S.full) return;
    S.pending = (mode === 'full' || S.pending === 'full') ? 'full' : 'quick';
    clearTimeout(S.timer); clearTimeout(S.fullTimer);
    S.timer = setTimeout(kick, 25);
  }
  async function kick() {
    if (S.rendering) return;
    const mode = S.pending; S.pending = null;
    if (!mode) return;
    S.rendering = true;
    try { await renderPreview(mode); } catch (e) { console.error(e); setStatus('Error: ' + e.message, true); }
    S.rendering = false;
    if (S.pending) kick();
    else if (mode === 'quick') S.fullTimer = setTimeout(() => schedule('full'), 180);
  }
  function setStatus(t, busy) { const s = $('#status'); s.textContent = t; s.classList.toggle('busy', !!busy); }

  async function renderPreview(mode) {
    const pv = (mode === 'quick' && S.previewQuick) ? S.previewQuick : S.previewFull;
    const t0 = performance.now();
    const img = await Pipeline.run(pv.img, P, pv.k, { status: (s) => setStatus(s, true), tick: raf });
    const dt = performance.now() - t0;
    S.lastResult = img; S.lastK = pv.k;
    S.lastResultRGBA = new ImageData(Pipeline.toRGBA(img), img.w, img.h);
    if (!S.comparing) paintCanvas(S.lastResultRGBA);
    setStatus(`${mode === 'quick' ? 'quick preview' : 'preview'} ${img.w}×${img.h} · ${dt.toFixed(0)} ms`);
  }
  function paintCanvas(imageData) {
    const cv = $('#cv');
    if (cv.width !== imageData.width || cv.height !== imageData.height) { cv.width = imageData.width; cv.height = imageData.height; }
    cv.getContext('2d').putImageData(imageData, 0, 0);
    layoutCanvas();
    drawOverlay();
  }

  /* ----------------------------------------------------------- layout */
  function layoutCanvas() {
    const cv = $('#cv'), view = $('#view');
    if (!cv.width) return;
    const aspect = cv.width / cv.height;
    if (S.zoom === 'fit') {
      const vw = view.clientWidth - 28, vh = view.clientHeight - 28;
      let w = vw, h = w / aspect;
      if (h > vh) { h = vh; w = h * aspect; }
      cv.style.width = Math.max(1, Math.floor(w)) + 'px'; cv.style.height = Math.max(1, Math.floor(h)) + 'px';
    } else {
      // "1:1" = one preview pixel per screen pixel (a quick half-size render is shown at the same size)
      const scale = S.previewFull ? S.previewFull.k / (S.lastK || S.previewFull.k) : 1;
      cv.style.width = Math.round(cv.width * scale) + 'px'; cv.style.height = Math.round(cv.height * scale) + 'px';
    }
    resizeOverlay();
  }
  new ResizeObserver(() => layoutCanvas()).observe($('#view'));
  $('#zoom-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.zoom = b.dataset.zoom;
    [...$('#zoom-seg').children].forEach((x) => x.classList.toggle('on', x === b));
    layoutCanvas();
  });

  /* --------------------------------------------------- region overlay */
  function resizeOverlay() {
    const ov = $('#ov'), cv = $('#cv');
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
    drawOverlay();
  }
  function drawOverlay() {
    const ov = $('#ov'); const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    const R = P.rs.region;
    if (!R.on || S.comparing) return;
    const x = R.x * ov.width, y = R.y * ov.height, w = R.w * ov.width, h = R.h * ov.height;
    ctx.fillStyle = 'rgba(4, 6, 14, 0.28)';
    ctx.beginPath(); ctx.rect(0, 0, ov.width, ov.height); ctx.rect(x, y, w, h); ctx.fill('evenodd');
    const dpr = window.devicePixelRatio || 1;
    ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = '#8b7cf6'; ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]); ctx.fillStyle = '#4f8cff';
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) { ctx.beginPath(); ctx.arc(px, py, 4 * dpr, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = 'rgba(232, 234, 247, 0.9)'; ctx.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText('region — drag to redraw', x + 6 * dpr, y - 6 * dpr < 10 * dpr ? y + h + 14 * dpr : y - 6 * dpr);
  }
  const ov = $('#ov');
  const ovPos = (e) => { const r = ov.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)]; };
  ov.addEventListener('pointerdown', (e) => {
    if (!P.rs.region.on) return;
    e.preventDefault(); ov.setPointerCapture(e.pointerId);
    S.drag = { start: ovPos(e) };
  });
  ov.addEventListener('pointermove', (e) => {
    if (!S.drag) return;
    const [x0, y0] = S.drag.start, [x1, y1] = ovPos(e);
    const R = P.rs.region;
    R.x = Math.min(x0, x1); R.y = Math.min(y0, y1); R.w = Math.max(0.02, Math.abs(x1 - x0)); R.h = Math.max(0.02, Math.abs(y1 - y0));
    for (const p of ['rs.region.x', 'rs.region.y', 'rs.region.w', 'rs.region.h']) controls.get(p).update();
    drawOverlay();
  });
  const endDrag = (e) => { if (!S.drag) return; S.drag = null; onParamChange('rs.region.rect', 'full'); };
  ov.addEventListener('pointerup', endDrag);
  ov.addEventListener('pointercancel', endDrag);

  /* ------------------------------------------------------------ compare */
  const cmpBtn = $('#btn-compare');
  function startCompare() {
    if (!S.srcPreviewRGBA || S.comparing) return;
    S.comparing = true; cmpBtn.classList.add('holding');
    paintCanvas(S.srcPreviewRGBA);
    setStatus('showing the untouched original');
  }
  function stopCompare() {
    if (!S.comparing) return;
    S.comparing = false; cmpBtn.classList.remove('holding');
    if (S.lastResultRGBA) paintCanvas(S.lastResultRGBA);
    setStatus('');
  }
  cmpBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startCompare(); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmpBtn.addEventListener(ev, stopCompare);
  window.addEventListener('keydown', (e) => { if ((e.key === 'c' || e.key === 'C') && !e.repeat && !isTyping(e)) startCompare(); });
  window.addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') stopCompare(); });
  window.addEventListener('blur', stopCompare);
  const isTyping = (e) => /^(input|select|textarea)$/i.test(e.target.tagName) && e.target.type !== 'range';

  /* ------------------------------------------------------------ loading */
  const MAX_PIXELS = 20e6;
  async function decode(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) {
      try { return await createImageBitmap(blob); }
      catch (e2) {
        const url = URL.createObjectURL(blob);
        try {
          const im = new Image(); im.src = url; await im.decode(); return im;
        } finally { URL.revokeObjectURL(url); }
      }
    }
  }
  async function loadBlob(blob, name) {
    showOverlay('Decoding image…');
    try {
      const bmp = await decode(blob);
      let w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
      let note = '';
      if (w * h > MAX_PIXELS) {
        const s = Math.sqrt(MAX_PIXELS / (w * h));
        w = Math.round(w * s); h = Math.round(h * s);
        note = ` (reduced from ${bmp.width}×${bmp.height} to stay within ${MAX_PIXELS / 1e6} megapixels)`;
      }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const d = ctx.getImageData(0, 0, w, h);
      S.full = Pipeline.fromRGBA(d.data, w, h);
      S.fullW = w; S.fullH = h; S.note = note;
      S.name = (name || 'image').replace(/\.[a-z0-9]+$/i, '');
      S.fullCache = null; $('#size-readout').textContent = '';
      buildPreviews(c);
      $('#empty').hidden = true; $('#canvas-wrap').hidden = false;
      updateInfo();
      schedule('full');
    } catch (e) {
      console.error(e);
      alert('Could not read that file as an image.');
    } finally { hideOverlay(); }
  }
  // Downscaled working copies: "full" preview at the chosen size, "quick" at half of it.
  function buildPreviews(fullCanvas) {
    const W = S.fullW, H = S.fullH;
    const maxL = S.previewMax === 'full' ? Infinity : S.previewMax;
    const kFull = Math.min(1, maxL / Math.max(W, H));
    const make = (k) => {
      const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
      if (k === 1) return { img: S.full, k: 1, canvas: fullCanvas };
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(fullCanvas, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h);
      return { img: Pipeline.fromRGBA(d.data, w, h), k: w / W };
    };
    S.previewFull = make(kFull);
    const quickK = Math.max(W, H) * kFull > 480 ? kFull * 0.5 : kFull;
    S.previewQuick = quickK === kFull ? null : make(quickK);
    S.srcPreviewRGBA = new ImageData(Pipeline.toRGBA(S.previewFull.img), S.previewFull.img.w, S.previewFull.img.h);
    S.fullCanvas = fullCanvas;
  }
  $('#preview-size').addEventListener('change', (e) => {
    S.previewMax = e.target.value === 'full' ? 'full' : +e.target.value;
    if (S.fullCanvas) { buildPreviews(S.fullCanvas); schedule('full'); }
  });

  $('#btn-open').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadBlob(f, f.name); e.target.value = ''; });
  const view = $('#view');
  for (const ev of ['dragenter', 'dragover']) view.addEventListener(ev, (e) => { e.preventDefault(); view.classList.add('dragover'); });
  for (const ev of ['dragleave', 'drop']) view.addEventListener(ev, (e) => { e.preventDefault(); view.classList.remove('dragover'); });
  view.addEventListener('drop', (e) => { const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/')); if (f) loadBlob(f, f.name); });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { const f = item.getAsFile(); if (f) loadBlob(f, 'pasted-image'); }
  });

  // A synthetic test picture: gradients, fine lines, text-like strokes and colour patches.
  $('#btn-test').addEventListener('click', async () => {
    const w = 1600, h = 1100;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#2b3a67'); g.addColorStop(0.5, '#7c6cf5'); g.addColorStop(1, '#f5b26c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const rnd = Pipeline.mulberry32(7);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `hsla(${rnd() * 360}, 70%, ${40 + rnd() * 40}%, ${0.5 + rnd() * 0.5})`;
      ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, 20 + rnd() * 160, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    for (let x = 100; x < 700; x += 4) { ctx.beginPath(); ctx.moveTo(x, 800); ctx.lineTo(x, 1050); ctx.stroke(); }
    ctx.lineWidth = 2; ctx.strokeStyle = '#111';
    for (let y = 820; y < 1050; y += 9) { ctx.beginPath(); ctx.moveTo(760, y); ctx.lineTo(1500, y + 30); ctx.stroke(); }
    ctx.fillStyle = '#fff'; ctx.font = 'bold 120px sans-serif'; ctx.fillText('editor-v', 90, 220);
    ctx.font = '28px sans-serif'; ctx.fillText('fine detail · textures · big shapes', 95, 280);
    ctx.fillStyle = '#000'; ctx.fillRect(1200, 80, 300, 300);
    ctx.fillStyle = '#fff'; ctx.fillRect(1230, 110, 240, 240);
    for (let i = 0; i < 12; i++) { ctx.fillStyle = `hsl(${i * 30}, 90%, 55%)`; ctx.fillRect(1230 + i * 20, 110, 20, 60); }
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    loadBlob(blob, 'test-image');
  });

  /* --------------------------------------------------------------- info */
  function updateInfo() {
    const info = $('#info');
    if (!S.full) { info.textContent = ''; return; }
    const o = Pipeline.outputSize(S.fullW, S.fullH, P);
    const trimmed = o.frame.w !== S.fullW || o.frame.h !== S.fullH;
    info.textContent = `${S.name} · source ${S.fullW}×${S.fullH}${S.note} · output ${o.w}×${o.h}` +
      (trimmed ? ` · frame trimmed to ${o.frame.w}×${o.frame.h} (${Math.round(o.frame.w * o.frame.h / (S.fullW * S.fullH) * 100)}% of the area)` : '');
    const fr = $('#frame-readout');
    if (fr) fr.textContent = `Frame: ${o.frame.w} × ${o.frame.h} px` + (trimmed ? ` (from ${S.fullW} × ${S.fullH})` : ' (nothing trimmed)');
  }

  /* ------------------------------------------------------------- export */
  function showOverlay(t) { $('#overlay-text').textContent = t; $('#overlay').hidden = false; }
  function hideOverlay() { $('#overlay').hidden = true; }
  function exportKey() { const q = JSON.parse(JSON.stringify(P)); delete q.out; q.freq.view = 'full'; return JSON.stringify(q); }
  async function buildFull() {
    const key = exportKey();
    if (S.fullCache && S.fullCache.key === key) return S.fullCache.img;
    showOverlay('Rendering at full size…');
    await raf();
    try {
      const img = await Pipeline.run(S.full, P, 1, { status: (s) => { $('#overlay-text').textContent = s; }, tick: raf, forExport: true });
      S.fullCache = { key, img };
      return img;
    } finally { hideOverlay(); }
  }
  function toJpegBlob(img, quality) {
    const c = document.createElement('canvas'); c.width = img.w; c.height = img.h;
    c.getContext('2d').putImageData(new ImageData(Pipeline.toRGBA(img), img.w, img.h), 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => b ? res(b) : rej(new Error('JPEG encoding failed')), 'image/jpeg', P.out.quality / 100));
  }
  async function estimateSize() {
    if (!S.full) return;
    const img = await buildFull();
    const blob = await toJpegBlob(img, P.out.quality);
    $('#size-readout').textContent = `≈ ${fmtBytes(blob.size)} at quality ${P.out.quality}`;
    $('#export-readout').textContent = `Output ${img.w} × ${img.h} px`;
  }
  async function downloadJpeg() {
    if (!S.full) { alert('Open an image first.'); return; }
    const img = await buildFull();
    const blob = await toJpegBlob(img, P.out.quality);
    $('#size-readout').textContent = `≈ ${fmtBytes(blob.size)} at quality ${P.out.quality}`;
    $('#export-readout').textContent = `Saved ${img.w} × ${img.h} px`;
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `${S.name}-edit-q${P.out.quality}.jpg` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ----------------------------------------------------------- settings */
  function saveSettings() {
    const blob = new Blob([JSON.stringify(P, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'editor-v-settings.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function mergeInto(target, src, def) {
    for (const k of Object.keys(def)) {
      if (!(k in src)) continue;
      if (def[k] && typeof def[k] === 'object') { if (src[k] && typeof src[k] === 'object') mergeInto(target[k], src[k], def[k]); }
      else if (typeof def[k] === 'number') { if (typeof src[k] === 'number' && isFinite(src[k])) target[k] = src[k]; }
      else if (typeof def[k] === 'boolean') target[k] = !!src[k];
      else if (typeof def[k] === 'string') { if (typeof src[k] === 'string') target[k] = src[k]; }
    }
  }
  $('#settings-input').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      mergeInto(P, j, DEF);
      for (const c of controls.values()) if (c.spec.type === 'slider') setPath(P, c.spec.path, clamp(getPath(P, c.spec.path), c.spec.min, c.spec.max));
      if (!Pipeline.KERNELS[P.rs.kernel] && P.rs.kernel !== 'browser') P.rs.kernel = DEF.rs.kernel;
      if (!Pipeline.KERNELS[P.rs.region.kernel] && P.rs.region.kernel !== 'browser') P.rs.region.kernel = DEF.rs.region.kernel;
      if (!['full', 'low', 'mid', 'high'].includes(P.freq.view)) P.freq.view = 'full';
      syncAll();
      $('#ov').classList.toggle('active', P.rs.region.on);
      onParamChange('*', 'full');
    } catch (err) { alert('That file is not a valid settings file.'); }
  });

  /* --------------------------------------------------------------- init */
  syncAll();
  setStatus('open an image to begin');
})();
