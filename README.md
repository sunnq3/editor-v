# editor-v

A private, in-browser image editor for subtle, per-pixel perturbation. Open `index.html`, drop in a picture, move sliders, download a JPEG. Nothing is uploaded and nothing is stored: all processing happens in your browser's memory, and the page's Content-Security-Policy forbids network connections outright.

## Run it

No build, no server, no dependencies.

- Double-click `index.html`, **or**
- serve the folder (`python3 -m http.server`) and open it.

Works in current Chrome, Edge, Firefox and Safari. Formats: anything your browser can decode (JPEG, PNG, WebP, GIF, BMP, AVIF…). HEIC is not decodable by most browsers.

## What it does

**Colour channel shifts** — move each of the red, green and blue layers sideways (X), up/down (Y) and zoom it from the centre (Z), with sub-pixel precision. Edges that end up missing a colour are trimmed off the frame automatically.

**Frequency bands** — the image is split into three detail layers (fine / medium / coarse, with adjustable boundaries). Each layer has its own boost/cut, band-limited noise, blur, and edge-aware smoothing. A "show in the preview" switch lets you look at one layer alone.

**Gradient perturbation** — smooth random drift of brightness and colour (adjustable patch size), a directional lighting tilt, and random edge jitter that strengthens or weakens edges in patches. All randomness comes from one "pattern number", so results are repeatable.

**Frame** — micro rotate, perspective tilt (top/bottom and left/right), trim, and a sliding window. The frame always auto-fits to the area that has real picture in it, so there are never empty, black or white corners. Optionally stretch the result back to the original pixel size.

**Resampling** — re-interpolate the whole image (scale to a temporary size and back) with a choice of kernel: Lanczos-3, Lanczos-2, Catmull-Rom, Mitchell, B-spline, bilinear, nearest, or the browser's own scaler. Also a separate region (drag it on the preview) with its own size, kernel and soft edge. Plus a final output size.

**Live preview** — a reduced-size preview re-renders as you drag (half-size while moving, full preview on release). "Hold: original" (or hold `C`) shows the untouched picture.

**Save** — JPEG at a chosen quality, rendered at full resolution with the same pipeline. Going through the browser's encoder also drops EXIF/GPS metadata. Settings can be saved to and loaded from a small `.json` file.

Every slider says in plain language what moving it left or right does.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell and CSP |
| `style.css` | Dark UI, violet/blue accents, no external fonts |
| `pipeline.js` | All image math on Float32 channels; no DOM access, runs in Node too |
| `app.js` | Controls (generated from a spec), preview scheduling, region overlay, export |

## Notes

- Images above 20 megapixels are reduced on load to keep memory sane.
- Pixel-unit settings (shifts, blur radii, patch sizes) are in full-resolution pixels; the preview scales them so what you see matches what you save.
- Full-size export of a 12 MP photo with everything switched on takes a few seconds; the page shows progress.
