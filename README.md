# editor-v

A private, in-browser image editor for subtle, per-pixel perturbation. Open `index.html`, drop in a picture, move sliders, download a JPEG. Nothing is uploaded and nothing is stored: all processing happens in your browser's memory, and the page's Content-Security-Policy forbids network connections outright.

## Run it

No build, no server, no dependencies.

- Double-click `index.html`, **or**
- serve the folder (`python3 -m http.server`) and open it.

Works in current Chrome, Edge, Firefox and Safari. Formats: anything your browser can decode (JPEG, PNG, WebP, GIF, BMP, AVIF…). HEIC is not decodable by most browsers.

## How it works

The tool is step-by-step. Each tab is one stage; its preview shows the **working image plus that tab's settings only**. **Apply step** bakes the stage into the working image at full resolution — optionally followed by a **"then resample"** round trip (temporary size and kernel of your choice), so every later stage starts from freshly re-interpolated pixels rather than from a float buffer. Applying clears the tab's sliders because the effect now lives in the pixels. **Undo last step**, **Revert to original**, and a list of applied steps live on the Save tab; **Download JPEG** on the top bar saves what the preview shows from any tab; **Encode to JPEG and keep editing** does a real JPEG round trip into the working image without leaving the page.

## The stages

**Colour channel shifts** — move each of the red, green and blue layers sideways (X), up/down (Y) and zoom it from the centre (Z), with sub-pixel precision. Edges that end up missing a colour are trimmed off the frame automatically.

**Tone per channel** — shadows, midtones and highlights (lift / gamma / gain) for red, green and blue separately.

**Frequency bands** — the image is split into three detail layers (fine / medium / coarse, with adjustable boundaries). Each layer has its own boost/cut, band-limited noise, blur, and edge-aware smoothing. A "show in the preview" switch lets you look at one layer alone.

**Gradient perturbation** — smooth random drift of brightness and colour (adjustable patch size), a directional lighting tilt, and random edge jitter that strengthens or weakens edges in patches. All randomness comes from one "pattern number", so results are repeatable.

**Invisible jigsaw** — flat blocks (sky, walls, skin, bokeh) are swapped with similar flat blocks nearby. By default only the grain moves and every block keeps its own average colour, so the swap is invisible even across gradients. Block size, flatness, similarity, search distance, amount, optional flips, and a preview-only outline of the swapped blocks.

**Phase shift (Fourier translation)** — exact band-limited sub-pixel translation: each row and column goes through an FFT, a linear phase ramp and an inverse FFT (sinc interpolation). Lines are extended with a slope-continuous reflection and tapered inside the padding, so edges don't ring; integer shifts come back exact to 4 decimals.

**Interpolation forcing** — a global fraction-of-a-pixel shift, a small smooth random warp, and an optional per-pixel random jitter, so every output pixel is a blend of neighbours at its own phase; bilinear, bicubic or Lanczos-3.

**Frame** — micro rotate, perspective tilt (top/bottom and left/right), trim, and a sliding window. The frame always auto-fits to the area that has real picture in it, so there are never empty, black or white corners. Optionally stretch the result back to the original pixel size.

**Resampling** — re-interpolate the whole image (scale to a temporary size and back) with a choice of kernel: Lanczos-3, Lanczos-2, Catmull-Rom, Mitchell, B-spline, bilinear, nearest, or the browser's own scaler. Plus a final output size.

**Bayer sensor grid** — the image is re-sampled through a 2×2 colour-filter mosaic (RGGB / BGGR / GRBG / GBRG) and demosaiced back with Malvar-He-Cutler gradient-corrected interpolation (or bilinear), stamping a sensor-like grid structure into the pixel statistics; 1–4 passes with the grid phase rotating each pass; mix amount. Raw sensor noise is added to the single-colour photosites *before* the colours are rebuilt, so it carries a camera's colour-noise structure; optionally shadow-weighted, and optionally confined to random patches (coverage % and patch size). Also an ordered (Bayer-matrix) dither, 2×2 / 4×4 / 8×8, optionally with a different phase per colour channel.

**Live preview** — a reduced-size preview re-renders as you drag (half-size while moving, full preview on release). "Hold: before step" (or hold `C`) shows the working image as it was before the current tab. The **Changes ×8 / ×32** view shows the difference between the result and the working image, amplified (black = unchanged), with the share of pixel values that moved, the mean and the maximum change in the status line — the way to see that a subtle step such as a 97 % resample really touched the pixels.

**Save** — JPEG at a chosen quality, rendered at full resolution with the same pipeline. Going through the browser's encoder also drops EXIF/GPS metadata. Every export gets a random four-digit name (`4831.jpg`), never repeated in a session, so versions don't get mixed up. Settings can be saved to and loaded from a small `.json` file.

Every slider says in plain language what moving it left or right does.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell and CSP |
| `style.css` | Dark UI, violet/blue accents, no external fonts |
| `pipeline.js` | All image math on Float32 channels; no DOM access, runs in Node too |
| `app.js` | Controls (generated from a spec), preview scheduling, export |

## Notes

- Images above 20 megapixels are reduced on load to keep memory sane.
- Pixel-unit settings (shifts, blur radii, patch sizes) are in full-resolution pixels; the preview scales them so what you see matches what you save.
- Applying a step on a 12 MP photo takes from a fraction of a second (tone, jigsaw) to a few seconds (Fourier shift ≈4 s, Lanczos interpolation forcing); the page shows progress. Undo keeps the last three working images in memory.
- Output is always a fresh JPEG encode of the processed pixels, even with every slider at zero.
