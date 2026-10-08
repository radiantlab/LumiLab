# RAW Conversion Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `dcraw_emu` off the main thread so loading a CR2 bracket no longer freezes the tab.

**Architecture:** Split `raw-preview.ts` along the seam it already has: caching stays on the main thread, converting moves out. A pure `convertRaw` module holds the argv and exit-code handling; a single long-lived worker holds one `WasmToolRunner` and takes frames in turn; the cache's injected seam changes from a `ModuleLoader` (a function, which cannot cross `postMessage`) to a `tiffFor` callback.

**Tech Stack:** TypeScript, Next.js static export, Web Workers (module workers via `new URL(..., import.meta.url)`), Emscripten `dcraw_emu`, Jest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-30-raw-conversion-worker-design.md`

## Global Constraints

- `src/lib/pipeline/` and `src/lib/raw-*.ts` must import no `@tauri-apps/*`. Host access is injected. Violating this breaks the browser build.
- One `dcrawArgs`, used by the preview and the merge alike. The TIFF the preview shows and the TIFF hdrgen merges must stay byte-identical. Never introduce a second flag set.
- **Never transfer a buffer you did not allocate.** `io.readFile` may hand back the session filesystem's own array (`vfs.ts:85`); transferring it detaches that array and empties the store. This is the defect fixed in `93ba5fc`; do not reintroduce it.
- Comments explain *why*, not *what*. This codebase's comments carry reasoning and measurements. Match that density.
- Prose uses no em-dashes. Use `--` in comments and docs, as the surrounding code does.
- Lint with `npx ultracite check <paths>`; autofix with `npx ultracite fix <paths>`. Keys in object literals must be alphabetically sorted (`assist/source/useSortedKeys`).
- Run the unit suite with `npx jest`. All 313 existing tests must stay green after every task.

---

### Task 1: Extract the conversion into `raw-convert.ts`

Pure move. No behaviour change, still on the main thread. This is the split that makes everything after it possible.

**Files:**
- Create: `src/lib/raw-convert.ts`
- Create: `src/lib/raw-convert.test.ts`
- Modify: `src/lib/raw-preview.ts` (delete `baseName` and the body of `convert`; call the new module)
- Modify: `src/lib/raw-preview.test.ts` (delete the two tests that move)

**Interfaces:**
- Consumes: `ToolRunner` from `src/lib/pipeline/types.ts` (`writeFile`, `readFile`, `run`); `dcrawArgs` and `workPath` from `src/lib/pipeline/stages.ts`.
- Produces: `convertRaw(runner: ToolRunner, path: string, bytes: Uint8Array): Promise<Uint8Array>` and `baseName(path: string): string`, both from `src/lib/raw-convert.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/raw-convert.test.ts`. The `fakeLoader` here is lifted verbatim from `raw-preview.test.ts:21-72`.

**The duplication is deliberate and lasts exactly one task.** `raw-preview.test.ts` still needs its copy for the five cache tests that remain after this task; Task 2 rewrites that file and deletes its copy, leaving this as the only one. Extracting a shared fixture module instead would leave a single-consumer helper behind after Task 2, so the copy is the cheaper path through. Do not extract it, and do not delete the original here; the suite must stay green at the end of every task.

```ts
/**
 * Converting one frame, with no cache in the way.
 *
 * These two assertions used to live in `raw-preview.test.ts`, where the cache
 * tests paid for the converter's Emscripten fake. They belong to the module
 * that runs the tool, which is now this one.
 */

import { describe, expect, it } from "@jest/globals";
import type { EmscriptenModule, ModuleFactory } from "./pipeline/wasm-runner";
import { WasmToolRunner } from "./pipeline/wasm-runner";
import { convertRaw } from "./raw-convert";

/** Records the argv every `callMain` was given. */
function fakeLoader(outputBytes = 1024) {
  const runs: string[][] = [];
  const load = (_tool: string): Promise<ModuleFactory> => {
    const factory: ModuleFactory = () => {
      const memfs = new Map<string, Uint8Array>();
      const dirs = new Set<string>(["/"]);
      const instance: EmscriptenModule = {
        callMain: (args: string[]) => {
          runs.push(args);
          const target = args[args.indexOf("-Z") + 1];
          if (target) {
            memfs.set(target, new Uint8Array(outputBytes));
          }
          return 0;
        },
        FS: {
          chdir: () => undefined,
          close: () => undefined,
          mkdir: (dir: string) => {
            if (dirs.has(dir)) {
              throw new Error("EEXIST");
            }
            dirs.add(dir);
          },
          open: () => ({}),
          readdir: (dir: string) =>
            Array.from(memfs.keys())
              .filter((p) => p.startsWith(`${dir}/`))
              .map((p) => p.slice(dir.length + 1)),
          readFile: (p: string) => {
            const file = memfs.get(p);
            if (!file) {
              throw new Error(`ENOENT ${p}`);
            }
            return file;
          },
          streams: [0, 1, 2],
          unlink: (p: string) => {
            memfs.delete(p);
          },
          writeFile: (p: string, data: Uint8Array) => {
            memfs.set(p, data);
          },
        },
        HEAPU8: new Uint8Array(1024),
      };
      return Promise.resolve(instance);
    };
    return Promise.resolve(factory);
  };
  return { load, runs };
}

describe("converting one RAW frame", () => {
  it("uses the same argv the pipeline does", async () => {
    const { load, runs } = fakeLoader();
    const runner = new WasmToolRunner({ load });

    await convertRaw(runner, "/in/capt01.CR2", new Uint8Array(64));

    // The frame is staged under its own basename, because dcraw_emu reports
    // errors against the name it was given and a path outside /work would
    // need its parent directories created.
    expect(runs[0]).toEqual([
      "-T",
      "-o",
      "1",
      "-W",
      "-j",
      "-q",
      "3",
      "-g",
      "2",
      "0",
      "-t",
      "0",
      "-b",
      "1.1",
      "-Z",
      "/work/preview.tiff",
      "/work/capt01.CR2",
    ]);
  });

  it("reports a nonzero exit rather than returning an empty result", async () => {
    const load = (_tool: string): Promise<ModuleFactory> => {
      const factory: ModuleFactory = (options?: Record<string, unknown>) => {
        (options?.printErr as ((line: string) => void) | undefined)?.(
          "Cannot open /work/a.CR2: Unsupported file format or not RAW file"
        );
        return Promise.resolve({
          callMain: () => 2,
          FS: {
            chdir: () => undefined,
            close: () => undefined,
            mkdir: () => undefined,
            open: () => ({}),
            readdir: () => [],
            readFile: () => {
              throw new Error("ENOENT");
            },
            streams: [0, 1, 2],
            unlink: () => undefined,
            writeFile: () => undefined,
          },
          HEAPU8: new Uint8Array(8),
        } as EmscriptenModule);
      };
      return Promise.resolve(factory);
    };

    const failure = await convertRaw(
      new WasmToolRunner({ load }),
      "/in/a.CR2",
      new Uint8Array(4)
    ).catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    // Both halves matter: the exit code says it failed, the stderr says why.
    expect((failure as Error).message).toContain("exit 2");
    expect((failure as Error).message).toContain("Unsupported file format");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/raw-convert.test.ts`
Expected: FAIL, `Cannot find module './raw-convert'`.

- [ ] **Step 3: Create `src/lib/raw-convert.ts`**

The body is lifted from `raw-preview.ts:161-195`, minus the runner construction (the caller owns that now) and minus `runner.clear()` (the caller owns the runner's lifetime).

```ts
/**
 * Converting one RAW frame to TIFF.
 *
 * Split out of `raw-preview.ts` so the conversion can run where the cache
 * cannot follow. The cache is shared state and belongs to the page; the
 * conversion is a synchronous `callMain` that must not run there at all.
 *
 * Deliberately owns neither a runner nor a worker. It is handed a `ToolRunner`
 * and returns bytes, which is what lets the argv and the exit-code handling be
 * tested in-process while the thing that actually runs them sits in a worker.
 *
 * `dcrawArgs` is imported rather than restated. If the two flag sets ever
 * diverge, the preview silently stops showing what the pipeline measures.
 */

import { dcrawArgs, workPath } from "./pipeline/stages";
import type { ToolRunner } from "./pipeline/types";

/** Either separator, so a Windows path keeps working unchanged. */
const PATH_SEPARATOR = /[\\/]/;

export function baseName(path: string): string {
  const parts = path.split(PATH_SEPARATOR);
  return parts.at(-1) || "input.raw";
}

/**
 * Runs `dcraw_emu` over one frame and returns the TIFF.
 *
 * The returned array is the runner's own. Callers that clear or reuse the
 * runner afterwards own it from that point and may transfer it; callers that
 * do not must treat it as borrowed.
 */
export async function convertRaw(
  runner: ToolRunner,
  path: string,
  bytes: Uint8Array
): Promise<Uint8Array> {
  // The name is kept because a path outside /work would need its parent
  // directories created, and dcraw_emu reports errors against it.
  const input = workPath(baseName(path));
  const output = workPath("preview.tiff");

  await runner.writeFile(input, bytes);
  const result = await runner.run("dcraw_emu", dcrawArgs(input, output));
  if (result.code !== 0) {
    throw new Error(
      `dcraw_emu could not convert ${path} (exit ${result.code})` +
        (result.stderr ? `: ${result.stderr.trim()}` : "")
    );
  }
  return await runner.readFile(output);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/raw-convert.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Rewire `raw-preview.ts` to use it**

In `src/lib/raw-preview.ts`, replace the whole `convert` function (currently lines 161-195) with:

```ts
async function convert(
  path: string,
  io: RawSourceIo
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await io.readFile(path);
  const runner = new WasmToolRunner({
    compile: io.load ? undefined : urlModuleCompiler(WASM_BASE_URL),
    load: io.load ?? urlModuleLoader(WASM_BASE_URL),
  });

  const tiff = await convertRaw(runner, path, bytes);
  // Frees the source and the runner's own reference. What the cache hands out
  // afterwards is this same buffer, never a copy.
  runner.clear();
  // MEMFS hands back a plain ArrayBuffer-backed view, never a SharedArrayBuffer
  // -- these builds are single-threaded, which is what keeps them hostable
  // without COOP/COEP headers, and a page served without those headers does
  // not even define SharedArrayBuffer. Narrowed here so callers can pass
  // `.buffer` straight to the tiff worker instead of copying it.
  return tiff as Uint8Array<ArrayBuffer>;
}
```

Then delete the now-unused `baseName` function and the `PATH_SEPARATOR` constant from the bottom of `raw-preview.ts`, and add the import:

```ts
import { convertRaw } from "./raw-convert";
```

Remove `dcrawArgs` and `workPath` from the `./pipeline/stages` import if nothing else in the file uses them (nothing does).

- [ ] **Step 6: Delete the two tests that moved**

In `src/lib/raw-preview.test.ts`, delete the `it("uses the same argv the pipeline does", ...)` block and the `it("reports a nonzero exit rather than caching an empty result", ...)` block.

The second one also asserted `expect(rawCacheBytes()).toBe(0)`, which is cache behaviour rather than converter behaviour. Preserve it by adding this test in their place:

```ts
  it("does not account for a conversion that failed", async () => {
    const source: RawSourceIo = {
      load: () => Promise.reject(new Error("module missing")),
      readFile: () => Promise.resolve(new Uint8Array(4)),
    };

    await expect(rawToTiff("/in/a.CR2", source)).rejects.toThrow(
      "module missing"
    );
    // A failure that still counted against the budget would evict live frames
    // to make room for something that was never stored.
    expect(rawCacheBytes()).toBe(0);
  });
```

- [ ] **Step 7: Run the full unit suite**

Run: `npx jest`
Expected: PASS. Test count rises by 1 (two tests moved out of `raw-preview.test.ts`, two arrive in `raw-convert.test.ts`, one new cache-accounting test).

- [ ] **Step 8: Lint**

Run: `npx ultracite check src/lib/raw-convert.ts src/lib/raw-convert.test.ts src/lib/raw-preview.ts src/lib/raw-preview.test.ts`
If it reports fixable issues: `npx ultracite fix <same paths>`, then re-run check.
Expected: no errors. Warnings in files you did not touch are pre-existing; leave them.

- [ ] **Step 9: Commit**

```bash
git add src/lib/raw-convert.ts src/lib/raw-convert.test.ts src/lib/raw-preview.ts src/lib/raw-preview.test.ts
git commit -m "refactor(raw): split converting out of the cache

raw-preview.ts both cached and converted, which is why its cache tests
needed a fake Emscripten module to assert that a frame is converted once.
The conversion now lives in raw-convert.ts, holding the argv and the
exit-code handling and owning neither a runner nor a cache.

No behaviour change: the conversion still runs on the main thread. This is
the split that lets it move off.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Swap the `load` seam for `tiffFor`

A `ModuleLoader` is a function, and a function cannot cross `postMessage`, so it cannot survive as the injection point once conversion moves to a worker. Note that `tauriRawIo` (`src/lib/host/raw-io.ts:13-23`) never sets `load`; it is test-only in production, so this change touches no shipping caller.

**Files:**
- Modify: `src/lib/raw-preview.ts` (`RawSourceIo`, `convert`)
- Modify: `src/lib/raw-preview.test.ts` (delete the Emscripten fake, inject a counting `tiffFor`)

**Interfaces:**
- Consumes: `convertRaw` from Task 1.
- Produces: `RawSourceIo.tiffFor?: (path: string, bytes: Uint8Array) => Promise<Uint8Array>` on the interface exported from `src/lib/raw-preview.ts`. `RawSourceIo.load` no longer exists.

- [ ] **Step 1: Write the failing test**

Replace the whole of `src/lib/raw-preview.test.ts` with this. The 50-line Emscripten fake is gone; a counting `tiffFor` says the same things in four lines.

```ts
/**
 * The shared RAW conversion cache.
 *
 * What matters here is not that `dcraw_emu` works -- `raw-convert.test.ts`
 * covers the tool, and the reference bracket covers it in a real browser --
 * but that the *sharing* holds: that a frame is converted once no matter how
 * many callers want it, that a file replaced on disk is not served from a
 * stale entry, and that a long session does not grow without bound.
 */

import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  clearRawPreviewCache,
  type RawSourceIo,
  rawCacheBytes,
  rawToTiff,
} from "./raw-preview";

/** Counts conversions, which is the whole point of the cache. */
function countingIo(
  outputBytes = 1024,
  fingerprint?: RawSourceIo["fingerprint"]
): RawSourceIo & { converted: string[] } {
  const converted: string[] = [];
  return {
    converted,
    fingerprint,
    readFile: () => Promise.resolve(new Uint8Array(64)),
    tiffFor: (path: string) => {
      converted.push(path);
      return Promise.resolve(new Uint8Array(outputBytes));
    },
  };
}

describe("shared RAW conversion", () => {
  beforeEach(() => {
    clearRawPreviewCache();
  });

  it("converts a frame once however many callers ask for it", async () => {
    const source = countingIo();

    const [a, b, c] = await Promise.all([
      rawToTiff("/in/capt01.CR2", source),
      rawToTiff("/in/capt01.CR2", source),
      rawToTiff("/in/capt01.CR2", source),
    ]);

    expect(source.converted).toHaveLength(1);
    // The same buffer, not an equal copy: that is what makes staging a cached
    // frame into the pipeline cost no extra memory.
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("reconverts when the file behind the path has changed", async () => {
    let stamp = "100:1";
    const source = countingIo(1024, () => Promise.resolve(stamp));

    await rawToTiff("/in/capt01.CR2", source);
    await rawToTiff("/in/capt01.CR2", source);
    expect(source.converted).toHaveLength(1);

    stamp = "200:2";
    await rawToTiff("/in/capt01.CR2", source);
    expect(source.converted).toHaveLength(2);
  });

  it("still converts when the host cannot fingerprint", async () => {
    const source = countingIo(1024, () => Promise.reject(new Error("no stat")));

    await rawToTiff("/in/capt01.CR2", source);
    await rawToTiff("/in/capt01.CR2", source);

    // Falls back to keying on the path, which is what it would have done with
    // no fingerprint at all -- a failed stat must not disable the cache.
    expect(source.converted).toHaveLength(1);
  });

  it("does not remember a failure", async () => {
    // Typed so the mutation below is visible to the analyser, which would
    // otherwise narrow `fail` to the literal `true` it was initialised with.
    const state: { fail: boolean } = { fail: true };
    const source: RawSourceIo = {
      readFile: () => Promise.resolve(new Uint8Array(64)),
      tiffFor: () =>
        state.fail
          ? Promise.reject(new Error("conversion failed"))
          : Promise.resolve(new Uint8Array(1024)),
    };

    await expect(rawToTiff("/in/a.CR2", source)).rejects.toThrow(
      "conversion failed"
    );
    state.fail = false;
    await expect(rawToTiff("/in/a.CR2", source)).resolves.toBeInstanceOf(
      Uint8Array
    );
  });

  it("does not account for a conversion that failed", async () => {
    const source: RawSourceIo = {
      readFile: () => Promise.resolve(new Uint8Array(4)),
      tiffFor: () => Promise.reject(new Error("conversion failed")),
    };

    await expect(rawToTiff("/in/a.CR2", source)).rejects.toThrow(
      "conversion failed"
    );
    // A failure that still counted against the budget would evict live frames
    // to make room for something that was never stored.
    expect(rawCacheBytes()).toBe(0);
  });

  it("accounts for what it holds and releases it on clear", async () => {
    const source = countingIo(4096);

    await rawToTiff("/in/a.CR2", source);
    await rawToTiff("/in/b.CR2", source);
    expect(rawCacheBytes()).toBe(8192);

    clearRawPreviewCache();
    expect(rawCacheBytes()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/raw-preview.test.ts`
Expected: FAIL. `tiffFor` is not a property of `RawSourceIo`, so TypeScript rejects the object literals and the conversions run through `load` instead, leaving `source.converted` empty.

- [ ] **Step 3: Change the seam in `raw-preview.ts`**

In the `RawSourceIo` interface, delete the `load` property and its doc comment. That leaves `import type { ModuleLoader } from "./pipeline/wasm-runner";` (line 28) with no users, so delete that import too or lint will fail on it. Then add:

```ts
  /**
   * Converts one frame, given its path and its bytes.
   *
   * This is the seam, rather than the `ModuleLoader` it replaced, because the
   * conversion runs in a worker and a function cannot cross `postMessage`.
   * Defaults to the worker; tests inject their own.
   *
   * Named for what it returns rather than what it does: under #243 it will
   * often answer from OPFS without converting anything.
   */
  tiffFor?: (path: string, bytes: Uint8Array) => Promise<Uint8Array>;
```

Then replace `convert` with:

```ts
async function convert(
  path: string,
  io: RawSourceIo
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await io.readFile(path);
  const tiff = await (io.tiffFor ?? inlineTiffFor)(path, bytes);
  // MEMFS hands back a plain ArrayBuffer-backed view, never a SharedArrayBuffer
  // -- these builds are single-threaded, which is what keeps them hostable
  // without COOP/COEP headers, and a page served without those headers does
  // not even define SharedArrayBuffer. Narrowed here so callers can pass
  // `.buffer` straight to the tiff worker instead of copying it.
  return tiff as Uint8Array<ArrayBuffer>;
}

/**
 * The default converter: a runner in this thread.
 *
 * Replaced by the worker in the next task. It exists as its own function so
 * that swap is a one-line change rather than a rewrite of `convert`.
 */
async function inlineTiffFor(
  path: string,
  bytes: Uint8Array
): Promise<Uint8Array> {
  const runner = new WasmToolRunner({
    compile: urlModuleCompiler(WASM_BASE_URL),
    load: urlModuleLoader(WASM_BASE_URL),
  });
  const tiff = await convertRaw(runner, path, bytes);
  // Frees the source and the runner's own reference.
  runner.clear();
  return tiff;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/raw-preview.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full unit suite**

Run: `npx jest`
Expected: PASS. If anything outside these two files references `RawSourceIo.load`, it fails here; grep with `grep -rn "\.load" src/lib/raw-preview.ts src/lib/host/raw-io.ts` and fix.

- [ ] **Step 6: Lint and commit**

```bash
npx ultracite check src/lib/raw-preview.ts src/lib/raw-preview.test.ts
git add src/lib/raw-preview.ts src/lib/raw-preview.test.ts
git commit -m "refactor(raw): inject a converter rather than a module loader

A ModuleLoader is a function, and a function cannot cross postMessage, so
it cannot stay the injection point once the conversion runs in a worker.
tiffFor takes a path and bytes and returns a TIFF, which crosses cleanly.

Named for what it returns rather than what it does, because under #243 it
will often answer from OPFS without converting anything.

The cache tests lose their fake Emscripten module along with it: what they
were ever asserting is that a frame converts once, and a counting callback
says that in four lines rather than fifty.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The worker and its client

**Files:**
- Create: `src/lib/raw-worker.types.ts`
- Create: `src/lib/raw-worker.ts`
- Create: `src/lib/raw-worker-client.ts`
- Create: `src/lib/raw-worker-client.test.ts`
- Modify: `src/lib/raw-preview.ts` (default `tiffFor` to the client)

**Interfaces:**
- Consumes: `convertRaw` from Task 1; `RawSourceIo.tiffFor` from Task 2.
- Produces: `convertRawInWorker(path: string, bytes: Uint8Array, wasmBaseUrl: string): Promise<Uint8Array>` and `resetRawWorker(): void`, both from `src/lib/raw-worker-client.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/raw-worker-client.test.ts`. The worker double detaches what it is given via `ArrayBuffer.prototype.transfer()`, the same primitive the structured clone algorithm uses; see `src/app/home-page/pipeline-worker-client.test.ts` for the established pattern.

```ts
/**
 * One worker, one queue.
 *
 * Conversions are serialised deliberately. `WasmToolRunner.clear()` keeps its
 * compiled modules, so a single worker converting ten frames in turn compiles
 * `dcraw_emu` once and peaks at one instance, where a pool would compile per
 * worker and multiply a 266 MiB peak by its width.
 *
 * The other two properties here are failure properties: a worker that dies
 * must reject the conversion waiting on it rather than leaving it suspended,
 * and must not poison the ones behind it.
 */

import { afterEach, describe, expect, it } from "@jest/globals";

declare const jest: typeof import("@jest/globals").jest;

import { convertRawInWorker, resetRawWorker } from "./raw-worker-client";

interface Pending {
  respond: (tiff: Uint8Array) => void;
  fail: () => void;
}

/** Every worker the client has constructed, in order. */
const built: FakeWorker[] = [];
const pending: Pending[] = [];

class FakeWorker {
  private readonly listeners = new Map<
    string,
    ((event: unknown) => void)[]
  >();

  posts = 0;
  terminated = false;

  constructor() {
    built.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(_message: unknown, transfer: Transferable[] = []) {
    for (const item of transfer) {
      (item as ArrayBuffer).transfer();
    }
    this.posts += 1;
    pending.push({
      fail: () => this.emit("error", { message: "worker died" }),
      respond: (tiff: Uint8Array) =>
        this.emit("message", { data: { kind: "done", tiff } }),
    });
  }

  terminate() {
    this.terminated = true;
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const realWorker = (globalThis as { Worker?: unknown }).Worker;

function install() {
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
}

/** Lets queued microtasks run, so a chained conversion reaches postMessage. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  resetRawWorker();
  built.length = 0;
  pending.length = 0;
  (globalThis as { Worker?: unknown }).Worker = realWorker;
});

describe("driving the RAW worker", () => {
  it("sends one frame at a time", async () => {
    install();

    const first = convertRawInWorker("/in/a.CR2", new Uint8Array([1]), "/wasm");
    const second = convertRawInWorker("/in/b.CR2", new Uint8Array([2]), "/wasm");
    await settle();

    // The second frame has not been sent: the whole point of the queue is that
    // two instances of a tool peaking at 266 MiB never exist at once.
    expect(built).toHaveLength(1);
    expect(built[0]?.posts).toBe(1);

    pending[0]?.respond(new Uint8Array([9]));
    await expect(first).resolves.toEqual(new Uint8Array([9]));
    await settle();
    expect(built[0]?.posts).toBe(2);

    pending[1]?.respond(new Uint8Array([8]));
    await expect(second).resolves.toEqual(new Uint8Array([8]));
  });

  it("leaves the caller's bytes intact", async () => {
    install();
    const bytes = new Uint8Array([1, 2, 3]);

    const conversion = convertRawInWorker("/in/a.CR2", bytes, "/wasm");
    await settle();
    pending[0]?.respond(new Uint8Array([9]));
    await conversion;

    // `readFile` hands back the session filesystem's own array, so a client
    // that transferred what it was given would empty it. Same defect as the
    // pipeline client's, and the same rule: copy before you transfer.
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("rejects the frame a dying worker was holding", async () => {
    install();

    const conversion = convertRawInWorker(
      "/in/a.CR2",
      new Uint8Array([1]),
      "/wasm"
    );
    await settle();
    pending[0]?.fail();

    await expect(conversion).rejects.toThrow("worker died");
  });

  it("builds a fresh worker after one dies", async () => {
    install();

    const doomed = convertRawInWorker(
      "/in/a.CR2",
      new Uint8Array([1]),
      "/wasm"
    );
    await settle();
    pending[0]?.fail();
    await expect(doomed).rejects.toThrow("worker died");

    const next = convertRawInWorker("/in/b.CR2", new Uint8Array([2]), "/wasm");
    await settle();

    // Queueing behind a corpse would suspend every later frame forever, so an
    // OOM on one frame must cost that frame and nothing else.
    expect(built).toHaveLength(2);
    pending[1]?.respond(new Uint8Array([7]));
    await expect(next).resolves.toEqual(new Uint8Array([7]));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/raw-worker-client.test.ts`
Expected: FAIL, `Cannot find module './raw-worker-client'`.

- [ ] **Step 3: Create `src/lib/raw-worker.types.ts`**

```ts
/**
 * The message protocol between the page and the RAW worker.
 *
 * In its own module so the client can import the types without pulling in the
 * worker body, which would defeat the point of having one.
 */

/** One frame to convert. The worker reads no files itself. */
export interface RawConvertRequest {
  bytes: Uint8Array;
  /** The original path. Used for the work filename and in error messages. */
  path: string;
  /** Where the wasm artifacts are served from, resolved to an absolute URL. */
  wasmBaseUrl: string;
}

export type RawWorkerMessage =
  | { kind: "done"; tiff: Uint8Array }
  | { kind: "failed"; message: string };
```

- [ ] **Step 4: Create `src/lib/raw-worker.ts`**

```ts
/// <reference lib="webworker" />

/**
 * Converts RAW frames off the main thread.
 *
 * `callMain` is synchronous: it blocks its thread for the whole tool, and a
 * 5796x3870 CR2 takes about 1.9 s. Thumbnails convert every frame in a set, so
 * on the main thread a 10-frame bracket froze the tab for about 20 s -- no
 * repaints, no clicks, and eventually the browser's "page is not responding"
 * prompt. The pipeline already moved into a worker for exactly this reason;
 * the preview path is the half that was left behind.
 *
 * One runner for the life of the worker. `clear()` drops the staged bytes but
 * keeps the compiled modules, so ten frames cost one compile of `dcraw_emu`
 * rather than ten.
 */

import {
  urlModuleCompiler,
  urlModuleLoader,
  WasmToolRunner,
} from "./pipeline/wasm-runner";
import { convertRaw } from "./raw-convert";
import type { RawConvertRequest, RawWorkerMessage } from "./raw-worker.types";

declare const self: DedicatedWorkerGlobalScope;

let runner: WasmToolRunner | undefined;

function runnerFor(wasmBaseUrl: string): WasmToolRunner {
  runner ??= new WasmToolRunner({
    compile: urlModuleCompiler(wasmBaseUrl),
    load: urlModuleLoader(wasmBaseUrl),
  });
  return runner;
}

function post(message: RawWorkerMessage, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

self.addEventListener("message", (event: MessageEvent<RawConvertRequest>) => {
  convert(event.data)
    .then((tiff) => {
      // Transferred, not copied: a converted CR2 is about 67 MB. Safe because
      // the runner was cleared first, so this array is no longer held here.
      post({ kind: "done", tiff }, [tiff.buffer as ArrayBuffer]);
    })
    .catch((error: unknown) => {
      post({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
});

async function convert(request: RawConvertRequest): Promise<Uint8Array> {
  const active = runnerFor(request.wasmBaseUrl);
  try {
    return await convertRaw(active, request.path, request.bytes);
  } finally {
    // Between frames rather than at the end: the runner survives to keep its
    // compiled modules, so its staged bytes must not survive with it.
    active.clear();
  }
}
```

- [ ] **Step 5: Create `src/lib/raw-worker-client.ts`**

```ts
/**
 * Drives the RAW worker from the page.
 *
 * One worker, one queue. Frames are converted in turn rather than in parallel:
 * `WasmToolRunner.clear()` keeps its compiled modules, so a single worker
 * doing ten frames compiles `dcraw_emu` once and peaks at one instance's
 * ~266 MiB, where a pool would compile per worker and multiply that peak by
 * its width. The complaint being fixed is responsiveness, not throughput, and
 * a queue fixes it without spending any memory.
 */

import type { RawConvertRequest, RawWorkerMessage } from "./raw-worker.types";

let worker: Worker | undefined;
/** Resolves when the frame in flight has finished, whatever its outcome. */
let queue: Promise<unknown> = Promise.resolve();

function ensureWorker(): Worker {
  worker ??= new Worker(new URL("./raw-worker.ts", import.meta.url), {
    type: "module",
  });
  return worker;
}

/**
 * Drops the worker so the next frame builds a fresh one.
 *
 * A worker that has errored may be in any state at all, and queueing later
 * frames behind it would suspend them forever. An OOM on one frame then costs
 * that frame rather than the rest of the session.
 */
export function resetRawWorker(): void {
  worker?.terminate();
  worker = undefined;
  queue = Promise.resolve();
}

export function convertRawInWorker(
  path: string,
  bytes: Uint8Array,
  wasmBaseUrl: string
): Promise<Uint8Array> {
  const conversion = queue.then(() => send(path, bytes, wasmBaseUrl));
  // Swallowed on the queue only: a failed frame must not stop the ones behind
  // it, but its own caller still sees the rejection through `conversion`.
  queue = conversion.catch(() => undefined);
  return conversion;
}

function send(
  path: string,
  bytes: Uint8Array,
  wasmBaseUrl: string
): Promise<Uint8Array> {
  const active = ensureWorker();

  return new Promise<Uint8Array>((resolve, reject) => {
    const onMessage = (event: MessageEvent<RawWorkerMessage>) => {
      cleanup();
      if (event.data.kind === "done") {
        resolve(event.data.tiff);
        return;
      }
      reject(new Error(event.data.message));
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      // The worker is gone, or in a state nobody can describe. Either way it
      // must not receive the next frame.
      resetRawWorker();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      active.removeEventListener("message", onMessage as EventListener);
      active.removeEventListener("error", onError as EventListener);
    };

    active.addEventListener("message", onMessage as EventListener);
    active.addEventListener("error", onError as EventListener);

    const request: RawConvertRequest = {
      // Copied, not handed over. `readFile` may return the session
      // filesystem's own array, and transferring that would empty it -- the
      // defect fixed in 93ba5fc. The copy is this client's to give away.
      bytes: bytes.slice(),
      path,
      wasmBaseUrl,
    };
    active.postMessage(request, [request.bytes.buffer as ArrayBuffer]);
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/lib/raw-worker-client.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Point `raw-preview.ts` at the worker**

Replace `inlineTiffFor` from Task 2 with the worker client, and delete the now-unused imports of `WasmToolRunner`, `urlModuleCompiler`, `urlModuleLoader`, `convertRaw` and the `ModuleLoader` type from `raw-preview.ts`.

```ts
import { convertRawInWorker } from "./raw-worker-client";

/**
 * Where the browser builds are served from. See `public/wasm/README.md`.
 *
 * Resolved against the document rather than left relative, because a worker's
 * own base URL is the chunk it was loaded from, which is not where the
 * artifacts live.
 */
function wasmBaseUrl(): string {
  return new URL("/wasm", globalThis.location?.href ?? "http://localhost/")
    .href;
}

/** The default converter: the worker. Tests inject their own. */
function workerTiffFor(path: string, bytes: Uint8Array): Promise<Uint8Array> {
  return convertRawInWorker(path, bytes, wasmBaseUrl());
}
```

Then in `convert`, replace `io.tiffFor ?? inlineTiffFor` with `io.tiffFor ?? workerTiffFor`, and delete the old `const WASM_BASE_URL = "/wasm";`.

- [ ] **Step 8: Run the full unit suite**

Run: `npx jest`
Expected: PASS. `raw-preview.test.ts` injects `tiffFor` in every test, so no test constructs a real worker, which jsdom cannot provide.

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx ultracite check src/lib/raw-worker.ts src/lib/raw-worker.types.ts src/lib/raw-worker-client.ts src/lib/raw-worker-client.test.ts src/lib/raw-preview.ts`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/raw-worker.ts src/lib/raw-worker.types.ts src/lib/raw-worker-client.ts src/lib/raw-worker-client.test.ts src/lib/raw-preview.ts
git commit -m "fix(raw): convert RAW frames in a worker, not on the main thread

callMain is synchronous, and thumbnails convert every frame in a set, so
loading a 10-frame CR2 bracket blocked the main thread for about 20 s: no
repaints, no clicks, and eventually the browser's not-responding prompt.
The pipeline moved into a worker for exactly this reason. The preview path
is the half that was left behind.

One worker, frames queued. WasmToolRunner.clear() keeps its compiled
modules, so ten frames cost one compile of dcraw_emu and peak at a single
instance, where a pool would compile per worker and multiply a 266 MiB
peak by its width. The complaint is responsiveness, not throughput.

A worker that errors is dropped rather than reused, so an OOM on one frame
costs that frame instead of suspending every frame behind it.

The source bytes are copied before the transfer: readFile may hand back the
session filesystem's own array, and transferring it would empty the store.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Browser regression test

The unit tests prove the client queues and recovers. Only a real browser proves the page stays responsive, because only a real browser has a main thread to block.

**Files:**
- Modify: `e2e-web/tests/support.ts` (add a CR2 bracket loader)
- Modify: `e2e-web/tests/pipeline.spec.ts` (add the responsiveness spec)

**Interfaces:**
- Consumes: nothing from earlier tasks; this exercises the shipped build.
- Produces: `loadCr2Frames(page: Page, count: number): Promise<void>` from `e2e-web/tests/support.ts`.

- [ ] **Step 1: Add the fixture loader**

In `e2e-web/tests/support.ts`, beside the existing `jpegFiles` export, add:

```ts
export const cr2Directory = path.join(inputsDirectory, "CR2");

export const cr2Files = readdirSync(cr2Directory)
  .filter((name) => path.extname(name).toLowerCase() === ".cr2")
  .toSorted()
  .map((name) => path.join(cr2Directory, name));
```

Then, beside `loadJpegBracket`, add:

```ts
/**
 * Loads the first `count` frames of the CR2 bracket and waits for thumbnails.
 *
 * A subset rather than all ten. Each frame is 21.7 MB and takes about 1.9 s to
 * demosaic, so the full bracket is ~290 MB and ~19 s -- more than this test
 * needs to say what it is asserting. Three frames is ~6 s of conversion, which
 * a main-thread implementation cannot hide from a 100 ms heartbeat.
 */
export async function loadCr2Frames(
  page: Page,
  count: number
): Promise<void> {
  const frames = cr2Files.slice(0, count);
  await choose(page, () => page.locator("#image-matrix-input").click(), frames);
  await expect(
    page.locator('[data-testid="image-set-preview"] .generic-image-container')
  ).toHaveCount(frames.length, { timeout: 180_000 });
}
```

- [ ] **Step 2: Write the failing test**

In `e2e-web/tests/pipeline.spec.ts`, add the import of `loadCr2Frames` to the existing `./support` import block, then append:

```ts
/**
 * Converting a RAW frame must not block the page either.
 *
 * The pipeline moved into a worker and this spec's sibling has guarded that
 * ever since. The preview path was left behind: thumbnails convert every frame
 * in a set through `rawToTiff`, `callMain` is synchronous, and a 5796x3870 CR2
 * takes about 1.9 s -- so loading a bracket froze the tab for as long as it
 * took to demosaic all of it.
 *
 * The instrument is the same 100 ms heartbeat, pointed at loading rather than
 * running. Against a main-thread conversion it records gaps of seconds.
 */
test("the page stays responsive while RAW thumbnails are converted", async ({
  page,
}) => {
  // Three 21.7 MB frames to upload and demosaic, well past the default budget.
  test.setTimeout(300_000);

  await page.goto("/home-page");

  await page.evaluate(() => {
    const w = window as unknown as { __beats: number[] };
    w.__beats = [];
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      w.__beats.push(now - last);
      last = now;
    }, 100);
  });

  await loadCr2Frames(page, 3);

  const { beats, worst } = await page.evaluate(() => {
    const w = window as unknown as { __beats: number[] };
    return { beats: w.__beats.length, worst: Math.max(...w.__beats) };
  });

  // Same margin as the pipeline's own responsiveness check: under ~1s of gap
  // is scheduler noise, where a blocked main thread produced tens of seconds.
  expect(beats).toBeGreaterThan(20);
  expect(worst).toBeLessThan(1000);
});
```

- [ ] **Step 3: Verify it fails against the old behaviour**

This is the step that proves the test is worth having. Revert **only the worker wiring** and rebuild, leaving the new test in place:

```bash
# From the repository root. Do NOT stash: the new spec is uncommitted, and
# stashing it would leave `-g "RAW thumbnails"` matching no test at all,
# which reports "no tests found" rather than the failure you are looking for.
git checkout HEAD~1 -- src/lib/raw-preview.ts   # Task 2's main-thread converter
npm run build
cd e2e-web && npx playwright test -g "RAW thumbnails" --project=chromium
```

Expected: FAIL on `worst`, a main-thread conversion of three frames records a gap of several thousand milliseconds.

Then restore, and confirm the tree is clean apart from the two test files:

```bash
cd /Users/ulbrical/GitHub/HDRICalibrationTool
git checkout HEAD -- src/lib/raw-preview.ts
git status --short   # expect only e2e-web/tests/*.ts modified
```

Two environment notes:

- `npm run build` and `npx playwright test` both need `dangerouslyDisableSandbox`: the Next build binds a port, which the sandbox denies with `Operation not permitted (os error 1)`.
- The shell's working directory persists between commands. After `cd e2e-web`, later commands are still there. Use absolute paths, or `cd` back explicitly as shown.

- [ ] **Step 4: Verify it passes with the worker**

```bash
npm run build
cd e2e-web && npx playwright test -g "RAW thumbnails"
```

Expected: PASS in both WebKit and Chromium.

- [ ] **Step 5: Run the whole browser suite**

Run: `cd e2e-web && npx playwright test`
Expected: 20 passed. The four existing pipeline specs must be unaffected; if `generates two HDR pictures from the JPEG bracket` broke, the seam change reached the JPEG path, which it should not have.

- [ ] **Step 6: Lint and commit**

```bash
cd /Users/ulbrical/GitHub/HDRICalibrationTool
npx ultracite check e2e-web/tests
git add e2e-web/tests/support.ts e2e-web/tests/pipeline.spec.ts
git commit -m "test(raw): guard the page against a main-thread conversion

The pipeline's own responsiveness spec has guarded its worker since it
moved. This is the same instrument -- a 100 ms heartbeat, no gap over 1 s --
pointed at loading a CR2 bracket rather than running the pipeline.

Three frames rather than ten. Each is 21.7 MB and about 1.9 s to demosaic,
so three is ~6 s of conversion, far past what a 100 ms heartbeat can miss,
without spending ~19 s and 290 MB to say it.

Verified in both directions: with the conversion back on the main thread it
records gaps of seconds; with the worker it passes in WebKit and Chromium.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| `raw-convert.ts`, pure conversion | 1 |
| `RawSourceIo.load` → `tiffFor` | 2 |
| Assertion redistribution table | 1 (two move), 2 (five stay) |
| `raw-worker.ts`, one long-lived runner | 3 |
| `raw-worker-client.ts`, one worker + queue | 3 |
| Error handling: reject in flight, drop the worker | 3 (steps 1, 5) |
| `wasmBaseUrl` resolved absolute | 3 (step 7) |
| Cache contract, `BUDGET_BYTES`, `peekRawTiff` unchanged | 1-3 (untouched; guarded by the surviving cache tests) |
| Browser regression test via the heartbeat | 4 |
| CR2 fixture reachable from `e2e-web` | 4 (step 1: confirmed present at `e2e-tests/test/inputs/CR2/`, 10 frames, 21.7 MB each) |

The spec's fallback ("if the CR2 bracket is too large or too slow, assert over a single frame") is resolved: Task 4 uses three frames, which is the middle of that range.

**Placeholder scan:** No TBD/TODO. Every code step carries the code. Task 4 step 3 carries the exact revert commands rather than "verify it fails".

**Type consistency:** `tiffFor(path, bytes)` is used identically in Task 2 (interface, `convert`), Task 3 (`workerTiffFor`) and the tests. `convertRaw(runner, path, bytes)` is identical in Tasks 1 and 3. `convertRawInWorker(path, bytes, wasmBaseUrl)` matches between `raw-worker-client.ts` and its test. `RawConvertRequest` fields (`bytes`, `path`, `wasmBaseUrl`) match between the types module, the worker and the client.
