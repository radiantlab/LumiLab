# LumiLab: Product Requirements Document

**Status:** describes functionality present on `main` as of the route rename (#258, 2026-08-05). The WebAssembly port (#227) remains the architectural baseline; the substantive change since is the persistent RAW-to-TIFF cache (#249). This is a description of what is implemented, not a roadmap.

## 1. Overview

The LumiLab turns a bracketed set of low dynamic range (LDR) photographs into a calibrated high dynamic range (HDR) luminance map. It runs three image-processing tools ([Radiance](https://www.radiance-online.org/), `hdrgen`, and `dcraw_emu`) behind a guided GUI pipeline, following the calibration process published in [Pierson et al., 2019](https://www.tandfonline.com/doi/full/10.1080/15502724.2019.1684319). All three are compiled to WebAssembly and ship inside the application, so there is nothing to install and no tool paths to configure.

**It is one application with two hosts.** The same static export runs as a Tauri 2 desktop app and as a website. There is no server component in either case: the pipeline is WebAssembly executing in a Web Worker inside the page, so images are never uploaded and never leave the machine. The two hosts differ only in what the platform permits, and every such difference lives behind `src/lib/host/`: file selection, output writing, revealing a file in a file manager, and the app-version lookup.

**Target users:** lighting/daylighting researchers and professionals studying the indoor visual environment, particularly discomfort glare, who need calibrated luminance data without hand-driving Radiance/hdrgen from the command line.

**Supported platforms:** Windows, macOS (Intel + Apple Silicon, universal binary), Ubuntu, and any modern browser including Safari. The HDR Image Viewer is built in and needs no additional software anywhere; the XQuartz requirement that applied to older releases came from Radiance's X11-based `ximage` and no longer applies.

## 2. Application Structure

Four tabs (`src/app/navigation.tsx`), identical in both hosts:

| Tab | Route | Purpose |
|---|---|---|
| Image Generator | `/pipeline` | Configure and run the LDR → HDR calibration pipeline |
| Settings | `/settings` | Output folder, and the versions of everything bundled |
| Runs | `/runs` | History of previous pipeline runs and their outcomes |
| Image Viewer | `/viewer`, `/viewer/view` | Load and inspect a generated `.hdr` file |

`/` redirects to `/pipeline`, so the site root resolves in a browser.

## 3. Feature: Image Generator

`src/app/pipeline/page.tsx`

- **Image set input**: drag-and-drop or file-picker selection of an LDR bracket (JPEG, TIFF, or camera raw). Multiple named image sets can be staged; each set is validated to contain at least 2 images, and every staged set is run. On the desktop a set is a directory; in a browser, `webkitdirectory` reports a relative path, so nested folders still become separate sets and a plain multi-file selection becomes one.
- **RAW conversion and preview**: camera raw frames are converted to TIFF in a dedicated worker (`src/lib/raw-worker.ts`), not on the page, so staging a bracket leaves the UI responsive. Conversions are cached across reloads (§7). Removing a staged frame cancels its conversion if the worker has not started it yet, and lets it finish if it has (#248, #251).
- **Camera response function**: upload of a `.rsp` file describing the camera's tone response, required for JPEG-derived input.
- **Cropping and resizing**
  - Interactive circular lens-mask editor (drag center + radius handles) to isolate the fisheye field of view within the source frame.
  - Numeric target output resolution (width/height in pixels).
- **Correction calibration files**: optional `.cal` (Radiance CAL format) uploads for:
  - Fisheye projection correction
  - Vignetting correction
  - Neutral density filter correction
  - Photometric calibration factor correction
- **Output header editing**: configurable horizontal/vertical fisheye view angle (degrees), written into the output HDR header.
- **Source image filtering**: optional toggle to exclude LDR images that don't contribute usefully to HDR generation, trading a small time cost for improved accuracy.
- **Pipeline execution and status**
  - Stages the input bytes, hands them to the pipeline worker, and shows live progress (`PipelineStatus`, driven by events on an `EventTarget` rather than by a process boundary).
  - Known `hdrgen` failure modes (unsolvable response function, insufficient/non-overlapping exposures) are pattern-matched from stderr and surfaced as an actionable per-image-set error instead of a raw stack trace.
  - Any other pipeline failure is captured as a JSON trace (inputs + error) so it can be sent to a maintainer.

## 4. Feature: Calibration Pipeline

`src/lib/pipeline/*`, driven from `src/app/pipeline/run-wasm-pipeline.ts`

The pipeline is TypeScript orchestrating WebAssembly. It runs **in a Web Worker**, not on the page: Emscripten's `callMain` is synchronous and blocks its thread for the whole of a tool, so an inline pipeline froze the tab for the length of an hdrgen merge. The worker reads no files itself; the page stages the bytes and transfers them in, because only the page knows how to reach a file (Tauri's filesystem on the desktop, the virtual filesystem in a browser), and keeping that out of the worker is what lets one worker serve both hosts.

Each tool is a separate Emscripten module built with `-sEXIT_RUNTIME=1`, which means one `main()` per instance and therefore a fresh instance per stage. Each `.wasm` is compiled once per session and the compiled module reused across instantiations; recompiling per stage cost roughly 7.6x on instantiation alone, plus a network round trip per stage when served over HTTP.

Per image set, in this order (`orchestrator.ts`):

1. **Merge exposures**: combines the LDR bracket into a single HDR image via `hdrgen`, using the supplied camera response function. Raw camera formats are converted through `dcraw_emu` first, in the RAW worker and behind the cache described in §7, and the resulting TIFF is shared with the UI's preview rather than converted twice (#242).
2. **Nullify exposure value**: always runs.
3. **Crop**: applies the lens mask (diameter/x/y from the UI). Always runs.
4. **Resize**: *only if* the lens mask diameter exceeds 1000px.
5. **Projection adjustment**: fisheye projection correction, *only if* a fisheye correction `.cal` file was supplied.
6. **Vignetting correction**: *only if* a vignetting `.cal` file was supplied.
7. **Neutral density correction**: *only if* a neutral density `.cal` file was supplied.
8. **Photometric adjustment**: applies the calibration factor, *only if* supplied.
9. **Header editing (view angles)**: writes the `VIEW= -vta -vv -vh` line into the Radiance header *before* evalglare runs, since evalglare reads its view geometry from the header rather than purely from its own CLI flags. Always runs. (See §8.)
10. **Evalglare**: always runs; computes a glare value against a header with the correct view angles already written.
11. **Header editing (glare value)**: a second pass, adding the evalglare-derived `COMPUTED_VERTICAL_ILLUMINANCE` value (the quantity `evalglare -V` reports, named to pair with the user-supplied `MEASURED_VERTICAL_ILLUMINANCE`). This is the pipeline's primary output.
12. **Falsecolor**: the false-color luminance map, reimplemented in TypeScript because upstream `falsecolor` is a Perl script rather than a C tool. Always runs; the `_fc.hdr` secondary output.

Steps 4–8 are conditionally skipped when their corresponding calibration input is absent; the rest are unconditional. Failures propagate as structured `PipelineError` values rather than raw exit codes, and a status event is emitted per step.

Every staged image set runs, in sequence (`run-batch.ts`).

The two former Rust commands have TypeScript equivalents: raw conversion rides on the `dcraw_emu` WebAssembly build behind a two-tier cache that survives a reload (§7), and `src/lib/hdr-metadata.ts` parses a Radiance header into the key/value map the viewer displays.

**Numerical parity.** The WebAssembly build was validated against native binaries on the reference brackets: the RAW/TIFF path matches to 1e-8, and the JPEG path differs by an unbiased ~1.7%, traced to the float IDCT and settled deliberately in #235. Wall clock is roughly native, measured rather than estimated: merging the 18-frame reference bracket takes 13.4 s in WebKit and 14.5 s in Chromium against 13.6 s for a native arm64 build of the same commit ([`scripts/bench-hdrgen`](./scripts/bench-hdrgen/README.md)). This paragraph previously claimed ~2x native, which was never measured and is pessimistic for the browser, the case the web build actually runs. Two caveats hold the number honest: the native leg reads its frames from disk inside the timed region and the WebAssembly legs do not, and a merge is not pure compute, so a workload of tight numerical loops would likely separate them more. The build is single-threaded on purpose, which is what lets it host anywhere without COOP/COEP headers.

## 5. Feature: Image Viewer

`src/app/viewer/*`

- **File intake**: drag-and-drop or file picker for a single `.hdr` file (extension-validated); state is passed to the viewer route via a serialized URL query string (`viewer-url.ts`).
- **Rendering**: a `three.js` (WebGL) canvas renders the HDR pixel data as a texture, with pan/zoom (`react-zoom-pan-pinch`).
- **Exposure control**: interactive exposure slider to remap the HDR dynamic range for on-screen viewing.
- **False-color heatmap overlay**: false-color luminance computation (`falsecolor-luminance-webgpu.ts`) that runs on WebGPU when available (via `navigator.gpu`) and falls back to a CPU implementation otherwise; rendered as a heatmap texture (`heatmap-texture.ts`) with a configurable scale, toggleable over the base image.
- **Luminance inspection tools**
  - Hover readout of luminance at the cursor position (`hover-luminance-details.tsx`).
  - Rectangular/region selection tool (`use-image-selection-layer.ts`, `image-selection-context.tsx`) reporting min/max/average luminance and distribution for the selected region (`luminance-aggregates.ts`, `selection-details.tsx`).
  - Illuminance summary panel (`illuminance-details.tsx`).
- **Metadata panel**: displays parsed `.hdr` header fields (`src/lib/hdr-metadata.ts`).
- **View controls**: `view-control-card.tsx` consolidates exposure, overlay, and display toggles.

The viewer works on every platform with no additional software. It requires WebGL, which every supported target has; WebGPU is used only as an optional accelerator for the false-color computation.

## 6. Feature: Settings

`src/app/settings/page.tsx`

- Output folder, on the desktop. It is hidden in a browser, because a browser downloads and the browser chooses where; an output path there would be a control that does nothing (`canWriteToChosenDirectory()`).
- There are no tool paths to configure: every tool ships with the app.
- Reports the app and Tauri versions, and the Radiance, `hdrgen` and LibRaw versions read from `public/wasm/versions.json`. The Tauri version is absent in a browser, which is reported as absent rather than guessed.
- Carries the link to the Corresponding Source, which GPL-3 §6(d) requires be offered from the application itself once `.wasm` is served over the network.
- Reports the persistent RAW conversion cache's size against its effective budget, with a control to empty it. The card is hidden on a host with no IndexedDB, where there is no persistent tier to report; showing zero there would claim an empty cache rather than no cache.
- Settings persist via a Zustand store (`stores/settings-store.ts`) backed by `localStorage`, hydrated on load. The persisted key is deliberately not renamed with the app, a `localStorage` key being an address rather than a label.

## 7. Cross-cutting / Infrastructure

- **Host abstraction**: `src/lib/host/` is the only place either build knows which host it is running in: `env.ts` (capabilities, reported separately from the host itself), `pick.ts` (file selection), `save.ts` (writing versus downloading), `events.ts`, `reveal.ts`. There is one build; Tauri is detected at runtime rather than compiled in.
- **Storage**: `src/lib/app-storage.ts` over IndexedDB (`storage/kv.ts`), holding both records and file content. Preset calibration files are stored as content rather than as paths, after files kept on a cloud drive copied as zero bytes while the preset still recorded the expected hash. Desktop installs migrate their old on-disk files once (`storage/migrate-tauri-files.ts`).
- **RAW conversion cache**: two tiers behind one seam: a session tier in `raw-preview.ts` and a persistent tier in `raw-cache.ts`, both in front of conversion. It is content-addressed, so a file that moved is still a hit and a file that changed is not. That is a correctness requirement rather than a nicety in the browser, where session paths are minted from a counter that restarts each visit and would otherwise name different bytes identically. The key also folds in a tool tag from the `dcraw_emu` build and its flags, so rebuilding the tool invalidates the cache. The budget is 2 GB nominal, clamped to a share of the origin's reported quota where that is known, with eviction above it. Backed by IndexedDB (`raw-cache-idb.ts`), **not** OPFS: #243 specified OPFS for its `createSyncAccessHandle` fast path, but the probe in `e2e-web/tests/storage-probe.spec.ts` found `navigator.storage.getDirectory` absent in WebKit and in the WebKitGTK build Tauri uses on Linux, so an OPFS cache would have silently never worked for Safari or Linux desktop users. IndexedDB round-tripped a 67 MB blob on every engine tested.
- **Virtual filesystem**: `src/lib/vfs.ts` gives browser-side files synthetic paths, so the pipeline's path-based contract holds unchanged. Two lifetimes: `/session/...` dies with the tab, `/presets/...` is IndexedDB-backed and survives.
- **Pipeline status & error UX**: a shared `PipelineStatusProvider` coordinates progress and error state across pages.
- **Toast notifications** (`sonner`) for success/error/action feedback app-wide.
- **Static export**: the Next.js frontend builds via `output: "export"`. No Node server at runtime: Tauri serves the bundle on the desktop, and any static host serves it on the web.

## 8. Recent Fixes

- **2026-07-24: Pipeline evalglare/header-editing order (major regression).** The pipeline was running `evalglare` *before* `header_editing` wrote the view angles into the HDR header. `evalglare` reads its view geometry from the header, so every pipeline run was computing glare against a header without the correct view angles yet applied, producing incorrect glare values. Fixed by splitting `header_editing` into two calls: one before `evalglare` (writes just the view angles) and one after (records the evalglare-derived value), matching the corrected order documented in §4. The fix landed in `src-tauri/src/pipeline.rs` and `src-tauri/src/pipeline/header_editing.rs`, both since removed by the WebAssembly port (#227); the ordering it established is now carried by `src/lib/pipeline/orchestrator.ts`.

## 9. Known Limitations (as of this document)

Applying to both hosts:

- **Roughly 2x native wall clock.** The WebAssembly build is single-threaded on purpose, which is what lets it host anywhere without COOP/COEP headers. Threads or SIMD would recover some of it, at the cost of that property.
- **Input resolution has a ceiling.** A 10-frame CR2 bracket peaks around 2.12 GB against the wasm32 4 GB limit, and the floor scales with frame *area*, so the ceiling arrives near 55-60 MP. Re-measure if input resolution roughly doubles.
- **The JPEG path differs from native by ~1.7%**, unbiased, traced to the float IDCT (#235). The RAW path matches to 1e-8.
- **A cached RAW frame still waits its turn in the conversion queue.** The cache lookup lives inside the worker, so it is only reached after the frame has queued behind every frame ahead of it: a hit costs milliseconds of work but can sit behind several seconds of conversions. Resolving hits before they queue reworks the page/worker boundary #243 established, and is tracked separately.

Applying to the browser only, and all of them consequences of what a browser permits rather than of unfinished work:

- **Outputs are downloaded** and the browser decides where. `showSaveFilePicker` needs a user gesture *per file*, and a batch produces two files per image set, so it is unusable for this.
- **Files chosen in a previous session cannot be reopened.** A browser gives no durable handle to a picked file. Presets are unaffected: they store their calibration files as content.
- **Memory beyond desktop Chromium is unmeasured.** A 10-frame CR2 bracket peaks near 700 MB of JS heap; comfortable there, unmeasured on mobile.

Testing:

- The desktop suite (`e2e-tests/`, WebdriverIO) and the web suite (`e2e-web/`, Playwright) are separate because Playwright cannot attach to a Tauri window: neither WKWebView nor WebKitGTK exposes a CDP endpoint. Both now run the full generation case, which previously could not run in CI at all without externally installed binaries.
- ~~Vendored, bundled Radiance/`hdrgen` binaries~~: superseded by the WebAssembly port (#227).
