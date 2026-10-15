/* editor-v — app.js
   Step-by-step UI: one tab per stage. Each tab previews the working image plus
   that tab's settings only; "Apply step" bakes the stage into the working
   image at full resolution (optionally re-sampling afterwards), so every later
   stage starts from real, re-interpolated pixels. Everything runs in this page;
   there is no network code anywhere in this file. */
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
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const usedNames = new Set();
  function exportName() {
    let n; do { n = String(1000 + Math.floor(Math.random() * 9000)); } while (usedNames.has(n) && usedNames.size < 9000);
    usedNames.add(n); return n;
  }
  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 4200);
  }

  /* ------------------------------------------------------------- state */
  const DEF = Pipeline.defaults();
  const P = Pipeline.defaults();
  const S = {
    name: 'image', fileName: '', lastSaved: '', note: '',
    original: null,                 // the image as loaded (full resolution)
    work: null, workVersion: 0,     // the working image: original + applied steps
    steps: [],                      // labels of applied steps
    undo: [],                       // previous working images, newest last (capped)
    tab: 'ch',
    previewFull: null, previewQuick: null, srcPreviewRGBA: null,
    lastResult: null, lastResultRGBA: null, lastK: 1,
    zoom: 'fit', previewMax: 1000, comparing: false, view: 'result',
    fullCache: null,
    rendering: false, pending: null, timer: null, fullTimer: null,
    wf: { resample: true, pct: 97, kernel: 'lanczos3' },   // "then resample" after each applied step
  };
  const UNDO_MAX = 3;

  /* ---------------------------------------------------- browser scaler */
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
  const toneControls = () => {
    const out = [];
    for (const [c, name, sw, opp] of [['r', 'Red', 'swatch-r', 'cyan'], ['g', 'Green', 'swatch-g', 'magenta'], ['b', 'Blue', 'swatch-b', 'yellow']]) {
      const n = name.toLowerCase();
      out.push(group(name + ' channel', sw));
      out.push(slider(`tone.${c}.shadows`, `${name} — shadows`, -30, 30, 0.5, '', `dark areas lose ${n} (lean ${opp})`, `dark areas gain ${n}`));
      out.push(slider(`tone.${c}.midtones`, `${name} — midtones`, -50, 50, 1, '', `mid tones lose ${n} (lean ${opp})`, `mid tones gain ${n}`));
      out.push(slider(`tone.${c}.highlights`, `${name} — highlights`, -50, 50, 1, '', `bright areas lose ${n} (lean ${opp})`, `bright areas gain ${n}`));
    }
    return out;
  };
  const reseed = () => { P.seed = Math.floor(Math.random() * 1e9); for (const c of controls.values()) if (c.spec.path === 'seed') c.update(); onParamChange('seed', 'full'); };
  const bandControls = (b, title, strengthL, strengthR, noiseWord) => [
    group(title),
    slider(`freq.${b}.gain`, 'Strength', -100, 200, 1, '%', strengthL, strengthR),
    slider(`freq.${b}.noise`, 'Add noise', 0, 40, 0.5, 'levels', 'no noise added', `more random ${noiseWord} in this layer`),
    slider(`freq.${b}.blur`, 'Blur this layer', 0, 12, 0.1, 'px', 'layer stays as it is', 'layer smears more'),
    slider(`freq.${b}.smooth`, 'Smooth this layer', 0, 100, 1, '', 'untouched', 'evens out small bumps but keeps this layer\'s strong edges'),
  ];

  const SECTIONS = [
    {
      id: 'ch', tab: 'Channels', title: 'Colour channel shifts',
      blurb: 'Moves and zooms the red, green and blue layers separately, like the colour fringing of a cheap lens. Any edge that ends up missing a colour is trimmed off automatically, so no smeared borders.',
      controls: [...channelControls()],
    },
    {
      id: 'tone', tab: 'Tone', title: 'Tone per channel',
      blurb: 'Brightness curves for red, green and blue separately: shadows, midtones and highlights each get their own control. Small opposite moves on two channels give a faint colour cast that changes every pixel value without looking edited.',
      controls: [...toneControls()],
    },
    {
      id: 'freq', tab: 'Bands', title: 'Frequency bands (detail layers)',
      blurb: 'Splits the picture into three layers by the size of detail: Fine (grain, hair, edges), Medium (textures, small shapes) and Coarse (big shapes, lighting). Each layer can be boosted or cut, blurred, smoothed, or given its own noise.',
      controls: [
        slider('freq.fine', 'Fine ↔ medium boundary', 0.5, 8, 0.1, 'px', 'fine layer keeps only the tiniest detail', 'fine layer takes in bigger detail too'),
        slider('freq.coarse', 'Medium ↔ coarse boundary', 4, 80, 0.5, 'px', 'coarse layer holds only the very largest shapes', 'coarse layer swallows more mid-size shapes'),
        seg('freq.view', 'Show in the preview', [['full', 'Everything'], ['low', 'Coarse'], ['mid', 'Medium'], ['high', 'Fine']],
          'Look at one layer on its own to understand what you are editing. Applying and saving always use everything.'),
        check('freq.colorNoise', 'Colour noise', 'On: each colour channel gets its own noise pattern (coloured speckle). Off: the same pattern on all three (neutral grain).'),
        ...bandControls('low', 'Coarse layer — big shapes & lighting', 'big shapes flatten toward an even tone', 'big shapes get more contrast', 'soft blotches'),
        ...bandControls('mid', 'Medium layer — textures & small shapes', 'textures fade away', 'textures stand out harder', 'speckle'),
        ...bandControls('high', 'Fine layer — grain, hair & edges', 'fine detail softens away', 'fine detail sharpens, grain shows', 'fine grain'),
        button('New random pattern', reseed, { small: true }),
      ],
    },
    {
      id: 'grad', tab: 'Gradient', title: 'Gradient perturbation',
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
        button('New random pattern', reseed, { small: true }),
      ],
    },
    {
      id: 'jig', tab: 'Jigsaw', title: 'Invisible jigsaw (block swapping)',
      blurb: 'Finds flat blocks (sky, walls, skin, bokeh) and swaps each with a similar flat block nearby. By default only the grain moves: every block keeps its own average colour, so the swap is invisible even across gentle gradients, yet the pixel layout is different.',
      controls: [
        check('jig.on', 'Swap flat blocks', 'Turns the jigsaw on. Nothing happens to blocks that have visible texture or edges in them.'),
        slider('jig.block', 'Block size', 4, 64, 1, 'px', 'small tiles, many of them, easier to find matches', 'big tiles, fewer swaps, each moving more pixels'),
        slider('jig.homog', 'How flat a block must be', 0, 30, 0.5, 'levels', 'only perfectly flat blocks qualify', 'blocks with some grain or soft shading also qualify'),
        slider('jig.tol', 'How similar two blocks must be', 0, 60, 1, 'levels', 'only near-identical tones are swapped', 'tones may differ more (safe when "keep tone" is on)'),
        slider('jig.radius', 'Search distance', 1, 20, 1, 'blocks', 'partners come from right next door', 'partners can come from further away'),
        slider('jig.amount', 'How many to swap', 0, 100, 1, '%', 'swap almost none of the matching blocks', 'swap every matching block'),
        check('jig.keepTone', 'Keep each block\'s average tone (swap only the grain)', 'On: the moved block is shifted to the average colour of its new spot, so nothing is visible. Off: the raw pixels move; needs a low "similar" setting to stay invisible.'),
        check('jig.flip', 'Also flip the swapped blocks randomly', 'Mirrors some moved blocks left-right or top-bottom. Harmless on flat areas, visible on anything with structure.'),
        seg('jig.view', 'Show in the preview', [['normal', 'Result'], ['highlight', 'Outline swapped blocks']], 'Outlines are preview-only; applying and saving never include them. The preview is a smaller image, so the exact set of swapped blocks differs at full size.'),
        readout('jig-readout'),
        button('New random pattern', reseed, { small: true }),
      ],
    },
    {
      id: 'fourier', tab: 'Phase', title: 'Phase shift (Fourier translation)',
      blurb: 'Moves the whole picture by a fraction of a pixel in the frequency domain: every pixel is rebuilt from a phase-shifted spectrum (sinc interpolation), which is the mathematically exact band-limited shift. Visually identical, but every pixel value changes in a way no ordinary resize produces. The thin edge that would wrap around is trimmed off.',
      controls: [
        slider('fourier.x', 'Sideways', -3, 3, 0.01, 'px', 'picture moves left', 'picture moves right', { note: 'Whole numbers move pixels exactly; fractions such as 0.5 are what make this do something.' }),
        slider('fourier.y', 'Up / down', -3, 3, 0.01, 'px', 'picture moves up', 'picture moves down'),
      ],
    },
    {
      id: 'interp', tab: 'Interp', title: 'Interpolation forcing',
      blurb: 'Re-reads every pixel from a slightly different position: a global fraction-of-a-pixel shift, a tiny smooth random warp and an optional per-pixel jitter, so each output pixel is a fresh blend of its neighbours at its own phase.',
      controls: [
        slider('interp.x', 'Sideways shift', -1, 1, 0.01, 'px', 'picture moves left', 'picture moves right', { note: '0.5 px forces the strongest blending; 0 or ±1 blends nothing.' }),
        slider('interp.y', 'Up / down shift', -1, 1, 0.01, 'px', 'picture moves up', 'picture moves down'),
        slider('interp.warp', 'Random warp', 0, 3, 0.05, 'px', 'no warp, the shift is the same everywhere', 'pixels drift up to this far in slowly varying directions'),
        slider('interp.warpCell', 'Warp patch size', 10, 600, 5, 'px', 'wobbly, small patches', 'broad, gentle bends'),
        slider('interp.jitter', 'Per-pixel jitter', 0, 0.5, 0.01, 'px', 'every pixel sampled from the same offset', 'each pixel sampled from its own random offset (breaks any regular grid)'),
        select('interp.kernel', 'Interpolation method', [['bilinear', 'Bilinear — soft, 4 neighbours'], ['bicubic', 'Bicubic (Catmull-Rom) — sharp, 16 neighbours'], ['lanczos3', 'Lanczos-3 — sharpest, 36 neighbours, slow']], 'Which neighbours each new pixel is blended from.'),
        button('New random pattern', reseed, { small: true }),
      ],
    },
    {
      id: 'geo', tab: 'Frame', title: 'Frame — micro crop, tilt & rotate',
      blurb: 'Fine adjustments to the framing. The frame always shrinks to the area that has real picture in it, so you never get empty, black or white corners.',
      controls: [
        slider('geo.rotate', 'Rotate', -15, 15, 0.05, '°', 'turns the picture anticlockwise', 'turns the picture clockwise'),
        slider('geo.tiltX', 'Tilt top / bottom', -15, 15, 0.1, '°', 'top edge leans away (top looks narrower)', 'bottom edge leans away (bottom looks narrower)'),
        slider('geo.tiltY', 'Tilt left / right', -15, 15, 0.1, '°', 'right edge leans away (right looks shorter)', 'left edge leans away (left looks shorter)'),
        slider('geo.crop', 'Trim edges', 0, 25, 0.1, '%', 'keep the whole valid area', 'cut more off every side'),
        slider('geo.posX', 'Window position — sideways', -100, 100, 1, '', 'window slides left (keeps more of the left side)', 'window slides right (keeps more of the right side)', { note: 'Only does something once some edge has been trimmed.' }),
        slider('geo.posY', 'Window position — up / down', -100, 100, 1, '', 'window slides up (keeps more of the top)', 'window slides down (keeps more of the bottom)'),
        check('geo.restoreSize', 'Stretch the result back to the current pixel size', 'On: the trimmed frame is scaled up so the image keeps its width and height (uses the resampling method from the Resample tab). Off: the image simply gets smaller.'),
        readout('frame-readout'),
      ],
    },
    {
      id: 'rs', tab: 'Resample', title: 'Resampling',
      blurb: 'Re-computes every pixel by scaling the picture to a temporary size and straight back. The dimensions stay the same, but each pixel value is re-interpolated. (The "then resample" option below every Apply does the same thing automatically after each step.)',
      controls: [
        select('rs.kernel', 'Method (quality / kernel)', KERNEL_OPTIONS, 'Sharper methods keep more detail; softer ones smear fine detail. Also used by the Frame tab\'s "stretch back" option.'),
        slider('rs.roundTrip', 'Temporary size', 25, 200, 1, '%', 'shrinks then enlarges back: loses fine detail, softer', 'enlarges then shrinks back: keeps detail, subtler change', { note: '100% = off. Every other value re-interpolates the whole picture.' }),
        slider('rs.outScale', 'Final size', 10, 200, 1, '%', 'image gets smaller', 'image gets bigger'),
      ],
    },
    {
      id: 'bayer', tab: 'Sensor', title: 'Sensor grid (Bayer)',
      blurb: 'Re-samples the picture the way a camera sensor sees it: each pixel keeps only one colour in a 2×2 red-green-green-blue mosaic, then the missing colours are rebuilt from the neighbours (demosaicing). The picture looks the same, but a sensor-like grid structure is stamped into every pixel.',
      controls: [
        check('bayer.on', 'Re-sample through a Bayer mosaic', 'Turns the sensor simulation on.'),
        seg('bayer.pattern', 'Mosaic layout', [['rggb', 'RGGB'], ['bggr', 'BGGR'], ['grbg', 'GRBG'], ['gbrg', 'GBRG']], 'Which colour sits top-left in each 2×2 cell. Same effect, different grid phase.'),
        select('bayer.method', 'Rebuild method (demosaic)', [['mhc', 'Gradient-corrected (Malvar-He-Cutler) — what cameras use'], ['bilinear', 'Bilinear — softer, more colour fringing on edges']], 'How the two missing colours of each pixel are estimated from its neighbours.'),
        slider('bayer.mix', 'Amount', 0, 100, 1, '%', 'original pixels', 'fully re-sampled through the mosaic'),
        group('Ordered dither (Bayer matrix)'),
        slider('bayer.dither', 'Dither strength', 0, 8, 0.25, 'levels', 'no pattern', 'stronger fixed checker-like pattern locked to the pixel grid'),
        seg('bayer.ditherSize', 'Pattern size', [[2, '2 × 2'], [4, '4 × 4'], [8, '8 × 8']], 'How many pixels the threshold pattern repeats over.'),
        check('bayer.ditherColor', 'Different pattern phase per colour channel', 'On: the pattern is offset for green and blue, giving a faint colour texture instead of a grey one.'),
        note('The preview is a reduced image, so the grid there is only indicative; applying and saving put the exact 2 × 2 pattern on the real pixels.'),
      ],
    },
    {
      id: 'out', tab: 'Save', title: 'Save & steps',
      blurb: 'Saves the working image as a JPEG at full resolution. Saving goes through the browser\'s own encoder, which also drops any camera metadata (EXIF, GPS…). The Download button on the top bar does the same from any tab.',
      controls: [
        slider('out.quality', 'JPEG quality', 1, 100, 1, '', 'smaller file, more compression artefacts', 'bigger file, cleaner'),
        { type: 'export' },
      ],
    },
  ];
  const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));

  /* ------------------------------------------------------- build panel */
  const controls = new Map(); // path → { spec, update }
  const panel = $('#panel');

  function digitsFor(step) { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; }
  function fmtVal(spec, v) {
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
    const input = el('input', { type: 'range', id: 'ctl-' + spec.path.replace(/\./g, '-'), min: spec.min, max: spec.max, step: spec.step, value: getPath(P, spec.path) });
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
    controls.set(spec.path, { spec, update });
    update();
    return el('div', { class: 'ctl' },
      el('div', { class: 'ctl-top' }, el('label', { for: input.id, text: spec.label }), val),
      input,
      el('div', { class: 'hint' }, el('span', { class: 'l', text: spec.hintL }), el('span', { class: 'r', text: spec.hintR })),
      spec.note ? el('div', { class: 'note', text: spec.note }) : null);
  }
  function buildCheck(spec) {
    const input = el('input', { type: 'checkbox', id: 'ctl-' + spec.path.replace(/\./g, '-') });
    const update = () => { input.checked = !!getPath(P, spec.path); };
    input.addEventListener('change', () => { setPath(P, spec.path, input.checked); onParamChange(spec.path, 'full'); });
    controls.set(spec.path, { spec, update });
    update();
    return el('label', { class: 'check' }, input, el('div', {}, el('div', { class: 'lbl', text: spec.label }), spec.hint ? el('div', { class: 'hint single' }, el('span', { class: 'l', text: spec.hint })) : null));
  }
  function buildSelect(spec) {
    const sel = el('select', { id: 'ctl-' + spec.path.replace(/\./g, '-') }, ...spec.options.map(([v, t]) => el('option', { value: v, text: t })));
    const update = () => { sel.value = getPath(P, spec.path); };
    sel.addEventListener('change', () => { setPath(P, spec.path, sel.value); onParamChange(spec.path, 'full'); });
    controls.set(spec.path, { spec, update });
    update();
    return el('div', { class: 'sel' }, el('label', { for: sel.id, text: spec.label }), sel, spec.hint ? el('div', { class: 'hint single' }, el('span', { class: 'l', text: spec.hint })) : null);
  }
  function buildSeg(spec) {
    const btns = spec.options.map(([v, t]) => el('button', { type: 'button', text: t, 'data-v': String(v) }));
    const update = () => { const cur = String(getPath(P, spec.path)); btns.forEach((b) => b.classList.toggle('on', b.dataset.v === cur)); };
    btns.forEach((b, i) => b.addEventListener('click', () => { setPath(P, spec.path, spec.options[i][0]); update(); onParamChange(spec.path, 'full'); }));
    controls.set(spec.path, { spec, update });
    update();
    return el('div', { class: 'seg-ctl' }, el('div', { class: 'lbl', text: spec.label }), el('div', { class: 'segmented' }, ...btns), spec.hint ? el('div', { class: 'hint single' }, el('span', { class: 'l', text: spec.hint })) : null);
  }
  function buildSeed() {
    const num = el('input', { type: 'number', id: 'ctl-seed', min: 0, max: 999999999, step: 1, value: P.seed });
    const update = () => { num.value = P.seed; };
    num.addEventListener('change', () => { P.seed = Math.max(0, Math.floor(+num.value || 0)); update(); onParamChange('seed', 'full'); });
    controls.set('seed', { spec: { path: 'seed' }, update });
    const reroll = el('button', { class: 'btn small', type: 'button', text: 'New random pattern', onclick: reseed });
    return el('div', {},
      el('div', { class: 'row' }, el('label', { class: 'lbl', for: 'ctl-seed', text: 'Random pattern number' }), num, reroll),
      el('div', { class: 'hint single' }, el('span', { class: 'l', text: 'All noise, drift, warp and block-swap choices come from this number. Same number = same result, so a step is repeatable.' })));
  }
  function buildExport() {
    const dl = el('button', { class: 'btn primary', type: 'button', text: 'Download JPEG', onclick: downloadJpeg });
    const est = el('button', { class: 'btn', type: 'button', text: 'Estimate file size', onclick: estimateSize });
    const size = el('span', { class: 'readout', id: 'size-readout' });
    const rt = el('button', { class: 'btn', type: 'button', text: 'Encode to JPEG and keep editing', onclick: jpegRoundTrip });
    const reset = el('button', { class: 'btn small ghost', type: 'button', text: 'Reset all pending settings', onclick: resetAll });
    const save = el('button', { class: 'btn small ghost', type: 'button', text: 'Save settings (.json)', onclick: saveSettings });
    const load = el('button', { class: 'btn small ghost', type: 'button', text: 'Load settings…', onclick: () => $('#settings-input').click() });
    return el('div', {},
      el('div', { class: 'row' }, dl, est, size),
      el('div', { class: 'readout', id: 'export-readout' }),
      el('div', { class: 'group' },
        el('div', { class: 'group-title', text: 'JPEG round trip' }),
        el('div', { class: 'row' }, rt),
        el('div', { class: 'hint single' }, el('span', { class: 'l', text: 'Encodes the working image as a JPEG at the quality above and decodes it straight back, so the compression itself becomes part of the image before the next step. Same as downloading and re-opening the file, without leaving the page.' }))),
      el('div', { class: 'group' }, el('div', { class: 'group-title', text: 'Applied steps' }), el('ol', { class: 'steps', id: 'steps-list' })),
      el('div', { class: 'group' }, el('div', { class: 'group-title', text: 'Random pattern' }), buildSeed()),
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
      case 'export': return buildExport();
    }
  }

  // tab strip + one body per section
  const tabButtons = new Map(), tabBodies = new Map();
  const tabStrip = el('nav', { class: 'tabs', 'aria-label': 'Steps' });
  for (const sec of SECTIONS) {
    const b = el('button', { type: 'button', class: 'tab', 'data-tab': sec.id, onclick: () => showTab(sec.id) },
      el('span', { class: 'tab-name', text: sec.tab }), el('span', { class: 'tab-dot', title: 'has unapplied changes' }));
    tabStrip.append(b); tabButtons.set(sec.id, b);
    const body = el('section', { class: 'tab-body', id: 'sec-' + sec.id, hidden: true },
      el('h2', { text: sec.title }), el('p', { class: 'blurb', text: sec.blurb }), ...sec.controls.map(buildControl));
    tabBodies.set(sec.id, body);
  }
  const bodyWrap = el('div', { class: 'tab-bodies' }, ...tabBodies.values());

  // apply bar
  const applyBtn = el('button', { class: 'btn primary', type: 'button', id: 'btn-apply', text: 'Apply step', onclick: applyStep });
  const dlStepBtn = el('button', { class: 'btn', type: 'button', id: 'btn-download-step', text: 'Download JPEG', title: 'Save what the preview shows, right now, without applying. You can stop at any step.', onclick: downloadJpeg });
  const resetBtn = el('button', { class: 'btn small ghost', type: 'button', text: 'Reset tab', onclick: () => resetSection(S.tab) });
  const wfCheck = el('input', { type: 'checkbox', id: 'wf-resample' }); wfCheck.checked = S.wf.resample;
  const wfPct = el('input', { type: 'number', id: 'wf-pct', min: 25, max: 200, step: 1, value: S.wf.pct, class: 'narrow' });
  const wfKernel = el('select', { id: 'wf-kernel' }, ...KERNEL_OPTIONS.filter(([v]) => v !== 'browser').map(([v, t]) => el('option', { value: v, text: t.split(' — ')[0] })));
  wfKernel.value = S.wf.kernel;
  wfCheck.addEventListener('change', () => { S.wf.resample = wfCheck.checked; });
  wfPct.addEventListener('change', () => { S.wf.pct = clamp(Math.round(+wfPct.value || 97), 25, 200); wfPct.value = S.wf.pct; });
  wfKernel.addEventListener('change', () => { S.wf.kernel = wfKernel.value; });
  const undoBtn = el('button', { class: 'btn small ghost', type: 'button', id: 'btn-undo', text: 'Undo last step', onclick: undoStep });
  const revertBtn = el('button', { class: 'btn small ghost', type: 'button', id: 'btn-revert', text: 'Revert to original', onclick: revertAll });
  const applyRows = el('div', { id: 'apply-rows' },
    el('div', { class: 'row' }, applyBtn, dlStepBtn, resetBtn),
    el('div', { class: 'row' }, el('label', { class: 'wf' }, wfCheck, document.createTextNode(' then resample via '), wfPct, document.createTextNode(' % '), wfKernel)),
    el('div', { class: 'hint single' }, el('span', { class: 'l', text: 'Download saves what you see at full size — no need to apply or go further. Apply bakes this tab into the pixels and clears its sliders; "then resample" re-interpolates every pixel afterwards.' })));
  const applyBar = el('div', { class: 'apply-bar', id: 'apply-bar' },
    applyRows,
    el('div', { class: 'row work-row' }, el('span', { class: 'readout', id: 'work-readout' }), undoBtn, revertBtn));
  panel.append(tabStrip, bodyWrap, applyBar);

  function showTab(id) {
    S.tab = id;
    for (const [k, b] of tabButtons) b.classList.toggle('on', k === id);
    for (const [k, body] of tabBodies) body.hidden = k !== id;
    applyRows.hidden = id === 'out';
    S.fullCache = null;
    updateTabDots(); updateInfo();
    bodyWrap.scrollTop = 0; panel.scrollTop = 0;
    schedule('full');
  }
  function tabPending(id) { return id !== 'out' && JSON.stringify(P[id]) !== JSON.stringify(DEF[id]); }
  function updateTabDots() { for (const [k, b] of tabButtons) b.classList.toggle('pending', tabPending(k)); }
  function syncAll() { for (const c of controls.values()) c.update(); updateTabDots(); updateInfo(); }
  function resetSection(id) { if (id === 'out') return; P[id] = deep(DEF[id]); syncAll(); onParamChange(id, 'full'); }
  function resetAll() { for (const k of Object.keys(DEF)) if (k !== 'out') P[k] = deep(DEF[k]); syncAll(); onParamChange('*', 'full'); }

  // a short human description of a tab's non-default settings
  function describe(id) {
    const parts = [];
    const walk = (a, b, prefix) => {
      for (const k of Object.keys(b)) {
        if (a[k] && typeof a[k] === 'object') walk(a[k], b[k], prefix + k + '.');
        else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) parts.push(prefix + k + '=' + (typeof a[k] === 'number' ? +a[k].toFixed(3) : a[k]));
      }
    };
    walk(P[id], DEF[id], '');
    return parts.filter((s) => !/\.view=|^view=/.test(s)).join(', ');
  }

  /* ----------------------------------------------------- param change */
  function onParamChange(path, mode) {
    updateTabDots();
    if (path.startsWith('out.')) { if (S.fullCache) estimateSize(); return; }
    S.fullCache = null;
    $('#size-readout').textContent = '';
    updateInfo();
    schedule(mode);
  }

  /* ------------------------------------------------------- scheduling */
  function schedule(mode) {
    if (!S.work) return;
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
    const img = S.tab === 'out' ? pv.img : await Pipeline.runStage(pv.img, S.tab, P, pv.k, { status: (s) => setStatus(s, true), tick: raf });
    const dt = performance.now() - t0;
    S.lastResult = img; S.lastK = pv.k;
    const jr = $('#jig-readout');
    if (jr) jr.textContent = P.jig.on ? (img.jigStats ? `Preview: ${img.jigStats.swaps} pairs swapped out of ${img.jigStats.eligible} flat blocks (${img.jigStats.blocks} total)` : 'Preview: no matching flat blocks found with these settings') : '';
    let shown = img, extra = '';
    if (S.view !== 'result') {
      const d = diffImage(pv.img, img, S.view === 'diff32' ? 32 : 8);
      if (d) { shown = d.img; extra = ` · changed ${d.changed}% of pixel values · mean ${d.mean} · max ${d.max} levels`; }
      else extra = ' · sizes differ, difference view not possible for this step';
    }
    S.lastResultRGBA = new ImageData(Pipeline.toRGBA(shown), shown.w, shown.h);
    if (!S.comparing) paintCanvas(S.lastResultRGBA);
    setStatus(`${mode === 'quick' ? 'quick preview' : 'preview'} ${img.w}×${img.h} · ${dt.toFixed(0)} ms${extra}`);
  }
  // |after − before| per channel, amplified; plus how many 8-bit values moved
  function diffImage(before, after, gain) {
    if (before.w !== after.w || before.h !== after.h) return null;
    const n = before.w * before.h, out = Pipeline.makeImage(before.w, before.h);
    let sum = 0, changed = 0, max = 0;
    for (const c of ['r', 'g', 'b']) {
      const a = before[c], b = after[c], o = out[c];
      for (let i = 0; i < n; i++) {
        const qa = Math.round(Math.max(0, Math.min(255, a[i]))), qb = Math.round(Math.max(0, Math.min(255, b[i])));
        const d = Math.abs(qa - qb);
        sum += d; if (d >= 1) changed++; if (d > max) max = d;
        o[i] = Math.min(255, Math.abs(b[i] - a[i]) * gain);
      }
    }
    return { img: out, changed: (100 * changed / (3 * n)).toFixed(1), mean: (sum / (3 * n)).toFixed(2), max };
  }
  function paintCanvas(imageData) {
    const cv = $('#cv');
    if (cv.width !== imageData.width || cv.height !== imageData.height) { cv.width = imageData.width; cv.height = imageData.height; }
    cv.getContext('2d').putImageData(imageData, 0, 0);
    layoutCanvas();
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
      const scale = S.previewFull ? S.previewFull.k / (S.lastK || S.previewFull.k) : 1;
      cv.style.width = Math.round(cv.width * scale) + 'px'; cv.style.height = Math.round(cv.height * scale) + 'px';
    }
  }
  new ResizeObserver(() => layoutCanvas()).observe($('#view'));
  $('#view-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.view = b.dataset.view;
    [...$('#view-seg').children].forEach((x) => x.classList.toggle('on', x === b));
    schedule('full');
  });
  $('#zoom-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.zoom = b.dataset.zoom;
    [...$('#zoom-seg').children].forEach((x) => x.classList.toggle('on', x === b));
    layoutCanvas();
  });

  /* ------------------------------------------------------------ compare */
  const cmpBtn = $('#btn-compare');
  function startCompare() {
    if (!S.srcPreviewRGBA || S.comparing) return;
    S.comparing = true; cmpBtn.classList.add('holding');
    paintCanvas(S.srcPreviewRGBA);
    setStatus('showing the working image before this step');
  }
  function stopCompare() {
    if (!S.comparing) return;
    S.comparing = false; cmpBtn.classList.remove('holding');
    if (S.lastResultRGBA) paintCanvas(S.lastResultRGBA);
    setStatus('');
  }
  cmpBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startCompare(); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmpBtn.addEventListener(ev, stopCompare);
  const isTyping = (e) => /^(input|select|textarea)$/i.test(e.target.tagName) && e.target.type !== 'range';
  window.addEventListener('keydown', (e) => { if ((e.key === 'c' || e.key === 'C') && !e.repeat && !isTyping(e)) startCompare(); });
  window.addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') stopCompare(); });
  window.addEventListener('blur', stopCompare);

  /* ------------------------------------------------------------ loading */
  const MAX_PIXELS = 20e6;
  async function decode(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) {
      try { return await createImageBitmap(blob); }
      catch (e2) {
        const url = URL.createObjectURL(blob);
        try { const im = new Image(); im.src = url; await im.decode(); return im; }
        finally { URL.revokeObjectURL(url); }
      }
    }
  }
  async function blobToImage(blob) {
    const bmp = await decode(blob);
    let w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height, note = '';
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
    return { img: Pipeline.fromRGBA(d.data, w, h), note };
  }
  async function loadBlob(blob, name) {
    showOverlay('Decoding image…');
    try {
      const { img, note } = await blobToImage(blob);
      S.original = img; S.note = note;
      S.fileName = name || 'image';
      S.name = S.fileName.replace(/\.[a-z0-9]+$/i, '');
      S.lastSaved = '';
      setWork(img, true);
      $('#empty').hidden = true; $('#canvas-wrap').hidden = false;
      toast(`Loaded ${S.name} · ${img.w}×${img.h}`);
    } catch (e) {
      console.error(e);
      toast('Could not read that file as an image.', 'warn');
    } finally { hideOverlay(); }
  }
  // install a new working image (fresh load, applied step, undo…)
  function setWork(img, fresh) {
    S.work = img; S.workVersion++;
    if (fresh) { S.steps = []; S.undo = []; resetAll(); }
    S.fullCache = null; $('#size-readout').textContent = '';
    buildPreviews();
    updateInfo(); updateSteps();
    schedule('full');
  }
  // reduced working copies for the live preview: "full" preview at the chosen size, "quick" at half of it
  function buildPreviews() {
    const W = S.work.w, H = S.work.h;
    const maxL = S.previewMax === 'full' ? Infinity : S.previewMax;
    const kFull = Math.min(1, maxL / Math.max(W, H));
    const make = (k) => {
      if (k === 1) return { img: S.work, k: 1 };
      const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
      return { img: Pipeline.resampleImage(S.work, w, h, 'browser'), k: w / W };
    };
    S.previewFull = make(kFull);
    const quickK = Math.max(W, H) * kFull > 480 ? kFull * 0.5 : kFull;
    S.previewQuick = quickK === kFull ? null : make(quickK);
    S.srcPreviewRGBA = new ImageData(Pipeline.toRGBA(S.previewFull.img), S.previewFull.img.w, S.previewFull.img.h);
  }
  $('#preview-size').addEventListener('change', (e) => {
    S.previewMax = e.target.value === 'full' ? 'full' : +e.target.value;
    if (S.work) { buildPreviews(); schedule('full'); }
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
  async function loadTestImage() {
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
    await loadBlob(blob, 'test-image');
  }
  $('#btn-test').addEventListener('click', loadTestImage);

  /* --------------------------------------------------------------- info */
  function updateInfo() {
    const info = $('#info');
    if (!S.work) { info.textContent = ''; return; }
    const o = S.tab === 'out' ? { w: S.work.w, h: S.work.h } : Pipeline.stageOutputSize(S.work.w, S.work.h, S.tab, P);
    const sec = SECTION_BY_ID[S.tab];
    const pend = tabPending(S.tab);
    let line = `${S.fileName} · ${S.original.w}×${S.original.h}${S.note}`;
    if (S.lastSaved) line += ` · last saved as ${S.lastSaved}`;
    line += `\nworking image ${S.work.w}×${S.work.h} · ${S.steps.length} step${S.steps.length === 1 ? '' : 's'} applied`;
    if (S.tab !== 'out') line += ` · ${sec.tab} tab: ${pend ? `pending → ${o.w}×${o.h}` : 'nothing set yet'}`;
    if (S.name === 'test-image') line += '\nThis is the built-in test picture. Open or drop your own image to edit it; it stays in this tab.';
    info.replaceChildren(el('span', { class: 'file-name', text: S.fileName }), document.createTextNode(line.slice(S.fileName.length)));
    const fr = $('#frame-readout');
    if (fr) { const f = Pipeline.stageOutputSize(S.work.w, S.work.h, 'geo', P); fr.textContent = `Frame: ${f.w} × ${f.h} px` + (f.w !== S.work.w || f.h !== S.work.h ? ` (from ${S.work.w} × ${S.work.h})` : ' (nothing trimmed)'); }
    const wr = $('#work-readout');
    if (wr) wr.textContent = `Working image ${S.work.w}×${S.work.h} · ${S.steps.length} step${S.steps.length === 1 ? '' : 's'} applied`;
    $('#btn-undo').disabled = !S.undo.length;
    $('#btn-revert').disabled = !S.steps.length;
    applyBtn.disabled = !pend;
  }
  function updateSteps() {
    const ol = $('#steps-list'); if (!ol) return;
    ol.replaceChildren(...S.steps.map((s) => el('li', { text: s })));
    if (!S.steps.length) ol.append(el('li', { class: 'muted', text: 'none yet — the working image is the original' }));
  }

  /* --------------------------------------------------------- apply step */
  function pushUndo(label) {
    S.undo.push(S.work);
    while (S.undo.length > UNDO_MAX) S.undo.shift();
    S.steps.push(label);
  }
  async function applyStep() {
    if (!S.work || S.tab === 'out' || !tabPending(S.tab)) return;
    const id = S.tab, sec = SECTION_BY_ID[id];
    showOverlay(`Applying ${sec.tab}…`);
    await raf();
    try {
      let img = await Pipeline.runStage(S.work, id, P, 1, { forExport: true, status: (s) => { $('#overlay-text').textContent = s; }, tick: raf });
      let label = `${sec.tab}: ${describe(id)}`;
      if (S.wf.resample && S.wf.pct !== 100) {
        $('#overlay-text').textContent = 'Resampling…'; await raf();
        img = Pipeline.resampleStep(img, S.wf.pct, S.wf.kernel);
        label += ` → resampled ${S.wf.pct}% ${S.wf.kernel}`;
      }
      pushUndo(label);
      P[id] = deep(DEF[id]);
      syncAll();
      setWork(img, false);
      toast(`Applied ${sec.tab} · working image ${img.w}×${img.h}`);
    } catch (e) { console.error(e); toast('Applying failed: ' + e.message, 'warn'); }
    finally { hideOverlay(); }
  }
  function undoStep() {
    if (!S.undo.length) return;
    const prev = S.undo.pop(); const label = S.steps.pop();
    setWork(prev, false);
    toast('Undid: ' + label.split(':')[0]);
  }
  function revertAll() {
    if (!S.original) return;
    S.undo = []; S.steps = [];
    setWork(S.original, false);
    toast('Back to the original image');
  }

  /* ------------------------------------------------------------- export */
  function showOverlay(t) { $('#overlay-text').textContent = t; $('#overlay').hidden = false; }
  function hideOverlay() { $('#overlay').hidden = true; }
  function exportKey() { const q = deep(P[S.tab] || {}); if (q.view) q.view = S.tab === 'freq' ? 'full' : 'normal'; return S.tab + ':' + S.workVersion + ':' + JSON.stringify(q) + ':' + P.seed; }
  // full-resolution version of what the preview shows: the working image plus this tab's pending settings
  async function buildFull() {
    const key = exportKey();
    if (S.fullCache && S.fullCache.key === key) return S.fullCache.img;
    showOverlay('Rendering at full size…');
    await raf();
    try {
      const img = (S.tab === 'out' || !tabPending(S.tab)) ? S.work : await Pipeline.runStage(S.work, S.tab, P, 1, { forExport: true, status: (s) => { $('#overlay-text').textContent = s; }, tick: raf });
      S.fullCache = { key, img };
      return img;
    } finally { hideOverlay(); }
  }
  function toJpegBlob(img, quality) {
    const c = document.createElement('canvas'); c.width = img.w; c.height = img.h;
    c.getContext('2d').putImageData(new ImageData(Pipeline.toRGBA(img), img.w, img.h), 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => b ? res(b) : rej(new Error('JPEG encoding failed')), 'image/jpeg', quality / 100));
  }
  async function estimateSize() {
    if (!S.work) return;
    const img = await buildFull();
    const blob = await toJpegBlob(img, P.out.quality);
    $('#size-readout').textContent = `≈ ${fmtBytes(blob.size)} at quality ${P.out.quality}`;
    $('#export-readout').textContent = `Output ${img.w} × ${img.h} px`;
  }
  async function deliverFile(blob, filename) {
    let dl = null, embedded = false;
    try { if (window.claude && typeof window.claude.use === 'function') { embedded = true; dl = await window.claude.use('downloads'); } } catch (e) { dl = null; }
    if (embedded && !dl) { toast('This embedded view is not allowing saves. Open the tool at sunnq3.github.io/editor-v or from the repo file instead.', 'warn'); return 'failed'; }
    if (dl) {
      try { await dl.save({ filename, data: blob }); return 'saved'; }
      catch (e) {
        if (e && e.code === 'declined') return 'declined';
        if (e && e.code === 'rate_limited') { toast('A save prompt is already open. Try again in a moment.', 'warn'); return 'failed'; }
        toast('Saving is not available in this view.', 'warn'); return 'failed';
      }
    }
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'saved';
  }
  async function downloadJpeg() {
    if (!S.work) { toast('Open an image first.', 'warn'); return; }
    const img = await buildFull();
    const blob = await toJpegBlob(img, P.out.quality);
    $('#size-readout').textContent = `≈ ${fmtBytes(blob.size)} at quality ${P.out.quality}`;
    const name = exportName() + '.jpg';
    const r = await deliverFile(blob, name);
    const pend = S.tab !== 'out' && tabPending(S.tab);
    $('#export-readout').textContent = r === 'saved' ? `Saved ${name} · ${img.w} × ${img.h} px${pend ? ` · includes the unapplied ${SECTION_BY_ID[S.tab].tab} settings` : ''}` : `Output ${img.w} × ${img.h} px (not saved)`;
    if (r === 'saved') { S.lastSaved = name; updateInfo(); }
    toast(r === 'saved' ? `Saved ${name}` : 'Not saved');
  }
  $('#btn-download').addEventListener('click', downloadJpeg);
  // encode the current state as JPEG and decode it back into the working image
  async function jpegRoundTrip() {
    if (!S.work) return;
    const id = S.tab, pend = id !== 'out' && tabPending(id);
    const img = await buildFull();
    showOverlay(`Encoding JPEG at quality ${P.out.quality}…`);
    await raf();
    try {
      const blob = await toJpegBlob(img, P.out.quality);
      const { img: back } = await blobToImage(blob);
      pushUndo((pend ? `${SECTION_BY_ID[id].tab}: ${describe(id)} → ` : '') + `JPEG round trip, quality ${P.out.quality} (${fmtBytes(blob.size)})`);
      if (pend) { P[id] = deep(DEF[id]); syncAll(); }
      setWork(back, false);
      toast(`JPEG round trip done · ${fmtBytes(blob.size)}`);
    } catch (e) { console.error(e); toast('Round trip failed: ' + e.message, 'warn'); }
    finally { hideOverlay(); }
  }

  /* ----------------------------------------------------------- settings */
  function saveSettings() {
    const blob = new Blob([JSON.stringify({ params: P, workflow: S.wf }, null, 2)], { type: 'application/json' });
    deliverFile(blob, 'settings-' + exportName() + '.json');
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
      const params = j.params || j;
      mergeInto(P, params, DEF);
      if (j.workflow) { mergeInto(S.wf, j.workflow, { resample: true, pct: 97, kernel: 'lanczos3' }); wfCheck.checked = S.wf.resample; wfPct.value = S.wf.pct; wfKernel.value = S.wf.kernel; }
      for (const c of controls.values()) if (c.spec.type === 'slider') setPath(P, c.spec.path, clamp(getPath(P, c.spec.path), c.spec.min, c.spec.max));
      if (!Pipeline.KERNELS[P.rs.kernel] && P.rs.kernel !== 'browser') P.rs.kernel = DEF.rs.kernel;
      if (!['full', 'low', 'mid', 'high'].includes(P.freq.view)) P.freq.view = 'full';
      if (!['bilinear', 'bicubic', 'lanczos3'].includes(P.interp.kernel)) P.interp.kernel = DEF.interp.kernel;
      if (!['normal', 'highlight'].includes(P.jig.view)) P.jig.view = 'normal';
      if (!['rggb', 'bggr', 'grbg', 'gbrg'].includes(P.bayer.pattern)) P.bayer.pattern = 'rggb';
      if (!['mhc', 'bilinear'].includes(P.bayer.method)) P.bayer.method = 'mhc';
      if (![2, 4, 8].includes(P.bayer.ditherSize)) P.bayer.ditherSize = 4;
      syncAll();
      onParamChange('*', 'full');
      toast('Settings loaded; each tab shows its pending values.');
    } catch (err) { toast('That file is not a valid settings file.', 'warn'); }
  });

  /* --------------------------------------------------------------- init */
  syncAll();
  showTab('ch');
  setStatus('loading the test picture…');
  loadTestImage();
})();
