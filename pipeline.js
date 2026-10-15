/* editor-v — pipeline.js
   All image math lives here. An "image" is { w, h, r, g, b } where r/g/b are
   Float32Array channels holding 0..255 values. Nothing in this file touches the
   DOM, so the same code runs for the live preview and for the full-size export
   (and can be exercised from Node for testing).

   Pixel-unit parameters (shifts, blur radii, patch sizes…) are expressed in
   full-resolution pixels; every stage receives `k` (preview scale, 1 for the
   export) and multiplies by it so the preview matches the saved file. */
(function (root) {
  'use strict';

  const Pipeline = {};

  /* ------------------------------------------------------------ random */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mixSeed(seed, salt) {
    let h = (seed ^ Math.imul(salt, 0x9E3779B1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  /* ------------------------------------------------------ containers */
  function makeImage(w, h) {
    const n = w * h;
    return { w, h, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
  }
  function cloneImage(img) {
    return { w: img.w, h: img.h, r: new Float32Array(img.r), g: new Float32Array(img.g), b: new Float32Array(img.b) };
  }
  /* RGBA bytes → image. Transparent pixels are flattened onto white, since the
     output is JPEG and JPEG has no alpha. */
  function fromRGBA(data, w, h) {
    const img = makeImage(w, h);
    const n = w * h;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3] / 255, ia = 255 * (1 - a);
      img.r[i] = data[j] * a + ia;
      img.g[i] = data[j + 1] * a + ia;
      img.b[i] = data[j + 2] * a + ia;
    }
    return img;
  }
  function toRGBA(img) {
    const n = img.w * img.h;
    const out = new Uint8ClampedArray(n * 4);
    const r = img.r, g = img.g, b = img.b;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      out[j] = r[i] + 0.5; out[j + 1] = g[i] + 0.5; out[j + 2] = b[i] + 0.5; out[j + 3] = 255;
    }
    return out;
  }
  const CH = ['r', 'g', 'b'];

  /* ------------------------------------------------------------- blur */
  /* Box blur with edge replication, O(n) via prefix sums, valid for any radius. */
  function boxBlurH(src, dst, w, h, r) {
    if (r <= 0) { dst.set(src); return; }
    const inv = 1 / (2 * r + 1), last = w - 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = (r + 1) * src[row];
      for (let i = 1; i <= r; i++) acc += src[row + (i < last ? i : last)];
      // interior pixels (x in [r, w-r-2]) need no clamping on either side
      const safeStart = r, safeEnd = w - r - 1;
      let x = 0;
      for (; x < w && (x < safeStart || x >= safeEnd); x++) {
        dst[row + x] = acc * inv;
        const ai = x + r + 1, ri = x - r;
        acc += src[row + (ai < last ? ai : last)] - src[row + (ri > 0 ? ri : 0)];
      }
      for (; x < safeEnd; x++) {
        dst[row + x] = acc * inv;
        acc += src[row + x + r + 1] - src[row + x - r];
      }
      for (; x < w; x++) {
        dst[row + x] = acc * inv;
        const ai = x + r + 1, ri = x - r;
        acc += src[row + (ai < last ? ai : last)] - src[row + (ri > 0 ? ri : 0)];
      }
    }
  }
  /* Vertical pass as a sliding window over whole rows (cache friendly). */
  function boxBlurV(src, dst, w, h, r) {
    if (r <= 0) { dst.set(src); return; }
    const inv = 1 / (2 * r + 1);
    const acc = new Float64Array(w);
    for (let x = 0; x < w; x++) acc[x] = (r + 1) * src[x];
    for (let yy = 1; yy <= r; yy++) {
      const row = Math.min(yy, h - 1) * w;
      for (let x = 0; x < w; x++) acc[x] += src[row + x];
    }
    for (let y = 0; y < h; y++) {
      const orow = y * w;
      for (let x = 0; x < w; x++) dst[orow + x] = acc[x] * inv;
      const addRow = Math.min(y + r + 1, h - 1) * w, remRow = Math.max(y - r, 0) * w;
      for (let x = 0; x < w; x++) acc[x] += src[addRow + x] - src[remRow + x];
    }
  }
  function boxesForGauss(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }
  /* Exact separable Gaussian for small sigma (box approximation is coarse there). */
  function gaussSmall(src, w, h, sigma) {
    const R = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(2 * R + 1);
    let sum = 0;
    for (let i = -R; i <= R; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + R] = v; sum += v; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const xa = Math.min(R, w), xb = Math.max(xa, w - R);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < xa; x++) {
        let s = 0;
        for (let i = -R; i <= R; i++) { let xx = x + i; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; s += src[row + xx] * k[i + R]; }
        tmp[row + x] = s;
      }
      for (let x = xa; x < xb; x++) {
        let s = 0;
        for (let i = -R; i <= R; i++) s += src[row + x + i] * k[i + R];
        tmp[row + x] = s;
      }
      for (let x = xb; x < w; x++) {
        let s = 0;
        for (let i = -R; i <= R; i++) { let xx = x + i; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; s += src[row + xx] * k[i + R]; }
        tmp[row + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let i = -R; i <= R; i++) {
        let yy = y + i; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        const kk = k[i + R], srow = yy * w, orow = y * w;
        if (i === -R) for (let x = 0; x < w; x++) out[orow + x] = tmp[srow + x] * kk;
        else for (let x = 0; x < w; x++) out[orow + x] += tmp[srow + x] * kk;
      }
    }
    return out;
  }
  function gaussBlur(src, w, h, sigma) {
    if (sigma <= 0.05) return new Float32Array(src);
    if (sigma < 1.2) return gaussSmall(src, w, h, sigma);
    const boxes = boxesForGauss(sigma, 3);
    let a = new Float32Array(src), b = new Float32Array(src.length);
    for (const sz of boxes) {
      const r = (sz - 1) / 2;
      boxBlurH(a, b, w, h, r);
      boxBlurV(b, a, w, h, r);
    }
    return a;
  }
  Pipeline.gaussBlur = gaussBlur;

  /* --------------------------------------------------------- sampling */
  /* Catmull-Rom bicubic sample at pixel-index coordinates (centre of pixel i is i). */
  function sampleBicubic(ch, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    const x1 = Math.floor(x), y1 = Math.floor(y);
    const tx = x - x1, ty = y - y1;
    const tx2 = tx * tx, tx3 = tx2 * tx, ty2 = ty * ty, ty3 = ty2 * ty;
    const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx, wx1 = 1.5 * tx3 - 2.5 * tx2 + 1,
          wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx, wx3 = 0.5 * tx3 - 0.5 * tx2;
    const wy0 = -0.5 * ty3 + ty2 - 0.5 * ty, wy1 = 1.5 * ty3 - 2.5 * ty2 + 1,
          wy2 = -1.5 * ty3 + 2 * ty2 + 0.5 * ty, wy3 = 0.5 * ty3 - 0.5 * ty2;
    let x0 = x1 - 1, x2 = x1 + 1, x3 = x1 + 2, y0 = y1 - 1, y2 = y1 + 1, y3 = y1 + 2;
    if (x0 < 0) x0 = 0; if (x2 > w - 1) x2 = w - 1; if (x3 > w - 1) x3 = w - 1;
    if (y0 < 0) y0 = 0; if (y2 > h - 1) y2 = h - 1; if (y3 > h - 1) y3 = h - 1;
    const r0 = y0 * w, r1 = y1 * w, r2 = y2 * w, r3 = y3 * w;
    const v0 = ch[r0 + x0] * wx0 + ch[r0 + x1] * wx1 + ch[r0 + x2] * wx2 + ch[r0 + x3] * wx3;
    const v1 = ch[r1 + x0] * wx0 + ch[r1 + x1] * wx1 + ch[r1 + x2] * wx2 + ch[r1 + x3] * wx3;
    const v2 = ch[r2 + x0] * wx0 + ch[r2 + x1] * wx1 + ch[r2 + x2] * wx2 + ch[r2 + x3] * wx3;
    const v3 = ch[r3 + x0] * wx0 + ch[r3 + x1] * wx1 + ch[r3 + x2] * wx2 + ch[r3 + x3] * wx3;
    return v0 * wy0 + v1 * wy1 + v2 * wy2 + v3 * wy3;
  }

  /* --------------------------------------------- 1. channel x/y/z shift */
  /* Each channel is moved sideways (x), up/down (y) and zoomed from the centre
     (z, as a percentage). Returns the shifted image plus the rectangle where
     all three channels still carry real data, so the frame step can trim the
     smeared edges away. */
  /* The rectangle where all three shifted channels still carry real data. */
  function validRect(w, h, C, k) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    let vx0 = 0, vy0 = 0, vx1 = w, vy1 = h;
    for (const name of CH) {
      const p = (C && C[name]) || { x: 0, y: 0, z: 0 };
      const dx = (p.x || 0) * k, dy = (p.y || 0) * k, s = 1 + (p.z || 0) / 100;
      if (dx === 0 && dy === 0 && s === 1) continue;
      // where do the first/last source pixels land?
      const lx = cx * (1 - s) + dx, rx = lx + (w - 1) * s;
      const ty = cy * (1 - s) + dy, by = ty + (h - 1) * s;
      vx0 = Math.max(vx0, Math.ceil(lx)); vx1 = Math.min(vx1, Math.floor(rx) + 1);
      vy0 = Math.max(vy0, Math.ceil(ty)); vy1 = Math.min(vy1, Math.floor(by) + 1);
    }
    if (vx1 - vx0 < 8) { vx0 = 0; vx1 = w; }
    if (vy1 - vy0 < 8) { vy0 = 0; vy1 = h; }
    return { x0: vx0, y0: vy0, x1: vx1, y1: vy1 };
  }
  Pipeline.validRect = validRect;

  function channelShift(img, C, k) {
    const { w, h } = img;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const out = makeImage(w, h);
    for (const name of CH) {
      const p = C[name] || { x: 0, y: 0, z: 0 };
      const dx = (p.x || 0) * k, dy = (p.y || 0) * k, s = 1 + (p.z || 0) / 100;
      const src = img[name], dst = out[name];
      if (dx === 0 && dy === 0 && s === 1) { dst.set(src); continue; }
      const inv = 1 / s;
      for (let y = 0; y < h; y++) {
        const sy = (y - cy - dy) * inv + cy;
        const row = y * w;
        for (let x = 0; x < w; x++) {
          dst[row + x] = sampleBicubic(src, w, h, (x - cx - dx) * inv + cx, sy);
        }
      }
    }
    return { img: out, valid: validRect(w, h, C, k) };
  }
  Pipeline.channelShift = channelShift;

  /* ---------------------------------------------- 1b. tone per channel */
  /* Shadows (lift), midtones (gamma) and highlights (gain) for each channel,
     applied through a 1024-entry lookup table. */
  function toneLUT(p) {
    const lift = (p.shadows || 0) / 100, gain = 1 + (p.highlights || 0) / 100, gamma = Math.pow(2, (p.midtones || 0) / 50);
    const N = 1024, lut = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      let y = x * gain + lift * (1 - x);
      if (y < 0) y = 0; else if (y > 1) y = 1;
      lut[i] = Math.pow(y, 1 / gamma) * 255;
    }
    return lut;
  }
  function toneActive(p) { return !!(p && (p.shadows || p.midtones || p.highlights)); }
  function toneAdjust(img, T) {
    if (!CH.some(c => toneActive(T[c]))) return img;
    const out = cloneImage(img), N = img.w * img.h;
    for (const name of CH) {
      if (!toneActive(T[name])) continue;
      const lut = toneLUT(T[name]), ch = out[name];
      for (let i = 0; i < N; i++) {
        let v = ch[i]; if (v < 0) v = 0; else if (v > 255) v = 255;
        const f = v * (1024 / 255);
        let j = f | 0; if (j > 1023) j = 1023;
        const t = f - j;
        ch[i] = lut[j] + (lut[j + 1] - lut[j]) * t;
      }
    }
    return out;
  }
  Pipeline.toneAdjust = toneAdjust;

  /* ------------------------------------------- 2. frequency band stack */
  function stdOf(a) {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < a.length; i += 7) { s += a[i]; s2 += a[i] * a[i]; n++; }
    const m = s / n;
    return Math.sqrt(Math.max(1e-12, s2 / n - m * m));
  }
  function meanOf(a) {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i += 5) { s += a[i]; n++; }
    return s / n;
  }
  /* Edge-aware smoothing of a band: a separable bilateral filter (radius 3,
     horizontal pass then vertical pass). Strength 0..100 widens the range of
     values that count as "similar", so higher = flatter. */
  function bilateral(src, w, h, strength) {
    const R = 3, sigS = 1.8, sigR = 1.5 + strength * 0.5;
    const sw = new Float32Array(2 * R + 1);
    for (let d = -R; d <= R; d++) sw[d + R] = Math.exp(-(d * d) / (2 * sigS * sigS));
    const LUT = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) { const d = i / 8; LUT[i] = Math.exp(-(d * d) / (2 * sigR * sigR)); }
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const c = src[row + x];
        let sum = 0, wsum = 0;
        for (let d = -R; d <= R; d++) {
          let xx = x + d; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
          const v = src[row + xx];
          let li = Math.abs(v - c) * 8; if (li > 2047) li = 2047;
          const wgt = sw[d + R] * LUT[li | 0];
          sum += v * wgt; wsum += wgt;
        }
        tmp[row + x] = sum / wsum;
      }
    }
    const sums = new Float32Array(w), wsums = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      sums.fill(0); wsums.fill(0);
      for (let d = -R; d <= R; d++) {
        let yy = y + d; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        const srow = yy * w, s = sw[d + R];
        for (let x = 0; x < w; x++) {
          const v = tmp[srow + x];
          let li = Math.abs(v - tmp[row + x]) * 8; if (li > 2047) li = 2047;
          const wgt = s * LUT[li | 0];
          sums[x] += v * wgt; wsums[x] += wgt;
        }
      }
      for (let x = 0; x < w; x++) out[row + x] = sums[x] / wsums[x];
    }
    return out;
  }
  const BANDS = ['low', 'mid', 'high'];
  function bandActive(p) { return !!(p && (p.gain || p.noise || p.blur || p.smooth)); }

  function frequencyEdit(img, F, k, seed, viewBand) {
    const { w, h } = img, N = w * h;
    viewBand = viewBand || 'full';
    if (!BANDS.some(b => bandActive(F[b])) && viewBand === 'full') return img;
    const sf = Math.max(0.3, F.fine * k);
    const sc = Math.max(sf + 0.5, F.coarse * k);
    const out = makeImage(w, h);

    // Band-limited noise, normalised to unit standard deviation, created lazily.
    const noiseCache = {};
    function noiseFor(band, ci) {
      const key = F.colorNoise ? ci : 'mono';
      let c = noiseCache[key];
      if (!c) {
        const rnd = mulberry32(mixSeed(seed, 11 + (F.colorNoise ? ci : 0)));
        const white = new Float32Array(N);
        for (let i = 0; i < N; i++) white[i] = rnd() * 2 - 1;
        c = noiseCache[key] = { white, b1: null, b2: null, bands: {} };
      }
      if (c.bands[band]) return c.bands[band];
      if ((band === 'high' || band === 'mid') && !c.b1) c.b1 = gaussBlur(c.white, w, h, sf);
      if ((band === 'low' || band === 'mid') && !c.b2) c.b2 = gaussBlur(c.white, w, h, sc);
      const arr = new Float32Array(N);
      if (band === 'high') for (let i = 0; i < N; i++) arr[i] = c.white[i] - c.b1[i];
      else if (band === 'mid') for (let i = 0; i < N; i++) arr[i] = c.b1[i] - c.b2[i];
      else arr.set(c.b2);
      const sd = stdOf(arr), inv = 1 / sd;
      for (let i = 0; i < N; i++) arr[i] *= inv;
      c.bands[band] = arr;
      return arr;
    }

    CH.forEach((name, ci) => {
      const src = img[name];
      const b1 = gaussBlur(src, w, h, sf), b2 = gaussBlur(src, w, h, sc);
      const high = new Float32Array(N), mid = new Float32Array(N);
      for (let i = 0; i < N; i++) { high[i] = src[i] - b1[i]; mid[i] = b1[i] - b2[i]; }
      const B = { low: b2, mid, high };
      for (const bn of BANDS) {
        const p = F[bn]; if (!bandActive(p)) continue;
        let arr = B[bn];
        if (p.gain) {
          const g = 1 + p.gain / 100, m = bn === 'low' ? meanOf(arr) : 0;
          for (let i = 0; i < N; i++) arr[i] = m + (arr[i] - m) * g;
        }
        if (p.blur > 0) arr = gaussBlur(arr, w, h, p.blur * k);
        if (p.smooth > 0) arr = bilateral(arr, w, h, p.smooth);
        if (p.noise > 0) {
          const n = noiseFor(bn, ci), a = p.noise;
          for (let i = 0; i < N; i++) arr[i] += a * n[i];
        }
        B[bn] = arr;
      }
      const dst = out[name];
      if (viewBand === 'full') { const L = B.low, M = B.mid, H = B.high; for (let i = 0; i < N; i++) dst[i] = L[i] + M[i] + H[i]; }
      else if (viewBand === 'low') dst.set(B.low);
      else { const A = B[viewBand]; for (let i = 0; i < N; i++) dst[i] = 128 + A[i]; }
    });
    return out;
  }
  Pipeline.frequencyEdit = frequencyEdit;

  /* ---------------------------------------------- 3. gradient perturbation */
  /* Smooth random field in [-1, 1]. The grid is defined in full-resolution
     units so preview and export show the same pattern. */
  function noiseField(w, h, nx, ny, seed) {
    const rnd = mulberry32(seed);
    const gw = nx + 1, gh = ny + 1;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd() * 2 - 1;
    const i0s = new Int32Array(w), i1s = new Int32Array(w), tus = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w * nx; let i0 = Math.floor(u); if (i0 > nx - 1) i0 = nx - 1;
      const t = u - i0; i0s[x] = i0; i1s[x] = Math.min(i0 + 1, nx); tus[x] = t * t * (3 - 2 * t);
    }
    const out = new Float32Array(w * h);
    let maxAbs = 1e-6;
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h * ny; let j0 = Math.floor(v); if (j0 > ny - 1) j0 = ny - 1;
      const j1 = Math.min(j0 + 1, ny); let tv = v - j0; tv = tv * tv * (3 - 2 * tv);
      const r0 = j0 * gw, r1 = j1 * gw, row = y * w;
      for (let x = 0; x < w; x++) {
        const i0 = i0s[x], i1 = i1s[x], tu = tus[x];
        const a = grid[r0 + i0] + (grid[r0 + i1] - grid[r0 + i0]) * tu;
        const b = grid[r1 + i0] + (grid[r1 + i1] - grid[r1 + i0]) * tu;
        const val = a + (b - a) * tv;
        out[row + x] = val;
        const av = val < 0 ? -val : val; if (av > maxAbs) maxAbs = av;
      }
    }
    const inv = 1 / maxAbs;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
    return out;
  }
  function cellsFor(fullW, fullH, cell) {
    return [Math.max(1, Math.round(fullW / cell)), Math.max(1, Math.round(fullH / cell))];
  }
  function gradientPerturb(img, G, k, seed) {
    if (!G.drift && !G.tilt && !G.jitter) return img;
    const { w, h } = img, N = w * h;
    const fullW = w / k, fullH = h / k;
    const out = cloneImage(img);
    if (G.drift > 0) {
      const [nx, ny] = cellsFor(fullW, fullH, Math.max(4, G.driftCell));
      let field = null;
      CH.forEach((name, ci) => {
        if (G.driftColor || !field) field = noiseField(w, h, nx, ny, mixSeed(seed, 21 + (G.driftColor ? ci : 0)));
        const a = G.drift, ch = out[name];
        for (let i = 0; i < N; i++) ch[i] += a * field[i];
      });
    }
    if (G.tilt) {
      const ang = (G.tiltAngle || 0) * Math.PI / 180;
      const ca = Math.cos(ang), sa = Math.sin(ang), norm = 1 / (Math.abs(ca) + Math.abs(sa));
      for (let y = 0; y < h; y++) {
        const v = ((y + 0.5) / h - 0.5) * 2, row = y * w;
        for (let x = 0; x < w; x++) {
          const u = ((x + 0.5) / w - 0.5) * 2;
          const d = G.tilt * (ca * u + sa * v) * norm;
          out.r[row + x] += d; out.g[row + x] += d; out.b[row + x] += d;
        }
      }
    }
    if (G.jitter > 0) {
      const [nx, ny] = cellsFor(fullW, fullH, Math.max(4, G.jitterCell));
      const field = noiseField(w, h, nx, ny, mixSeed(seed, 31));
      const a = G.jitter / 100;
      for (const name of CH) {
        const ch = out[name];
        const base = gaussBlur(ch, w, h, 1.2 * k);
        for (let i = 0; i < N; i++) ch[i] = base[i] + (ch[i] - base[i]) * (1 + a * field[i]);
      }
    }
    return out;
  }
  Pipeline.gradientPerturb = gradientPerturb;

  /* ------------------------------------- 3b. invisible jigsaw (block swap) */
  /* Flat blocks are swapped with similar flat blocks nearby. With keepTone
     only the grain moves: each block keeps its own average colour. */
  function blockSwap(img, J, k, seed, highlight) {
    if (!J || !J.on) return img;
    const { w, h } = img;
    const B = Math.max(2, Math.round(J.block * k));
    const nx = Math.floor(w / B), ny = Math.floor(h / B);
    if (nx < 2 || ny < 2) return img;
    const nb = nx * ny;
    const mr = new Float32Array(nb), mg = new Float32Array(nb), mb = new Float32Array(nb), tex = new Float32Array(nb);
    const r = img.r, g = img.g, b = img.b;
    for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
      let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
      for (let y = by * B; y < (by + 1) * B; y++) {
        let i = y * w + bx * B;
        for (let x = 0; x < B; x++, i++) {
          const l = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
          sr += r[i]; sg += g[i]; sb += b[i]; sl += l; sl2 += l * l;
        }
      }
      const n = B * B, bi = by * nx + bx;
      mr[bi] = sr / n; mg[bi] = sg / n; mb[bi] = sb / n;
      tex[bi] = Math.sqrt(Math.max(0, sl2 / n - (sl / n) * (sl / n)));
    }
    const eligible = new Uint8Array(nb);
    for (let i = 0; i < nb; i++) eligible[i] = tex[i] <= J.homog ? 1 : 0;
    const rnd = mulberry32(mixSeed(seed, 51));
    const order = [];
    for (let i = 0; i < nb; i++) if (eligible[i]) order.push(i);
    for (let i = order.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    const paired = new Uint8Array(nb), swaps = [];
    const R = Math.max(1, Math.round(J.radius)), amount = J.amount / 100;
    for (const idx of order) {
      if (paired[idx]) continue;
      if (rnd() > amount) continue;
      const bx = idx % nx, by = (idx / nx) | 0;
      const cands = [];
      for (let dy = -R; dy <= R; dy++) {
        const yy = by + dy; if (yy < 0 || yy >= ny) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = bx + dx; if (xx < 0 || xx >= nx || (dx === 0 && dy === 0)) continue;
          const j = yy * nx + xx;
          if (!eligible[j] || paired[j]) continue;
          const d = Math.max(Math.abs(mr[j] - mr[idx]), Math.abs(mg[j] - mg[idx]), Math.abs(mb[j] - mb[idx]));
          if (d <= J.tol) cands.push(j);
        }
      }
      if (!cands.length) continue;
      const j = cands[(rnd() * cands.length) | 0];
      paired[idx] = paired[j] = 1;
      swaps.push([idx, j, J.flip ? (rnd() * 4) | 0 : 0, J.flip ? (rnd() * 4) | 0 : 0]);
    }
    if (!swaps.length) return img;
    const out = cloneImage(img);
    const tmp = new Float32Array(B * B);
    // copies block `from` of src into block `to` of dst with an optional flip (0 none, 1 horizontal, 2 vertical, 3 both) and tone offset
    const moveBlock = (src, dst, from, to, flip, offset) => {
      const fx = (from % nx) * B, fy = ((from / nx) | 0) * B, tx = (to % nx) * B, ty = ((to / nx) | 0) * B;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) tmp[y * B + x] = src[(fy + y) * w + fx + x];
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
        const sx = (flip & 1) ? B - 1 - x : x, sy = (flip & 2) ? B - 1 - y : y;
        dst[(ty + y) * w + tx + x] = tmp[sy * B + sx] + offset;
      }
    };
    for (const [a, c, fa, fc] of swaps) {
      for (const name of CH) {
        const m = name === 'r' ? mr : name === 'g' ? mg : mb;
        const offAC = J.keepTone ? m[c] - m[a] : 0, offCA = J.keepTone ? m[a] - m[c] : 0;
        moveBlock(img[name], out[name], a, c, fa, offAC);
        moveBlock(img[name], out[name], c, a, fc, offCA);
      }
    }
    if (highlight) {
      for (const [a, c] of swaps) for (const bi of [a, c]) {
        const x0 = (bi % nx) * B, y0 = ((bi / nx) | 0) * B;
        for (let x = x0; x < x0 + B; x++) { const i1 = y0 * w + x, i2 = (y0 + B - 1) * w + x; out.r[i1] = out.r[i2] = 139; out.g[i1] = out.g[i2] = 124; out.b[i1] = out.b[i2] = 246; }
        for (let y = y0; y < y0 + B; y++) { const i1 = y * w + x0, i2 = y * w + x0 + B - 1; out.r[i1] = out.r[i2] = 139; out.g[i1] = out.g[i2] = 124; out.b[i1] = out.b[i2] = 246; }
      }
    }
    out.swapCount = swaps.length; out.blockCount = nb; out.eligibleCount = order.length;
    return out;
  }
  Pipeline.blockSwap = blockSwap;

  /* ------------------------------------ 3c. phase shift (Fourier translation) */
  const fftPlans = {};
  function fftPlan(M) {
    if (fftPlans[M]) return fftPlans[M];
    const levels = Math.round(Math.log2(M));
    const rev = new Uint32Array(M);
    for (let i = 0; i < M; i++) { let x = i, y = 0; for (let l = 0; l < levels; l++) { y = (y << 1) | (x & 1); x >>= 1; } rev[i] = y >>> 0; }
    const cos = new Float64Array(M / 2), sin = new Float64Array(M / 2);
    for (let i = 0; i < M / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / M); sin[i] = Math.sin(2 * Math.PI * i / M); }
    return (fftPlans[M] = { M, rev, cos, sin });
  }
  function fft(re, im, plan, inverse) {
    const { M, rev, cos, sin } = plan;
    for (let i = 0; i < M; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= M; size <<= 1) {
      const half = size >> 1, step = M / size;
      for (let i = 0; i < M; i += size) {
        for (let j = i, kk = 0; j < i + half; j++, kk += step) {
          const wr = cos[kk], wi = inverse ? sin[kk] : -sin[kk];
          const l = j + half;
          const tr = re[l] * wr - im[l] * wi, ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
        }
      }
    }
    if (inverse) { const inv = 1 / M; for (let i = 0; i < M; i++) { re[i] *= inv; im[i] *= inv; } }
  }
  /* Shifts `count` lines of length N by d (sub-pixel) through the frequency
     domain. Two real lines are packed into one complex FFT. Each line is
     mirror-extended and tapered inside power-of-two padding so the circular
     wrap never touches the picture. */
  function fourierShiftLines(getLine, setLine, count, N, d) {
    const pad = 48;
    let M = 1; while (M < N + 2 * pad) M <<= 1;
    const padL = (M - N) >> 1;
    const plan = fftPlan(M);
    const re = new Float64Array(M), im = new Float64Array(M);
    const Hr = new Float64Array(M), Hi = new Float64Array(M);
    for (let q = 0; q < M; q++) {
      if (q === M / 2) { Hr[q] = Math.cos(Math.PI * d); Hi[q] = 0; continue; }
      const f = q < M / 2 ? q : q - M, ang = -2 * Math.PI * f * d / M;
      Hr[q] = Math.cos(ang); Hi[q] = Math.sin(ang);
    }
    const win = new Float64Array(M), padR = M - padL - N;
    for (let j = 0; j < M; j++) {
      let t = 1;
      if (j < padL) t = (j + 0.5) / padL; else if (j >= padL + N) t = (M - j - 0.5) / padR;
      win[j] = t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t);
    }
    // Extension outside the picture: point-reflected about the edge value, so
    // the slope stays continuous and the sinc tails die off quickly.
    const extIdx = new Int32Array(M), extMode = new Int8Array(M); // mode 0: inside, -1: left ext, 1: right ext
    for (let j = 0; j < M; j++) {
      const t = j - padL;
      if (t < 0) { extIdx[j] = Math.min(-t, N - 1); extMode[j] = -1; }
      else if (t >= N) { extIdx[j] = Math.max(2 * (N - 1) - t, 0); extMode[j] = 1; }
      else { extIdx[j] = t; extMode[j] = 0; }
    }
    const bufA = new Float64Array(N), bufB = new Float64Array(N);
    const extend = (buf, dst) => {
      const a0 = buf[0], aN = buf[N - 1];
      for (let j = 0; j < M; j++) {
        const m = extMode[j], v = buf[extIdx[j]];
        dst[j] = (m === 0 ? v : m < 0 ? 2 * a0 - v : 2 * aN - v) * win[j];
      }
    };
    for (let i = 0; i < count; i += 2) {
      getLine(i, bufA);
      const hasB = i + 1 < count;
      if (hasB) getLine(i + 1, bufB); else bufB.fill(0);
      extend(bufA, re); extend(bufB, im);
      fft(re, im, plan, false);
      for (let q = 0; q < M; q++) { const a = re[q], b = im[q]; re[q] = a * Hr[q] - b * Hi[q]; im[q] = a * Hi[q] + b * Hr[q]; }
      fft(re, im, plan, true);
      setLine(i, re, padL);
      if (hasB) setLine(i + 1, im, padL);
    }
  }
  function fourierShift(img, F, k) {
    const dx = (F.x || 0) * k, dy = (F.y || 0) * k;
    if (!dx && !dy) return img;
    const { w, h } = img;
    const out = cloneImage(img);
    for (const name of CH) {
      const ch = out[name];
      if (dx) fourierShiftLines(
        (i, buf) => { const row = i * w; for (let x = 0; x < w; x++) buf[x] = ch[row + x]; },
        (i, arr, off) => { const row = i * w; for (let x = 0; x < w; x++) ch[row + x] = arr[off + x]; },
        h, w, dx);
      if (dy) fourierShiftLines(
        (i, buf) => { for (let y = 0; y < h; y++) buf[y] = ch[y * w + i]; },
        (i, arr, off) => { for (let y = 0; y < h; y++) ch[y * w + i] = arr[off + y]; },
        w, h, dy);
    }
    return out;
  }
  Pipeline.fourierShift = fourierShift;

  /* ------------------------------------------ 3d. interpolation forcing */
  const LANC = (() => { const L = new Float32Array(3 * 512 + 2), f = lanczosFn(3); for (let i = 0; i < L.length; i++) L[i] = f(i / 512); return L; })();
  function lanczosFn(a) {
    return x => { x = Math.abs(x); if (x < 1e-6) return 1; if (x >= a) return 0; const px = Math.PI * x; return a * Math.sin(px) * Math.sin(px / a) / (px * px); };
  }
  function sampleBilinear(ch, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
    const a = ch[y0 * w + x0], b = ch[y0 * w + x1], c = ch[y1 * w + x0], d = ch[y1 * w + x1];
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }
  const LWX = new Float64Array(6), LWY = new Float64Array(6);
  function sampleLanczos3(ch, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    let sum = 0, wsum = 0;
    const wx = LWX, wy = LWY;
    for (let i = 0; i < 6; i++) { wx[i] = LANC[Math.round(Math.abs(x - (x0 - 2 + i)) * 512)] || 0; wy[i] = LANC[Math.round(Math.abs(y - (y0 - 2 + i)) * 512)] || 0; }
    for (let j = 0; j < 6; j++) {
      let yy = y0 - 2 + j; if (yy < 0) yy = 0; else if (yy > h - 1) yy = h - 1;
      const row = yy * w;
      for (let i = 0; i < 6; i++) {
        let xx = x0 - 2 + i; if (xx < 0) xx = 0; else if (xx > w - 1) xx = w - 1;
        const wgt = wx[i] * wy[j];
        sum += ch[row + xx] * wgt; wsum += wgt;
      }
    }
    return sum / wsum;
  }
  const SAMPLERS = { bilinear: sampleBilinear, bicubic: sampleBicubic, lanczos3: sampleLanczos3 };
  /* Every pixel is re-read from a slightly different sub-pixel position: a
     global fractional shift plus a smooth random warp. */
  function interpForce(img, I, k, seed) {
    const dx = (I.x || 0) * k, dy = (I.y || 0) * k, amp = (I.warp || 0) * k;
    if (!dx && !dy && !amp) return img;
    const { w, h } = img, N = w * h;
    const sample = SAMPLERS[I.kernel] || sampleBicubic;
    let fx = null, fy = null;
    if (amp) {
      const [nx, ny] = cellsFor(w / k, h / k, Math.max(4, I.warpCell || 64));
      fx = noiseField(w, h, nx, ny, mixSeed(seed, 41));
      fy = noiseField(w, h, nx, ny, mixSeed(seed, 42));
    }
    const out = makeImage(w, h);
    for (const name of CH) {
      const src = img[name], dst = out[name];
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) {
          const sx = x - dx - (fx ? amp * fx[i] : 0), sy = y - dy - (fy ? amp * fy[i] : 0);
          dst[i] = sample(src, w, h, sx, sy);
        }
      }
    }
    return out;
  }
  Pipeline.interpForce = interpForce;

  /* Shrinks a valid rectangle by n pixels on every side. */
  function insetRect(V, n, w, h) {
    n = Math.ceil(n);
    if (n <= 0) return V;
    const r = { x0: V.x0 + n, y0: V.y0 + n, x1: V.x1 - n, y1: V.y1 - n };
    if (r.x1 - r.x0 < 8 || r.y1 - r.y0 < 8) return V;
    return r;
  }
  /* The area where every stage still has real picture data. */
  function validRectAll(w, h, P, k) {
    let V = validRect(w, h, P.ch, k);
    const F = P.fourier || {}, I = P.interp || {};
    const fd = Math.max(Math.abs(F.x || 0), Math.abs(F.y || 0));
    if (fd) V = insetRect(V, fd * k + 2, w, h);
    const id = Math.max(Math.abs(I.x || 0), Math.abs(I.y || 0)) + (I.warp || 0);
    if (id) V = insetRect(V, id * k + (I.kernel === 'lanczos3' ? 3 : I.kernel === 'bilinear' ? 1 : 2), w, h);
    return V;
  }
  Pipeline.validRectAll = validRectAll;

  /* ------------------------------------------------ 4. frame geometry */
  function mat3mul(A, B) {
    const C = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return C;
  }
  function invert3(m) {
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
    const det = a * A + b * B + c * Cc;
    const inv = 1 / det;
    return new Float64Array([
      A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
      B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
      Cc * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
    ]);
  }
  function applyH(H, x, y) {
    const X = H[0] * x + H[1] * y + H[2], Y = H[3] * x + H[4] * y + H[5], Z = H[6] * x + H[7] * y + H[8];
    return [X / Z, Y / Z];
  }
  /* Homography (source px → destination px) for an in-plane rotation followed by
     a camera-style tilt of the picture plane. Positive rotate = clockwise.
     Positive tiltX = bottom edge leans away; positive tiltY = left edge leans away. */
  function makeH(w, h, rotDeg, tiltXDeg, tiltYDeg) {
    const cx = w / 2, cy = h / 2, f = 1.5 * Math.max(w, h);
    const a = rotDeg * Math.PI / 180, tx = tiltXDeg * Math.PI / 180, ty = tiltYDeg * Math.PI / 180;
    const Rz = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
    const Rx = [1, 0, 0, 0, Math.cos(tx), -Math.sin(tx), 0, Math.sin(tx), Math.cos(tx)];
    const Ry = [Math.cos(ty), 0, Math.sin(ty), 0, 1, 0, -Math.sin(ty), 0, Math.cos(ty)];
    const R = mat3mul(Ry, mat3mul(Rx, Rz));
    const M = [f * R[0], f * R[1], 0, f * R[3], f * R[4], 0, R[6], R[7], f];
    const T1 = [1, 0, cx, 0, 1, cy, 0, 0, 1], T0 = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
    return mat3mul(T1, mat3mul(M, T0));
  }
  function insideConvex(q, x, y) {
    let pos = false, neg = false;
    for (let i = 0; i < 4; i++) {
      const ax = q[i][0], ay = q[i][1], bx = q[(i + 1) % 4][0], by = q[(i + 1) % 4][1];
      const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (cr > 1e-9) pos = true; else if (cr < -1e-9) neg = true;
      if (pos && neg) return false;
    }
    return true;
  }
  /* Largest axis-aligned rectangle with the given aspect that fits inside a
     convex quad: grid-search the centre, binary-search the size. */
  function fitRect(quad, aw, ah) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of quad) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const sMax = Math.min((maxX - minX) / aw, (maxY - minY) / ah);
    const fits = (cx, cy, s) => {
      const hw = s * aw / 2, hh = s * ah / 2;
      return insideConvex(quad, cx - hw, cy - hh) && insideConvex(quad, cx + hw, cy - hh) &&
             insideConvex(quad, cx - hw, cy + hh) && insideConvex(quad, cx + hw, cy + hh);
    };
    const bestAt = (cx, cy) => {
      if (!insideConvex(quad, cx, cy)) return 0;
      let lo = 0, hi = sMax;
      for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (fits(cx, cy, m)) lo = m; else hi = m; }
      return lo;
    };
    let best = { s: 0, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    let rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
    let ccx = best.cx, ccy = best.cy;
    for (let round = 0; round < 4; round++) {
      const n = round === 0 ? 24 : 10;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const cx = ccx - rx + 2 * rx * i / n, cy = ccy - ry + 2 * ry * j / n;
        const s = bestAt(cx, cy);
        if (s > best.s) best = { s, cx, cy };
      }
      ccx = best.cx; ccy = best.cy; rx /= n / 2; ry /= n / 2;
    }
    return { x: best.cx - best.s * aw / 2, y: best.cy - best.s * ah / 2, w: best.s * aw, h: best.s * ah };
  }
  Pipeline.makeH = makeH;
  Pipeline.applyH = applyH;
  Pipeline.fitRect = fitRect;

  /* Computes the output frame (in destination coordinates) for the current
     geometry settings. Also exported so the UI can show the frame. */
  function frameFor(w, h, Gm, valid) {
    const V = valid || { x0: 0, y0: 0, x1: w, y1: h };
    const vw = V.x1 - V.x0, vh = V.y1 - V.y0;
    const identity = !Gm.rotate && !Gm.tiltX && !Gm.tiltY;
    let H = null, rect;
    if (identity) {
      rect = { x: V.x0, y: V.y0, w: vw, h: vh };
    } else {
      H = makeH(w, h, Gm.rotate || 0, Gm.tiltX || 0, Gm.tiltY || 0);
      const quad = [applyH(H, V.x0, V.y0), applyH(H, V.x1, V.y0), applyH(H, V.x1, V.y1), applyH(H, V.x0, V.y1)];
      rect = fitRect(quad, vw, vh);
      // keep a hair inside the valid area so edge pixels never sample emptiness
      const inset = 1;
      if (rect.w > 4 * inset && rect.h > 4 * inset) { rect.x += inset; rect.y += inset; rect.w -= 2 * inset; rect.h -= 2 * inset; }
    }
    const c = Math.min(0.9, Math.max(0, (Gm.crop || 0) / 100));
    if (c > 0) {
      const nw = rect.w * (1 - c), nh = rect.h * (1 - c);
      const sx = (rect.w - nw) / 2, sy = (rect.h - nh) / 2;
      const px = Math.max(-1, Math.min(1, (Gm.posX || 0) / 100)), py = Math.max(-1, Math.min(1, (Gm.posY || 0) / 100));
      rect = { x: rect.x + sx + px * sx, y: rect.y + sy + py * sy, w: nw, h: nh };
    }
    return { rect, H, identity };
  }
  Pipeline.frameFor = frameFor;

  /* Final pixel size of the saved image for a full-size source of w×h. */
  Pipeline.outputSize = function (w, h, P) {
    const V = validRectAll(w, h, P, 1);
    const { rect } = frameFor(w, h, P.geo, V);
    let ow = Math.max(1, Math.round(rect.w)), oh = Math.max(1, Math.round(rect.h));
    if (P.geo.restoreSize) { ow = w; oh = h; }
    if (P.rs.outScale && P.rs.outScale !== 100) {
      ow = Math.max(1, Math.round(ow * P.rs.outScale / 100)); oh = Math.max(1, Math.round(oh * P.rs.outScale / 100));
    }
    return { w: ow, h: oh, frame: { w: Math.round(rect.w), h: Math.round(rect.h) } };
  };

  function geometry(img, Gm, k, valid) {
    const { w, h } = img;
    const { rect, H, identity } = frameFor(w, h, Gm, valid);
    if (identity) {
      let x0 = Math.round(rect.x), y0 = Math.round(rect.y);
      let ow = Math.max(1, Math.round(rect.w)), oh = Math.max(1, Math.round(rect.h));
      if (x0 + ow > w) x0 = w - ow; if (y0 + oh > h) y0 = h - oh;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x0 === 0 && y0 === 0 && ow === w && oh === h) return img;
      const out = makeImage(ow, oh);
      for (const name of CH) {
        const src = img[name], dst = out[name];
        for (let y = 0; y < oh; y++) dst.set(src.subarray((y + y0) * w + x0, (y + y0) * w + x0 + ow), y * ow);
      }
      return out;
    }
    const Hi = invert3(H);
    const ow = Math.max(1, Math.round(rect.w)), oh = Math.max(1, Math.round(rect.h));
    const out = makeImage(ow, oh);
    const sx = new Float32Array(ow * oh), sy = new Float32Array(ow * oh);
    for (let oy = 0; oy < oh; oy++) {
      const dy = rect.y + oy + 0.5;
      for (let ox = 0; ox < ow; ox++) {
        const dx = rect.x + ox + 0.5;
        const X = Hi[0] * dx + Hi[1] * dy + Hi[2], Y = Hi[3] * dx + Hi[4] * dy + Hi[5], Z = Hi[6] * dx + Hi[7] * dy + Hi[8];
        sx[oy * ow + ox] = X / Z - 0.5; sy[oy * ow + ox] = Y / Z - 0.5;
      }
    }
    for (const name of CH) {
      const src = img[name], dst = out[name];
      for (let i = 0; i < ow * oh; i++) dst[i] = sampleBicubic(src, w, h, sx[i], sy[i]);
    }
    return out;
  }
  Pipeline.geometry = geometry;

  /* -------------------------------------------------- 5. resampling */
  function cubicBC(B, C) {
    return x => {
      x = Math.abs(x);
      if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
      if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
      return 0;
    };
  }
  function lanczos(a) {
    return x => {
      x = Math.abs(x);
      if (x < 1e-6) return 1;
      if (x >= a) return 0;
      const px = Math.PI * x;
      return a * Math.sin(px) * Math.sin(px / a) / (px * px);
    };
  }
  const KERNELS = {
    nearest:  { r: 0.5, f: null },
    bilinear: { r: 1, f: x => { x = Math.abs(x); return x < 1 ? 1 - x : 0; } },
    catmull:  { r: 2, f: cubicBC(0, 0.5) },
    mitchell: { r: 2, f: cubicBC(1 / 3, 1 / 3) },
    bspline:  { r: 2, f: cubicBC(1, 0) },
    lanczos2: { r: 2, f: lanczos(2) },
    lanczos3: { r: 3, f: lanczos(3) },
  };
  Pipeline.KERNELS = KERNELS;

  function contribs(srcLen, dstLen, K) {
    const scale = srcLen / dstLen, fs = Math.max(1, scale), support = K.r * fs;
    const maxTaps = Math.ceil(2 * support) + 2;
    const start = new Int32Array(dstLen), count = new Int32Array(dstLen), wts = new Float32Array(dstLen * maxTaps);
    for (let i = 0; i < dstLen; i++) {
      const center = (i + 0.5) * scale - 0.5;
      let lo = Math.ceil(center - support), hi = Math.floor(center + support);
      if (lo < 0) lo = 0; if (hi > srcLen - 1) hi = srcLen - 1;
      if (hi < lo) { lo = hi = Math.min(srcLen - 1, Math.max(0, Math.round(center))); }
      let sum = 0, n = 0;
      for (let j = lo; j <= hi && n < maxTaps; j++, n++) { const v = K.f((j - center) / fs); wts[i * maxTaps + n] = v; sum += v; }
      if (Math.abs(sum) < 1e-9) { wts[i * maxTaps] = 1; n = 1; sum = 1; lo = Math.min(srcLen - 1, Math.max(0, Math.round(center))); }
      for (let t = 0; t < n; t++) wts[i * maxTaps + t] /= sum;
      start[i] = lo; count[i] = n;
    }
    return { start, count, wts, maxTaps };
  }
  function resampleChannel(src, sw, sh, dw, dh, kname) {
    if (sw === dw && sh === dh) return new Float32Array(src);
    if (kname === 'nearest') {
      const out = new Float32Array(dw * dh);
      const xs = new Int32Array(dw);
      for (let x = 0; x < dw; x++) xs[x] = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
      for (let y = 0; y < dh; y++) {
        const row = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh)) * sw;
        for (let x = 0; x < dw; x++) out[y * dw + x] = src[row + xs[x]];
      }
      return out;
    }
    const K = KERNELS[kname] || KERNELS.lanczos3;
    const cx = contribs(sw, dw, K), cy = contribs(sh, dh, K);
    const tmp = new Float32Array(dw * sh);
    for (let y = 0; y < sh; y++) {
      const srow = y * sw, trow = y * dw;
      for (let x = 0; x < dw; x++) {
        const st = cx.start[x], n = cx.count[x], base = x * cx.maxTaps;
        let s = 0;
        for (let t = 0; t < n; t++) s += src[srow + st + t] * cx.wts[base + t];
        tmp[trow + x] = s;
      }
    }
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const st = cy.start[y], n = cy.count[y], base = y * cy.maxTaps, orow = y * dw;
      for (let t = 0; t < n; t++) {
        const wgt = cy.wts[base + t], trow = (st + t) * dw;
        if (t === 0) for (let x = 0; x < dw; x++) out[orow + x] = tmp[trow + x] * wgt;
        else for (let x = 0; x < dw; x++) out[orow + x] += tmp[trow + x] * wgt;
      }
    }
    return out;
  }
  /* Optional hook: the UI can plug in the browser's own scaler (canvas drawImage). */
  Pipeline.browserResample = null;
  function resampleImage(img, dw, dh, kname) {
    dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
    if (dw === img.w && dh === img.h) return img;
    if (kname === 'browser' && Pipeline.browserResample) return Pipeline.browserResample(img, dw, dh);
    if (kname === 'browser') kname = 'bilinear';
    return { w: dw, h: dh,
      r: resampleChannel(img.r, img.w, img.h, dw, dh, kname),
      g: resampleChannel(img.g, img.w, img.h, dw, dh, kname),
      b: resampleChannel(img.b, img.w, img.h, dw, dh, kname) };
  }
  Pipeline.resampleImage = resampleImage;

  function roundTrip(img, pct, kname) {
    if (!pct || pct === 100) return img;
    const tw = Math.max(1, Math.round(img.w * pct / 100)), th = Math.max(1, Math.round(img.h * pct / 100));
    if (tw === img.w && th === img.h) return img;
    return resampleImage(resampleImage(img, tw, th, kname), img.w, img.h, kname);
  }

  /* Region resample: a rectangle (normalised 0..1 coordinates) gets its own
     round-trip resample with its own kernel, blended back with soft edges. */
  function regionResample(img, R, k) {
    if (!R || !R.on || !R.scale || R.scale === 100) return img;
    const { w, h } = img;
    const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
    const x0 = clampI(R.x * w, 0, w - 1), y0 = clampI(R.y * h, 0, h - 1);
    const x1 = clampI((R.x + R.w) * w, x0 + 1, w), y1 = clampI((R.y + R.h) * h, y0 + 1, h);
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 2 || rh < 2) return img;
    const sub = makeImage(rw, rh);
    for (const name of CH) for (let y = 0; y < rh; y++) sub[name].set(img[name].subarray((y + y0) * w + x0, (y + y0) * w + x1), y * rw);
    const res = roundTrip(sub, R.scale, R.kernel || 'bilinear');
    const feather = Math.max(0, (R.feather || 0) * k);
    const out = cloneImage(img);
    for (let y = 0; y < rh; y++) {
      const dy = Math.min(y, rh - 1 - y) + 0.5;
      for (let x = 0; x < rw; x++) {
        let m = 1;
        if (feather > 0) { const d = Math.min(dy, Math.min(x, rw - 1 - x) + 0.5); m = Math.min(1, d / feather); }
        const si = y * rw + x, di = (y + y0) * w + x + x0;
        out.r[di] += (res.r[si] - out.r[di]) * m;
        out.g[di] += (res.g[si] - out.g[di]) * m;
        out.b[di] += (res.b[si] - out.b[di]) * m;
      }
    }
    return out;
  }
  Pipeline.regionResample = regionResample;

  /* ------------------------------------------------------- the run */
  Pipeline.defaults = function () {
    return {
      seed: 1234,
      ch: { r: { x: 0, y: 0, z: 0 }, g: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 } },
      tone: { r: { shadows: 0, midtones: 0, highlights: 0 }, g: { shadows: 0, midtones: 0, highlights: 0 }, b: { shadows: 0, midtones: 0, highlights: 0 } },
      freq: {
        fine: 2, coarse: 16, view: 'full', colorNoise: false,
        low: { gain: 0, noise: 0, blur: 0, smooth: 0 },
        mid: { gain: 0, noise: 0, blur: 0, smooth: 0 },
        high: { gain: 0, noise: 0, blur: 0, smooth: 0 },
      },
      grad: { drift: 0, driftCell: 300, driftColor: true, tilt: 0, tiltAngle: 0, jitter: 0, jitterCell: 120 },
      jig: { on: false, block: 16, homog: 6, tol: 12, radius: 6, amount: 100, keepTone: true, flip: false, view: 'normal' },
      fourier: { x: 0, y: 0 },
      interp: { x: 0, y: 0, warp: 0, warpCell: 90, kernel: 'bicubic' },
      geo: { rotate: 0, tiltX: 0, tiltY: 0, crop: 0, posX: 0, posY: 0, restoreSize: false },
      rs: {
        kernel: 'lanczos3', roundTrip: 100, outScale: 100,
        region: { on: false, x: 0.3, y: 0.3, w: 0.4, h: 0.4, scale: 100, kernel: 'bilinear', feather: 12 },
      },
      out: { quality: 92 },
    };
  };

  /* src: image, P: params, k: pixel scale (preview/full), opts: { status(fn), tick(fn→Promise), forExport } */
  Pipeline.run = async function (src, P, k, opts) {
    opts = opts || {};
    const status = opts.status || (() => {});
    const tick = opts.tick || (() => Promise.resolve());
    const stage = async (label) => { status(label); await tick(); };

    await stage('Shifting colour channels…');
    const cs = channelShift(src, P.ch, k);
    let img = cs.img;
    const valid = validRectAll(src.w, src.h, P, k);

    await stage('Adjusting tone per channel…');
    img = toneAdjust(img, P.tone || {});

    await stage('Editing frequency bands…');
    img = frequencyEdit(img, P.freq, k, P.seed, opts.forExport ? 'full' : P.freq.view);

    await stage('Perturbing gradients…');
    img = gradientPerturb(img, P.grad, k, P.seed);

    await stage('Swapping flat blocks…');
    img = blockSwap(img, P.jig, k, P.seed, !opts.forExport && P.jig && P.jig.view === 'highlight');
    const jigStats = img.swapCount != null ? { swaps: img.swapCount, eligible: img.eligibleCount, blocks: img.blockCount } : null;

    await stage('Phase-shifting (Fourier)…');
    img = fourierShift(img, P.fourier || {}, k);

    await stage('Forcing interpolation…');
    img = interpForce(img, P.interp || {}, k, P.seed);

    await stage('Fitting the frame…');
    const preW = img.w, preH = img.h;
    img = geometry(img, P.geo, k, valid);
    if (P.geo.restoreSize && (img.w !== preW || img.h !== preH)) img = resampleImage(img, preW, preH, P.rs.kernel);

    await stage('Resampling…');
    img = roundTrip(img, P.rs.roundTrip, P.rs.kernel);
    if (P.rs.outScale && P.rs.outScale !== 100) img = resampleImage(img, img.w * P.rs.outScale / 100, img.h * P.rs.outScale / 100, P.rs.kernel);
    img = regionResample(img, P.rs.region, k);

    img.jigStats = jigStats;
    return img;
  };

  Pipeline.makeImage = makeImage;
  Pipeline.cloneImage = cloneImage;
  Pipeline.fromRGBA = fromRGBA;
  Pipeline.toRGBA = toRGBA;
  Pipeline.mulberry32 = mulberry32;

  if (typeof module !== 'undefined' && module.exports) module.exports = Pipeline;
  else root.Pipeline = Pipeline;
})(typeof self !== 'undefined' ? self : this);
