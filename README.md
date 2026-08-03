# Pixel Beads Designer (拼豆图纸工坊)

Turn any image into a **perler / fuse-bead (拼豆) pattern chart** — entirely in the browser. Upload a photo, pick a board size, and get a griddled chart with the matched bead **color codes**, a **per-color bead count**, and exports — no server, no upload of your images anywhere.

> **Live demo:** [pindou.fanni-panda.com](https://pindou.fanni-panda.com/) · **Stack:** React 18 · TypeScript · Vite 7 · Web Worker · PWA · 100% client-side

<!-- TODO(before publishing): add a hero screenshot/GIF here, generated from an
     original or royalty-free image (docs/samples/ is gitignored on purpose so
     no third-party reference art ships in the repo). -->

---

## Why this is interesting (engineering)

The hard part of a bead-pattern tool isn't the UI — it's **mapping millions of arbitrary pixels onto a small fixed palette in a way that looks right to the human eye, fast, in a browser tab.**

- **Hand-implemented CIEDE2000 perceptual color difference** (`src/domain/color.ts`). Naïve RGB/Lab Euclidean distance (ΔE\*76) is visibly wrong in blues and saturated colors, so the final pixel→bead mapping uses the full CIEDE2000 formula (kL=kC=kH=1), following the Sharma, Wu & Dalal (2005) reference. It is **unit-tested against the canonical reference vectors** (`src/test/domain.test.ts`), not just eyeballed.
- **Full-palette CIEDE2000 per cell.** Every cell is matched against the whole MARD chart with CIEDE2000 (no lossy pre-filtering — a ΔE\*76 pre-select would visibly flip some blues/purples, see the D15-vs-C9 regression test). The squared ΔE\*76 distance is used only to rank colors when building the active palette.
- **Off-main-thread conversion.** The pixelize → match → count pipeline runs in a **Web Worker** (`src/worker/conversion.worker.ts`) so the UI never blocks on large images.
- **Smart in-browser background removal.** Uniform borders use a fast edge-connected color key that preserves fine details; complex scenes fall back to `@imgly/background-removal` (WASM).
- **Pixel-art grid recovery.** Repeated edge periods are detected before resampling, so an enlarged 23×31 sprite returns to its real logical grid instead of being stretched into a blurry, duplicate-filled 52×52 chart. Photos and illustrations keep area-filtered scaling.
- **Saliency-aware palette limiting.** High-contrast rare colors such as eyes and highlights reserve a small part of the color budget instead of losing every tie to large background/body regions.
- **Real palette.** Color codes come from the MARD bead color chart (source attributed in `src/domain/palette.ts`); the matcher works against actual purchasable bead colors, and the stats table tells you exactly how many of each to buy.

Everything runs **client-side** — images never leave the device, and the built output is a static bundle you can host anywhere.

---

## Features

- Upload one or many images; crop / scale with automatic saliency focus or manual focal-point control, with per-task conversion progress and cancel.
- Smart logical size (up to 52 pins), fixed 29/50/52/104-pin boards (plus 52×104 and 156 tiling), or custom width × height — prints/PDF paginate per physical board.
- Automatic subject framing, pixel-art/photo sampling selection, high-contrast outline recommendations, and perceptual color matching to the bead palette.
- Post-generation pattern workbench: recolor/erase individual cells, pick colors, undo/redo up to 30 steps (Ctrl+Z / Ctrl+Shift+Z), reset, mirror horizontally — plus full keyboard grid navigation (arrows + Enter/Space/Delete).
- Mobile build assistant: focus one color, tap cells complete, see remaining bead counts, and resume progress from local storage.
- Save up to six private local pattern drafts and continue editing/exporting after a refresh, with no account or upload.
- Per-image and whole-**project** color/count aggregation, filterable by project or local draft, with inventory shortfall and purchase-list CSV export.
- Adjustments: brightness/contrast, color simplification, dithering (Floyd-Steinberg or Bayer ordered), and non-destructive outer H7 black outlining.
- Palette panel, stats table, grid/color-code preview with zoom.
- Exports of the chart and counts.
- Installable **PWA** (works offline once loaded).

## Tech

| Area | Choice |
|---|---|
| UI | React 18 + TypeScript |
| Build / dev | Vite 7, `vite-plugin-pwa` |
| Heavy compute | Web Worker (`conversion.worker.ts`) |
| Background removal | `@imgly/background-removal` (WASM, in-browser) |
| Color science | hand-written sRGB→Lab + CIEDE2000 (`src/domain/color.ts`) |
| Tests | Vitest 4 + Testing Library (`src/test/`) |

## Run it

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static bundle → dist/
npm run preview   # serve the built bundle
npm test          # vitest (color-science + app tests)
```

Requires Node.js `^20.19.0` or `>=22.12.0` for the current Vite toolchain.

## Deploy

The build is a **static bundle** — host `dist/` on any static server or CDN. Example nginx configs (genericized) are in `deploy/`:

- `deploy/nginx-image2pindou.conf` — a static site server block with SPA fallback to `index.html`, behind Cloudflare.
- `deploy/nginx-example-tls.conf` — a reusable TLS snippet for a wildcard Cloudflare Origin certificate.

Replace `example.com` / `<your-server-ip>` with your own domain and origin before use.

For atomic VPS releases, run `deploy/promote-release.sh <uploaded-release-dir> [site-dir]` on the server. The script retains prior hashed assets before switching directories, so users with an older PWA tab do not hit missing dynamic chunks during an update.

## Project layout

```
src/
  domain/        pure logic: color (CIEDE2000), conversion, focus, recommendations,
                 project stats, palette, boards, dithering, background removal, exporters
  worker/        conversion.worker.ts — runs the pipeline off the main thread
  components/    Upload / Crop / Settings / Palette / Preview / Stats panels
  test/          vitest: domain.test.ts (color math), app.test.tsx
deploy/          example nginx configs (static + TLS)
design.md        original design doc (Chinese)
docs/DEVLOG.md   dev log: iteration history, deploy records, env & commands (Chinese)
docs/ITERATIONS.md  next-iteration specs with acceptance criteria (Chinese)
```

## License

Personal project. Bead color-chart data is reference material attributed to its source in `src/domain/palette.ts`; demo/sample images are not redistributed in this repo.
