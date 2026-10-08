# Move RAW conversion off the main thread

**Status:** designed, not implemented
**Date:** 2026-07-30
**Unblocks:** [#243](https://github.com/radiantlab/LumiLab/issues/243)

## The problem

Loading a CR2 bracket freezes the tab. `image-set-preview.tsx` renders a
thumbnail for every file in a set, each thumbnail resolves through
`useTiffBytes`, and that calls `rawToTiff`:

```ts
// src/components/ui/(image)/(tiff-image)/use-tiff-bytes.tsx:22
return useMemo(() => rawToTiff(path, tauriRawIo), [path]);
```

`rawToTiff` runs `WasmToolRunner` inline (`raw-preview.ts:161-195`), and
`callMain` is synchronous: it blocks its thread for the whole tool. A
5796x3870 CR2 takes about 1.9 s, so a 10-frame bracket is roughly 20 s of
solid main-thread work. No repaints, no clicks, and eventually the browser's
"page is not responding" prompt.

This is the same defect `run-wasm-pipeline.ts` already documents having fixed
for the pipeline itself:

> `callMain` is synchronous and blocks its thread for a whole tool, so running
> the pipeline on the main thread froze the page for the length of an hdrgen
> merge.

The pipeline moved into a worker. The preview path never did.

## What is tangled, and why it matters here

`raw-preview.ts` does two unrelated jobs in one module:

- **Caching**: dedup by fingerprint, LRU eviction against `BUDGET_BYTES`, byte
  accounting. This has to stay on the main thread, because the cache is what
  every caller shares.
- **Converting**: `WasmToolRunner`, `dcrawArgs`, exit-code and stderr
  handling. This is the half that blocks.

The tangle is visible in the tests. `raw-preview.test.ts` needs a 50-line fake
Emscripten module (`callMain`, `FS`, `HEAPU8`) to assert something as simple
as "a frame is converted once however many callers ask for it". The cache
tests pay for the converter's dependencies because the two share a module.

Splitting along that seam is what makes the conversion movable at all, and it
is what lets the cache tests drop the Emscripten fake.

## Approach

Four modules, split along the existing seam:

```
raw-preview.ts        session cache: dedup, fingerprint, LRU, accounting  [main]
   │  tiffFor(name, bytes)
   ▼
raw-worker-client.ts  one long-lived worker, one promise-chain queue      [main]
   │  postMessage
   ▼
raw-worker.ts         message shell; owns one WasmToolRunner            [worker]
   │
   ▼
raw-convert.ts        dcrawArgs, run, check exit, read TIFF back        [either]
```

`raw-convert.ts` exports `convertRaw(runner, name, bytes)`. It holds the argv
and the exit-code handling, with no worker and no cache, so it is testable
in-process against the fake runner that already exists. The worker becomes a
message shell with almost nothing in it.

### One worker, conversions queued

A single long-lived worker converts frames one at a time.

`WasmToolRunner.clear()` clears only `files` (`wasm-runner.ts:247-249`); the
`factories` and `compiled` maps survive. So a worker holding one runner for the
session compiles `dcraw_emu` **once** and clears MEMFS between frames. Serial
conversion is not a compromise being made for simplicity; it is one warm
module doing ten frames back to back.

Peak wasm heap stays at one instance, about 266 MiB. A 10-frame bracket still
takes ~19 s, but the page stays responsive throughout, which is the entire
point.

### Rejected: a pool of 2-3 workers

Two or three workers would bring a 10-frame bracket to roughly 7-10 s, at a
peak of 530-800 MiB on top of the 768 MB preview cache budget, plus a semaphore
and pool lifecycle to maintain. The gain is throughput; the complaint was
responsiveness. Queued serial conversion fixes the complaint and costs nothing
in memory or lifecycle.

### Rejected: scaling to `navigator.hardwareConcurrency`

Peak memory would become whatever the machine claims (15 concurrent instances
on a 16-core desktop is roughly 4 GB), and behaviour would differ per machine,
which is how a memory bug becomes unreproducible from a bug report.

### Rejected: reusing the pipeline worker

`pipeline.worker.ts` is an entry point for a whole run, not a tool service.
Adding a "convert one frame" op would couple thumbnail rendering to the
pipeline worker's lifecycle for no gain over a dedicated sibling of
`tiff-worker.ts`.

## The test seam

`RawSourceIo.load` becomes `RawSourceIo.tiffFor`:

```ts
/** Converts one RAW file. Defaults to the worker; injected in tests. */
tiffFor?: (name: string, bytes: Uint8Array) => Promise<Uint8Array>;
```

A `ModuleLoader` is a function, and a function cannot cross `postMessage`, so
`load` cannot survive as the injection point once conversion moves. This
mirrors `RunWasmPipelineOptions.execute`, which already solves exactly this
problem for the pipeline.

It is named `tiffFor` rather than `convert` deliberately: under
[#243](https://github.com/radiantlab/LumiLab/issues/243) the worker will often
answer from OPFS without converting anything, and a seam called `convert` would
have to be renamed then.

### Where each existing assertion goes

| Assertion | Destination |
| --- | --- |
| converts once for N callers | `raw-preview.test.ts`, injecting a counting `tiffFor` |
| reconverts when the fingerprint changed | `raw-preview.test.ts`, same |
| still converts when the host cannot fingerprint | `raw-preview.test.ts`, same |
| does not remember a failure | `raw-preview.test.ts`, same |
| accounts for what it holds, releases on clear | `raw-preview.test.ts`, same |
| uses the same argv the pipeline does | `raw-convert.test.ts`, reusing the existing `fakeLoader` against a real `WasmToolRunner` |
| reports a nonzero exit rather than caching an empty result | `raw-convert.test.ts`, same |

No coverage is lost. Two assertions move to the module that now owns the
behaviour, and the five that remain stop needing an Emscripten fake.

## Error handling

A rejected conversion already calls `forget(key)` so the frame can be retried
rather than remembered as a failure (`raw-preview.ts:104-109`). That stays.

Two additions in the client:

- A worker `error` event rejects the conversion in flight, rather than leaving
  its caller suspended forever.
- A worker that has errored is dropped, so the next request builds a fresh one
  instead of queueing behind a corpse. An OOM on one frame then costs that
  frame, not the rest of the session.

## What does not change

- The cache contract: every caller gets the same buffer, not an equal copy.
- `BUDGET_BYTES` and the LRU policy.
- `peekRawTiff` handing already-converted frames to the pipeline worker.
- One `dcrawArgs`, used by both the preview and the merge, so the TIFF the
  preview shows and the TIFF hdrgen merges stay byte-identical.

`wasmBaseUrl` is resolved to an absolute URL before crossing into the worker,
as `run-wasm-pipeline.ts` already does, because a worker's own base URL is the
chunk it was loaded from rather than where the artifacts live.

## Testing

Unit tests as tabulated above, plus a browser regression test.

`pipeline.spec.ts` already has the right instrument: *"the page stays
responsive while the pipeline runs"* installs a 100 ms heartbeat and asserts no
gap over 1 s. Pointing the same instrument at **loading a CR2 bracket** is the
direct test for this defect; today it would record gaps of many seconds.

That needs a CR2 fixture reachable from `e2e-web`. The desktop suite has one,
and `support.ts` already reads the JPEG bracket out of `../e2e-tests/test/inputs`
rather than copying it, so the same route should work. To be confirmed during
implementation: if the CR2 bracket is too large or too slow for the web suite,
the fallback is to assert responsiveness over a single frame rather than ten,
which still fails against a main-thread conversion.

## Relationship to #243

[#243](https://github.com/radiantlab/LumiLab/issues/243) wants the RAW-to-TIFF
cache backed by OPFS so conversions survive a reload. It depends on this work:
`FileSystemFileHandle.createSyncAccessHandle()` is callable only from a
dedicated Web Worker, so the persistent tier needs a worker holding the RAW
bytes, and this creates one.

The layering it will use:

- `raw-preview.ts` keeps the session tier, keyed `path|size:mtime`, costing no
  file read when a frame is already resident.
- `raw-worker.ts` gains the persistent tier: hash the bytes it has already
  received, look up OPFS, and convert only on a miss.

The content hash never has to cross back to the page, so the whole persistent
tier stays behind the worker boundary. Nothing in this design needs to change
to accommodate it; that is why the seam is `tiffFor` rather than `convert`.
