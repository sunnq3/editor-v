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
    const dx = (I.x || 0) * k, dy = (I.y || 0) * k, amp = (I.warp || 0) * k, jit = (I.jitter || 0) * k;
    if (!dx && !dy && !amp && !jit) return img;
    const rnd = jit ? mulberry32(mixSeed(seed, 43)) : null;
    let jx = null, jy = null;
    if (jit) { jx = new Float32Array(img.w * img.h); jy = new Float32Array(img.w * img.h); for (let i = 0; i < jx.length; i++) { jx[i] = (rnd() * 2 - 1) * jit; jy[i] = (rnd() * 2 - 1) * jit; } }
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
          const sx = x - dx - (fx ? amp * fx[i] : 0) - (jx ? jx[i] : 0), sy = y - dy - (fy ? amp * fy[i] : 0) - (jy ? jy[i] : 0);
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
    const id = Math.max(Math.abs(I.x || 0), Math.abs(I.y || 0)) + (I.warp || 0) + (I.jitter || 0);
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

  /* ------------------------------------------ 6. sensor grid (Bayer) */
  /* Re-samples the picture through a 2×2 colour-filter mosaic (one colour per
     pixel) and rebuilds the missing colours, the way a camera does. */
  const CFA = { rggb: ['r', 'g', 'g', 'b'], bggr: ['b', 'g', 'g', 'r'], grbg: ['g', 'r', 'b', 'g'], gbrg: ['g', 'b', 'r', 'g'] };
  function bayerMosaic(img, pattern) {
    const { w, h } = img, m = new Float32Array(w * h);
    const cfa = CFA[pattern] || CFA.rggb;
    for (let y = 0; y < h; y++) {
      const row = y * w, ry = (y & 1) * 2;
      const c0 = img[cfa[ry]], c1 = img[cfa[ry + 1]];
      for (let x = 0; x < w; x++) m[row + x] = (x & 1) ? c1[row + x] : c0[row + x];
    }
    return m;
  }
  /* Malvar-He-Cutler gradient-corrected linear demosaicing (5×5 filters), or
     plain bilinear. Returns a full image. */
  function demosaic(m, w, h, pattern, method) {
    const cfa = CFA[pattern] || CFA.rggb;
    const out = makeImage(w, h);
    const at = (x, y) => { if (x < 0) x = -x; else if (x >= w) x = 2 * w - 2 - x; if (y < 0) y = -y; else if (y >= h) y = 2 * h - 2 - y; return m[y * w + x]; };
    const mhc = method !== 'bilinear';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = cfa[(y & 1) * 2 + (x & 1)];           // colour this pixel carries
        const v = m[y * w + x];
        const N = at(x, y - 1), S = at(x, y + 1), E = at(x + 1, y), W = at(x - 1, y);
        const NE = at(x + 1, y - 1), NW = at(x - 1, y - 1), SE = at(x + 1, y + 1), SW = at(x - 1, y + 1);
        const N2 = at(x, y - 2), S2 = at(x, y + 2), E2 = at(x + 2, y), W2 = at(x - 2, y);
        let r, g, b;
        if (c === 'g') {
          g = v;
          // which non-green colour sits to the left/right of this green?
          const horiz = cfa[(y & 1) * 2 + ((x + 1) & 1)];  // colour of the horizontal neighbours
          let hVal, vVal;
          if (mhc) {
            hVal = (5 * v + 4 * (E + W) - (NE + NW + SE + SW) - (E2 + W2) + 0.5 * (N2 + S2)) / 8;
            vVal = (5 * v + 4 * (N + S) - (NE + NW + SE + SW) - (N2 + S2) + 0.5 * (E2 + W2)) / 8;
          } else { hVal = (E + W) / 2; vVal = (N + S) / 2; }
          if (horiz === 'r') { r = hVal; b = vVal; } else { b = hVal; r = vVal; }
        } else {
          const gv = mhc ? (4 * v + 2 * (N + S + E + W) - (N2 + S2 + E2 + W2)) / 8 : (N + S + E + W) / 4;
          const dv = mhc ? (6 * v + 2 * (NE + NW + SE + SW) - 1.5 * (N2 + S2 + E2 + W2)) / 8 : (NE + NW + SE + SW) / 4;
          g = gv;
          if (c === 'r') { r = v; b = dv; } else { b = v; r = dv; }
        }
        const i = y * w + x;
        out.r[i] = r; out.g[i] = g; out.b[i] = b;
      }
    }
    return out;
  }
  const BAYER2 = [[0, 2], [3, 1]];
  function bayerMatrix(n) {
    let M = BAYER2;
    while (M.length < n) {
      const s = M.length, next = [];
      for (let y = 0; y < 2 * s; y++) { next.push([]); for (let x = 0; x < 2 * s; x++) next[y].push(4 * M[y % s][x % s] + BAYER2[(y / s) | 0][(x / s) | 0]); }
      M = next;
    }
    return M;
  }
  /* A soft mask covering roughly `coverage` % of the picture in random patches. */
  function patchMask(w, h, fullW, fullH, cell, coverage, seed) {
    if (coverage >= 100) return null;
    const [nx, ny] = cellsFor(fullW, fullH, Math.max(4, cell));
    const field = noiseField(w, h, nx, ny, seed);
    const sample = [];
    for (let i = 0; i < field.length; i += Math.max(1, Math.floor(field.length / 8192))) sample.push(field[i]);
    sample.sort((a, b) => a - b);
    const t = sample[Math.min(sample.length - 1, Math.floor(sample.length * (1 - coverage / 100)))];
    const mask = new Float32Array(w * h);
    for (let i = 0; i < mask.length; i++) { let m = (field[i] - t) / 0.2 + 0.5; mask[i] = m < 0 ? 0 : m > 1 ? 1 : m; }
    return mask;
  }
  const PASS_ORDER = ['rggb', 'grbg', 'gbrg', 'bggr'];
  function sensorGrid(img, Bp, k, seed) {
    if (!Bp) return img;
    const { w, h } = img, N = w * h;
    k = k || 1;
    let out = img;
    if (Bp.on && Bp.mix > 0 && w >= 4 && h >= 4) {
      const passes = Math.max(1, Math.min(4, Math.round(Bp.passes || 1)));
      const noiseAmp = Bp.noise || 0;
      const mask = noiseAmp > 0 ? patchMask(w, h, w / k, h / k, Bp.noiseCell || 200, Bp.coverage == null ? 100 : Bp.coverage, mixSeed(seed || 0, 61)) : null;
      const rnd = mulberry32(mixSeed(seed || 0, 62));
      let cur = img;
      const start = Math.max(0, PASS_ORDER.indexOf(Bp.pattern));
      for (let pass = 0; pass < passes; pass++) {
        const pat = PASS_ORDER[(start + pass) % 4];
        const m = bayerMosaic(cur, pat);
        if (noiseAmp > 0) {
          // raw sensor noise on the single-colour photosites, before the colours are rebuilt
          for (let i = 0; i < N; i += 2) {
            // Box-Muller: two Gaussian numbers per iteration
            const u1 = Math.max(1e-12, rnd()), u2 = rnd(), rad = Math.sqrt(-2 * Math.log(u1));
            const g1 = rad * Math.cos(2 * Math.PI * u2), g2 = rad * Math.sin(2 * Math.PI * u2);
            let s1 = noiseAmp, s2 = noiseAmp;
            if (Bp.noiseShadow) {
              // like a photo after its tone curve: noise shows most in the shadows
              const f1 = Math.min(2.5, Math.max(0.4, Math.sqrt(160 / Math.max(8, m[i]))));
              const f2 = Math.min(2.5, Math.max(0.4, Math.sqrt(160 / Math.max(8, i + 1 < N ? m[i + 1] : 160))));
              s1 *= f1; s2 *= f2;
            }
            if (mask) { s1 *= mask[i]; s2 *= i + 1 < N ? mask[i + 1] : 0; }
            m[i] += g1 * s1;
            if (i + 1 < N) m[i + 1] += g2 * s2;
          }
        }
        cur = demosaic(m, w, h, pat, Bp.method);
      }
      const t = Math.min(1, Bp.mix / 100);
      if (t >= 1) out = cur;
      else {
        out = cloneImage(img);
        for (const name of CH) { const a = out[name], d = cur[name]; for (let i = 0; i < N; i++) a[i] += (d[i] - a[i]) * t; }
      }
    }
    if (Bp.dither > 0) {
      const n = Bp.ditherSize === 2 ? 2 : Bp.ditherSize === 8 ? 8 : 4;
      const M = bayerMatrix(n), n2 = n * n, amp = Bp.dither;
      if (out === img) out = cloneImage(img);
      CH.forEach((name, ci) => {
        const ch = out[name];
        const ox = Bp.ditherColor ? ci : 0, oy = Bp.ditherColor ? (ci * 2) % n : 0;
        for (let y = 0; y < h; y++) {
          const Mrow = M[(y + oy) % n], row = y * w;
          for (let x = 0; x < w; x++) ch[row + x] += amp * ((Mrow[(x + ox) % n] + 0.5) / n2 - 0.5) * 2;
        }
      });
    }
    return out;
  }
  Pipeline.sensorGrid = sensorGrid;
  Pipeline.demosaic = demosaic;
  Pipeline.bayerMosaic = bayerMosaic;

  /* ------------------------------------------------------- the run */
  Pipeline.defaults = function () {
    return {
      seed: 1234,
      photo: { sharpen: 0, radius: 1, masking: 0, nrLuma: 0, nrColor: 0, texture: 0, grain: 0, grainSize: 1, grainRough: 0, grainColor: false },
      cleanup: { dering: 0, deblock: 0, blockSize: 8, deband: 0, chroma: 0, chromaEdge: true, gamut: 0 },
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
      interp: { x: 0, y: 0, warp: 0, warpCell: 90, jitter: 0, kernel: 'bicubic' },
      geo: { rotate: 0, tiltX: 0, tiltY: 0, crop: 0, posX: 0, posY: 0, restoreSize: false },
      rs: { kernel: 'lanczos3', roundTrip: 100, outScale: 100 },
      bayer: { on: false, pattern: 'rggb', method: 'mhc', mix: 100, passes: 1, noise: 0, noiseShadow: true, coverage: 100, noiseCell: 200, dither: 0, ditherSize: 4, ditherColor: false },
      out: { quality: 92 },
    };
  };

  /* ------------------------------------------------- 0. photo edits */
  /* Classic developing controls, done on luminance (YCbCr) so colours stay put:
     noise reduction (luminance, colour), texture, sharpening with edge
     masking, and film-like grain. */
  function toYCbCr(img) {
    const N = img.w * img.h, Y = new Float32Array(N), Cb = new Float32Array(N), Cr = new Float32Array(N);
    const r = img.r, g = img.g, b = img.b;
    for (let i = 0; i < N; i++) {
      Y[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
      Cb[i] = -0.168736 * r[i] - 0.331264 * g[i] + 0.5 * b[i];
      Cr[i] = 0.5 * r[i] - 0.418688 * g[i] - 0.081312 * b[i];
    }
    return { Y, Cb, Cr };
  }
  function fromYCbCr(Y, Cb, Cr, w, h) {
    const out = makeImage(w, h), N = w * h;
    for (let i = 0; i < N; i++) {
      out.r[i] = Y[i] + 1.402 * Cr[i];
      out.g[i] = Y[i] - 0.344136 * Cb[i] - 0.714136 * Cr[i];
      out.b[i] = Y[i] + 1.772 * Cb[i];
    }
    return out;
  }
  function photoActive(E) { return !!(E && (E.sharpen || E.nrLuma || E.nrColor || E.texture || E.grain)); }
  function photoEdit(img, E, k, seed) {
    if (!photoActive(E)) return img;
    const { w, h } = img, N = w * h;
    let { Y, Cb, Cr } = toYCbCr(img);
    // 1. noise reduction
    if (E.nrLuma > 0) {
      Y = bilateral(Y, w, h, E.nrLuma * 0.4);
      if (E.nrLuma > 50) Y = bilateral(Y, w, h, (E.nrLuma - 50) * 0.4);
    }
    if (E.nrColor > 0) {
      const s = E.nrColor / 100;
      Cb = bilateral(Cb, w, h, 20 + E.nrColor * 0.6); Cr = bilateral(Cr, w, h, 20 + E.nrColor * 0.6);
      const sig = s * 3.5 * k;
      if (sig > 0.3) { Cb = gaussBlur(Cb, w, h, sig); Cr = gaussBlur(Cr, w, h, sig); }
    }
    // 2. texture: mid-fine detail band on luminance
    if (E.texture) {
      const b1 = gaussBlur(Y, w, h, 1.2 * k), b2 = gaussBlur(Y, w, h, 5 * k), t = E.texture / 100 * 1.6;
      for (let i = 0; i < N; i++) Y[i] += t * (b1[i] - b2[i]);
    }
    // 3. sharpen: unsharp mask with optional edge masking
    if (E.sharpen > 0) {
      const radius = Math.max(0.3, (E.radius || 1) * k);
      const b = gaussBlur(Y, w, h, radius), amt = E.sharpen / 100;
      let mask = null;
      if (E.masking > 0) {
        const t = E.masking / 100 * 14, g = gaussBlur(Y, w, h, 1 * k);
        mask = new Float32Array(N);
        for (let y = 0; y < h; y++) {
          const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
          for (let x = 0; x < w; x++) {
            const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
            const gx = (g[y * w + x1] - g[y * w + x0]) * 0.5, gy = (g[y1 * w + x] - g[y0 * w + x]) * 0.5;
            let m = (Math.sqrt(gx * gx + gy * gy) - t) / 3 + 0.5;
            mask[y * w + x] = m < 0 ? 0 : m > 1 ? 1 : m;
          }
        }
      }
      for (let i = 0; i < N; i++) Y[i] += amt * (Y[i] - b[i]) * (mask ? mask[i] : 1);
    }
    // 4. grain
    if (E.grain > 0) {
      const amp = E.grain / 100 * 24;
      const makeNoise = (salt) => {
        const rnd = mulberry32(mixSeed(seed || 0, salt));
        let n = new Float32Array(N);
        for (let i = 0; i < N; i += 2) {
          const u1 = Math.max(1e-12, rnd()), u2 = rnd(), rad = Math.sqrt(-2 * Math.log(u1));
          n[i] = rad * Math.cos(2 * Math.PI * u2); if (i + 1 < N) n[i + 1] = rad * Math.sin(2 * Math.PI * u2);
        }
        const size = Math.max(1, E.grainSize || 1);
        if (size > 1) { n = gaussBlur(n, w, h, (size - 1) * 0.7 * k); const sd = stdOf(n) || 1; for (let i = 0; i < N; i++) n[i] /= sd; }
        return n;
      };
      let rough = null;
      if (E.grainRough > 0) {
        const [nx, ny] = cellsFor(w / k, h / k, 40);
        rough = noiseField(w, h, nx, ny, mixSeed(seed || 0, 73));
      }
      const nY = makeNoise(71), r = (E.grainRough || 0) / 100;
      for (let i = 0; i < N; i++) Y[i] += amp * nY[i] * (rough ? 1 + r * rough[i] : 1);
      if (E.grainColor) {
        const nB = makeNoise(72), nR = makeNoise(74);
        for (let i = 0; i < N; i++) { const a = amp * 0.5 * (rough ? 1 + r * rough[i] : 1); Cb[i] += a * nB[i]; Cr[i] += a * nR[i]; }
      }
    }
    return fromYCbCr(Y, Cb, Cr, w, h);
  }
  Pipeline.photoEdit = photoEdit;

  /* ----------------------------------------- 0b. cleanup / repair */
  /* Removes the junk that heavy layering leaves behind, all on luminance /
     chroma so nothing shifts hue: resampling ringing & grid checker, 8-px
     JPEG blocking, gradient banding, chroma speckle, and out-of-gamut colour. */
  function median3(src, w, h) {
    const out = new Float32Array(w * h);
    const v = new Float32Array(9);
    // partial selection: we only need the 5th-smallest of 9
    const med9 = () => {
      for (let a = 0; a < 5; a++) {
        let m = a;
        for (let b = a + 1; b < 9; b++) if (v[b] < v[m]) m = b;
        const t = v[a]; v[a] = v[m]; v[m] = t;
      }
      return v[4];
    };
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y, y2 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x, x2 = x < w - 1 ? x + 1 : w - 1;
        v[0] = src[y0 * w + x0]; v[1] = src[y0 * w + x1]; v[2] = src[y0 * w + x2];
        v[3] = src[y1 * w + x0]; v[4] = src[y1 * w + x1]; v[5] = src[y1 * w + x2];
        v[6] = src[y2 * w + x0]; v[7] = src[y2 * w + x1]; v[8] = src[y2 * w + x2];
        out[y * w + x] = med9();
      }
    }
    return out;
  }
  Pipeline.median3 = median3;

  /* Softens discontinuities on the `block`-pixel grid, but only where the step
     is small (a compression edge, not a real one). */
  function deblock(Y, w, h, strength, block) {
    const out = new Float32Array(Y);
    const T = 3 + strength * 0.25, a = Math.min(0.5, strength / 100 * 0.5);
    // vertical boundaries (columns)
    for (let c = block; c < w; c += block) {
      for (let y = 0; y < h; y++) {
        const i = y * w + c, d = out[i] - out[i - 1];
        if (d === 0 || Math.abs(d) > T) continue;
        const act = Math.abs(out[i - 1] - (c - 2 >= 0 ? out[i - 2] : out[i - 1])) + Math.abs((c + 1 < w ? out[i + 1] : out[i]) - out[i]);
        if (act > T * 1.5) continue;                 // busy neighbourhood: leave it
        out[i] -= d * a; out[i - 1] += d * a;
      }
    }
    // horizontal boundaries (rows)
    for (let r = block; r < h; r += block) {
      for (let x = 0; x < w; x++) {
        const i = r * w + x, j = (r - 1) * w + x, d = out[i] - out[j];
        if (d === 0 || Math.abs(d) > T) continue;
        const act = Math.abs(out[j] - (r - 2 >= 0 ? out[(r - 2) * w + x] : out[j])) + Math.abs((r + 1 < h ? out[(r + 1) * w + x] : out[i]) - out[i]);
        if (act > T * 1.5) continue;
        out[i] -= d * a; out[j] += d * a;
      }
    }
    return out;
  }
  Pipeline.deblock = deblock;

  /* Adds tiny dither where the image is locally flat, so smooth gradients stop
     stepping into visible bands; detailed areas are left alone. */
  function deband(Y, w, h, strength, k, seed) {
    const out = new Float32Array(Y), amp = strength / 100 * 2.2;
    const rnd = mulberry32(mixSeed(seed || 0, 81));
    const flatT = 3.5;
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        const gx = (Y[y * w + x1] - Y[y * w + x0]) * 0.5, gy = (Y[y1 * w + x] - Y[y0 * w + x]) * 0.5;
        const g = Math.sqrt(gx * gx + gy * gy);
        const flat = g >= flatT ? 0 : 1 - g / flatT;
        if (flat <= 0) continue;
        // triangular dither (sum of two uniforms) blends better than flat noise
        out[y * w + x] += amp * flat * (rnd() + rnd() - 1);
      }
    }
    return out;
  }
  Pipeline.deband = deband;

  /* Pulls out-of-range pixels back into gamut by reducing their saturation
     (keeping luminance), which avoids the hue shifts a hard RGB clip causes. */
  function gamutSafe(Y, Cb, Cr, w, h, amount) {
    const N = w * h;
    for (let i = 0; i < N; i++) {
      const y = Y[i], cb = Cb[i], cr = Cr[i];
      let r = y + 1.402 * cr, g = y - 0.344136 * cb - 0.714136 * cr, b = y + 1.772 * cb;
      if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) continue;
      // largest s in [0,1] with y + s*(channel-y) inside [0,255]
      let s = 1;
      const fit = (v) => { if (v < 0) s = Math.min(s, (y <= 0 || y === v) ? 0 : y / (y - v)); else if (v > 255) s = Math.min(s, (y >= 255 || y === v) ? 0 : (255 - y) / (v - y)); };
      fit(r); fit(g); fit(b);
      if (s < 0) s = 0; if (s > 1) s = 1;
      s = 1 - (1 - s) * amount;                      // amount lets it be partial
      Cb[i] = cb * s; Cr[i] = cr * s;
    }
  }
  Pipeline.gamutSafe = gamutSafe;

  /* Attenuates the finest luminance band where there is no real structure —
     exactly the flat-area oscillation that is resampling ringing and grid
     checker — while leaving true edges and textured detail intact. */
  function dering(Y, w, h, strength, k) {
    const lp = gaussBlur(Y, w, h, 0.8 * (k || 1)), a = strength / 100, out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        const gx = (lp[y * w + x1] - lp[y * w + x0]) * 0.5, gy = (lp[y1 * w + x] - lp[y0 * w + x]) * 0.5;
        const keep = Math.min(1, (Math.abs(gx) + Math.abs(gy)) / 8);   // 0 flat → attenuate, 1 edge → keep
        const i = y * w + x, att = a * (1 - keep);
        out[i] = lp[i] + (Y[i] - lp[i]) * (1 - att);
      }
    }
    return out;
  }
  Pipeline.dering = dering;

  function cleanupActive(C) { return !!(C && (C.dering || C.deblock || C.deband || C.chroma || C.gamut)); }
  function cleanup(img, C, k, seed) {
    if (!cleanupActive(C)) return img;
    const { w, h } = img, N = w * h;
    let { Y, Cb, Cr } = toYCbCr(img);
    if (C.dering > 0) Y = dering(Y, w, h, C.dering, k);
    if (C.deblock > 0) Y = deblock(Y, w, h, C.deblock, Math.max(2, Math.round((C.blockSize || 8) * k)));
    if (C.deband > 0) Y = deband(Y, w, h, C.deband, k, seed);
    if (C.chroma > 0) {
      const sig = C.chroma / 100 * 3 * k;
      if (C.chromaEdge) { Cb = bilateral(Cb, w, h, C.chroma * 0.5); Cr = bilateral(Cr, w, h, C.chroma * 0.5); }
      else if (sig > 0.25) { Cb = gaussBlur(Cb, w, h, sig); Cr = gaussBlur(Cr, w, h, sig); }
    }
    if (C.gamut > 0) gamutSafe(Y, Cb, Cr, w, h, C.gamut / 100);
    return fromYCbCr(Y, Cb, Cr, w, h);
  }
  Pipeline.cleanup = cleanup;

  /* ------------------------------------------------------ stages */
  function cropImage(img, V) {
    const { w, h } = img;
    const x0 = Math.max(0, V.x0), y0 = Math.max(0, V.y0), x1 = Math.min(w, V.x1), y1 = Math.min(h, V.y1);
    if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return img;
    const ow = x1 - x0, oh = y1 - y0, out = makeImage(ow, oh);
    for (const name of CH) { const src = img[name], dst = out[name]; for (let y = 0; y < oh; y++) dst.set(src.subarray((y + y0) * w + x0, (y + y0) * w + x1), y * ow); }
    return out;
  }
  Pipeline.cropImage = cropImage;

  /* Each stage, runnable on its own. `id` names the parameter section. The
     stages that smear edges (channel shift, phase shift, interpolation
     forcing) trim themselves, so the result never carries a bad border. */
  const STAGES = {
    cleanup: { label: 'Cleaning up…', run: (img, P, k) => cleanup(img, P.cleanup || {}, k, P.seed) },
    photo: { label: 'Developing (edit photo)…', run: (img, P, k) => photoEdit(img, P.photo || {}, k, P.seed) },
    ch: { label: 'Shifting colour channels…', run: (img, P, k) => cropImage(channelShift(img, P.ch, k).img, validRect(img.w, img.h, P.ch, k)) },
    tone: { label: 'Adjusting tone per channel…', run: (img, P) => toneAdjust(img, P.tone || {}) },
    freq: { label: 'Editing frequency bands…', run: (img, P, k, o) => frequencyEdit(img, P.freq, k, P.seed, o.forExport ? 'full' : P.freq.view) },
    grad: { label: 'Perturbing gradients…', run: (img, P, k) => gradientPerturb(img, P.grad, k, P.seed) },
    jig: { label: 'Swapping flat blocks…', run: (img, P, k, o) => blockSwap(img, P.jig, k, P.seed, !o.forExport && P.jig && P.jig.view === 'highlight') },
    fourier: {
      label: 'Phase-shifting (Fourier)…',
      run: (img, P, k) => {
        const F = P.fourier || {}, out = fourierShift(img, F, k);
        const fd = Math.max(Math.abs(F.x || 0), Math.abs(F.y || 0));
        return fd ? cropImage(out, insetRect({ x0: 0, y0: 0, x1: img.w, y1: img.h }, fd * k + 2, img.w, img.h)) : out;
      },
    },
    interp: {
      label: 'Forcing interpolation…',
      run: (img, P, k) => {
        const I = P.interp || {}, out = interpForce(img, I, k, P.seed);
        const id = Math.max(Math.abs(I.x || 0), Math.abs(I.y || 0)) + (I.warp || 0) + (I.jitter || 0);
        return id ? cropImage(out, insetRect({ x0: 0, y0: 0, x1: img.w, y1: img.h }, id * k + (I.kernel === 'lanczos3' ? 3 : I.kernel === 'bilinear' ? 1 : 2), img.w, img.h)) : out;
      },
    },
    geo: {
      label: 'Fitting the frame…',
      run: (img, P, k) => {
        const preW = img.w, preH = img.h;
        let out = geometry(img, P.geo, k, null);
        if (P.geo.restoreSize && (out.w !== preW || out.h !== preH)) out = resampleImage(out, preW, preH, P.rs.kernel);
        return out;
      },
    },
    rs: {
      label: 'Resampling…',
      run: (img, P) => {
        let out = roundTrip(img, P.rs.roundTrip, P.rs.kernel);
        if (P.rs.outScale && P.rs.outScale !== 100) out = resampleImage(out, out.w * P.rs.outScale / 100, out.h * P.rs.outScale / 100, P.rs.kernel);
        return out;
      },
    },
    bayer: { label: 'Bayer sensor grid…', run: (img, P, k) => sensorGrid(img, P.bayer, k, P.seed) },
  };
  Pipeline.STAGE_ORDER = ['photo', 'ch', 'tone', 'freq', 'grad', 'jig', 'fourier', 'interp', 'geo', 'rs', 'bayer', 'cleanup'];

  /* Runs one stage. opts: { status, tick, forExport }. */
  Pipeline.runStage = async function (img, id, P, k, opts) {
    opts = opts || {};
    const st = STAGES[id];
    if (!st) return img;
    if (opts.status) opts.status(st.label);
    if (opts.tick) await opts.tick();
    const out = st.run(img, P, k, opts);
    if (id === 'jig') out.jigStats = out.swapCount != null ? { swaps: out.swapCount, eligible: out.eligibleCount, blocks: out.blockCount } : null;
    return out;
  };
  /* Size of the image after one stage, for a w×h input at full resolution. */
  Pipeline.stageOutputSize = function (w, h, id, P) {
    const full = { x0: 0, y0: 0, x1: w, y1: h };
    if (id === 'ch') { const V = validRect(w, h, P.ch, 1); return { w: V.x1 - V.x0, h: V.y1 - V.y0 }; }
    if (id === 'fourier') { const F = P.fourier || {}, fd = Math.max(Math.abs(F.x || 0), Math.abs(F.y || 0)); const V = fd ? insetRect(full, fd + 2, w, h) : full; return { w: V.x1 - V.x0, h: V.y1 - V.y0 }; }
    if (id === 'interp') { const I = P.interp || {}, d = Math.max(Math.abs(I.x || 0), Math.abs(I.y || 0)) + (I.warp || 0) + (I.jitter || 0); const V = d ? insetRect(full, d + (I.kernel === 'lanczos3' ? 3 : I.kernel === 'bilinear' ? 1 : 2), w, h) : full; return { w: V.x1 - V.x0, h: V.y1 - V.y0 }; }
    if (id === 'geo') { if (P.geo.restoreSize) return { w, h }; const { rect } = frameFor(w, h, P.geo, null); return { w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)) }; }
    if (id === 'rs') { const s = (P.rs.outScale || 100) / 100; return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) }; }
    return { w, h };
  };
  /* Round-trip resample used between steps. */
  Pipeline.resampleStep = function (img, pct, kname) { return roundTrip(img, pct, kname); };

  /* src: image, P: params, k: pixel scale (preview/full), opts: { status(fn), tick(fn→Promise), forExport }.
     Runs every stage in order (the one-pass pipeline). */
  Pipeline.run = async function (src, P, k, opts) {
    opts = opts || {};
    let img = src, jigStats = null;
    for (const id of Pipeline.STAGE_ORDER) {
      img = await Pipeline.runStage(img, id, P, k, opts);
      if (id === 'jig') jigStats = img.jigStats || null;
    }
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
