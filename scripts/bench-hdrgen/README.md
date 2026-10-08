# hdrgen benchmark

Measures the same merge in five places, to answer two things the repository
otherwise only asserts: what the WebAssembly build actually costs against
native, and whether a browser runs it as fast as Node does.

```sh
npm run bench:hdrgen          # every leg, 4/8/12/18 frames, 3 repetitions
BENCH_REPS=1 npm run bench:hdrgen
```

Build the arm64 binary first, from the commit `public/wasm/versions.json`
records as the source of the shipped `.wasm`. Building from `main` instead
would compare different source and silently invalidate the native column:

```sh
cmake -S ../hdrgen -B ../hdrgen/build-native-arm64 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build ../hdrgen/build-native-arm64 --target hdrgen -j8
file ../hdrgen/build-native-arm64/hdrgen   # must say arm64
```

That last check is not ceremony. If the architecture flag does not take, the
result is a second Rosetta measurement wearing the wrong label, which is the
exact error the native column exists to correct.

## The legs

| Leg | What it is |
| --- | --- |
| `native-arm64` | hdrgen built here, from the pinned fork commit |
| `native-x86_64` | the installed `/usr/local/bin/hdrgen`, under Rosetta |
| `wasm-node` | the shipped `public/wasm` artifacts, driven in Node |
| `wasm-chromium` | the same artifacts, in a bare page |
| `wasm-webkit` | the same, in WebKit |

The browser legs load the same `hdrgen.js` and call the same `callMain` on the
same bytes as the Node leg, in a page with no app, no worker and no UI, served
by request interception. That is what lets a difference between them be read as
the engine rather than the application. A number taken through the app could
not tell those apart.

WebKit earns its row because the desktop build runs WKWebView, so it is what
separates "browsers are slow at this" from "Chromium is slow at this".

## Reading the output

Times are the merge alone. Module startup is measured separately, because a
cold compile is a real cost a user pays but not the same cost as the merge.

Two asymmetries are deliberate and printed under the table:

- **`native-x86_64` is emulated** on an arm64 machine, so it is a lower bound
  on native performance. The gap to `native-arm64` is what translation costs.
- **The native legs read frames from disk inside the timed region.** The wasm
  legs are handed bytes already in memory, because that is how the application
  feeds them.

A cell showing `-` with a note did not finish inside the 300 s ceiling, or
failed. Those are results, not missing measurements, and the note tells a
timeout apart from an error: a hang and a crash send an investigation in
different directions.

## Frames

Frames are sampled **evenly across the bracket, endpoints included**, not taken
from the front. A bracket is an exposure sequence, so a prefix is a run of
near-identical long exposures: on the first four frames the pipeline's own
filter reported "kept 1 of 4", which would have timed a merge of one frame
while the table said four. The endpoints are kept because the darkest and
brightest frames define the range a merge has to reconcile.

## What this does not measure

The full application, which `e2e-web/tests/perf.bench.ts` already covers, and
the deployed build, which that benchmark can point at with `TARGET_URL`. If the
question is "why is the deployed site slow", start there: this one deliberately
removes everything except the merge.
