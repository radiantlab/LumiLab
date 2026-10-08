# hdrgen Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the same `hdrgen` merge across five environments so the PRD's
"roughly 2x native" claim, and the unexplained gap between 22 s under Node and
a browser run that never finished, can be answered with numbers.

**Architecture:** One argv builder and one fixture resolver shared by every
leg, so no two legs can drift onto different inputs. Each leg is a small module
returning the same record shape. An orchestrator runs them, and a reporter
turns records into a table. The browser legs run under Playwright against a
bare page with no app, no Next build and no worker, served entirely through
request interception so nothing has to be added to `public/` or `out/`.

**Tech Stack:** Node ESM scripts, `node:test` for the pure helpers, Playwright
for the browser legs, CMake and clang for the native build.

**Design:** [`docs/superpowers/specs/2026-08-06-hdrgen-benchmark-design.md`](../specs/2026-08-06-hdrgen-benchmark-design.md)

## Global Constraints

- **`native-arm64` must be built from commit `ad214f25362dd330f35c27c90d8470bd66c0fc19`**,
  which `public/wasm/versions.json` records as the source of the shipped
  `.wasm`. The checkout at `../hdrgen` is already at that commit. Do not
  check out anything else, do not pull, and do not leave its HEAD moved.
- **All legs share one argv builder.** No leg may construct its own arguments.
  The shape is `-m 1000 <frames…> -o <out> -r <response> -a -e -f -g -F`.
- **Frame counts are 4, 8 and 18. Three repetitions each.** Report median with
  min and max.
- **A timeout is a result, not an error.** Every run has a 300 s ceiling, and a
  run that hits it is recorded with `status: "timeout"` and reported as such.
- **Startup is timed separately from the merge.** Never summed into one figure.
- **No new npm dependencies.** Node's built-ins plus the Playwright already in
  `e2e-web`.
- **Nothing is written into `public/`, `out/`, or the hdrgen checkout's tracked
  files.** Build output goes in a new untracked directory beside the existing
  `build-web/` and `build-node/`.
- **Commit style:** lowercase `type(scope): summary`, imperative, ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Lint with `npx ultracite fix`** on any TypeScript touched under `e2e-web`.

## The record every leg returns

Defined once here; every task produces or consumes exactly this.

```js
/**
 * One timed run of one leg at one frame count.
 *
 * `startupMs` is module compile plus runtime init, and is null for native legs
 * where there is no such phase. `runMs` is the merge alone, and is null when
 * the run did not produce a result.
 */
{
  leg: string,        // "native-arm64" | "native-x86_64" | "wasm-node" | "wasm-chromium" | "wasm-webkit"
  frames: number,     // 4 | 8 | 18
  rep: number,        // 1-based
  startupMs: number | null,
  runMs: number | null,
  outBytes: number,   // 0 when nothing was produced
  status: string,     // "ok" | "timeout" | "error"
  detail: string | null,
}
```

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/bench-hdrgen/fixtures.mjs` | Resolves the bracket and response function; builds the argv. The single source of truth for what is measured. |
| `scripts/bench-hdrgen/report.mjs` | Pure: median/min/max over records, and table formatting. |
| `scripts/bench-hdrgen/native.mjs` | Runs one native binary, timed, returns a record. |
| `scripts/bench-hdrgen/wasm-node.mjs` | Runs the shipped wasm in Node, timed, returns a record. |
| `scripts/bench-hdrgen/run.mjs` | Orchestrates every leg, shells out for the browser legs, prints the table. |
| `scripts/bench-hdrgen/README.md` | How to run it, and how to read the two asymmetries. |
| `e2e-web/tests/hdrgen.bench.ts` | The browser legs. Writes records as JSON for `run.mjs`. |
| `e2e-web/hdrgen-bench.config.ts` | Chromium and WebKit projects for that spec only. |

---

### Task 1: Shared fixtures, argv, and the reporter

**Files:**
- Create: `scripts/bench-hdrgen/fixtures.mjs`
- Create: `scripts/bench-hdrgen/report.mjs`
- Test: `scripts/bench-hdrgen/bench.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, from `fixtures.mjs`:
  `INPUTS` (absolute path string), `RESPONSE` (absolute path string),
  `frameFiles(count: number): string[]` (absolute paths, sorted, first `count`),
  `stagedName(path: string, index: number): string` (`"<n>-<basename>"`),
  `hdrgenArgv({ frames, response, out }): string[]`.
  From `report.mjs`: `median(values: number[]): number`,
  `summarise(records: object[]): object[]`, `formatTable(rows: object[]): string`.
  Tasks 2 through 5 consume these.

- [ ] **Step 1: Write the failing tests**

Create `scripts/bench-hdrgen/bench.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { frameFiles, hdrgenArgv, stagedName } from "./fixtures.mjs";
import { formatTable, median, summarise } from "./report.mjs";

test("frameFiles returns the requested count, sorted", () => {
  const four = frameFiles(4);
  assert.equal(four.length, 4);
  assert.deepEqual([...four].sort(), four);
  assert.ok(four[0].endsWith(".JPG"));
});

test("frameFiles(18) is the whole bracket", () => {
  assert.equal(frameFiles(18).length, 18);
});

// Every leg has to measure the same work. A leg building its own arguments is
// how a benchmark ends up comparing two different things and reporting the
// difference as an engine result.
test("hdrgenArgv matches the shape the app builds", () => {
  const argv = hdrgenArgv({
    frames: ["/src/1-a.JPG", "/src/2-b.JPG"],
    out: "/work/out.hdr",
    response: "/src/resp.rsp",
  });
  assert.deepEqual(argv, [
    "-m",
    "1000",
    "/src/1-a.JPG",
    "/src/2-b.JPG",
    "-o",
    "/work/out.hdr",
    "-r",
    "/src/resp.rsp",
    "-a",
    "-e",
    "-f",
    "-g",
    "-F",
  ]);
});

test("stagedName keeps the basename and prefixes the position", () => {
  assert.equal(stagedName("/a/b/IMG_6955.JPG", 0), "1-IMG_6955.JPG");
});

test("median takes the middle of an odd set and the mean of an even one", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

// A timeout is data. Summarising it as a missing number, or worse as a zero,
// would report the one case this benchmark exists to measure as the fastest.
test("summarise reports timeouts instead of averaging them away", () => {
  const rows = summarise([
    { frames: 18, leg: "wasm-chromium", runMs: null, status: "timeout" },
    { frames: 18, leg: "wasm-chromium", runMs: null, status: "timeout" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].medianMs, null);
  assert.equal(rows[0].note, "2/2 timed out");
});

test("summarise groups by leg and frame count", () => {
  const rows = summarise([
    { frames: 4, leg: "wasm-node", runMs: 100, status: "ok" },
    { frames: 4, leg: "wasm-node", runMs: 300, status: "ok" },
    { frames: 4, leg: "wasm-node", runMs: 200, status: "ok" },
    { frames: 8, leg: "wasm-node", runMs: 500, status: "ok" },
  ]);
  assert.equal(rows.length, 2);
  const four = rows.find((row) => row.frames === 4);
  assert.equal(four.medianMs, 200);
  assert.equal(four.minMs, 100);
  assert.equal(four.maxMs, 300);
});

// A partly-timed-out cell is the interesting case: reporting only the runs that
// finished would make a leg that usually fails look fast.
test("summarise notes partial timeouts alongside the median", () => {
  const rows = summarise([
    { frames: 18, leg: "wasm-webkit", runMs: 1000, status: "ok" },
    { frames: 18, leg: "wasm-webkit", runMs: null, status: "timeout" },
  ]);
  assert.equal(rows[0].medianMs, 1000);
  assert.equal(rows[0].note, "1/2 timed out");
});

// A crash and a hang are different findings. Reporting a leg that aborted as
// one that "timed out" would send the next person looking for a slow engine
// when what they have is a broken one.
test("summarise tells an error apart from a timeout", () => {
  const rows = summarise([
    { frames: 8, leg: "wasm-webkit", runMs: 900, status: "ok" },
    { frames: 8, leg: "wasm-webkit", runMs: null, status: "error" },
  ]);
  assert.equal(rows[0].medianMs, 900);
  assert.equal(rows[0].note, "1/2 errored");
});

test("summarise counts both when a cell has each", () => {
  const rows = summarise([
    { frames: 18, leg: "wasm-chromium", runMs: null, status: "timeout" },
    { frames: 18, leg: "wasm-chromium", runMs: null, status: "error" },
  ]);
  assert.equal(rows[0].medianMs, null);
  assert.equal(rows[0].note, "1/2 timed out, 1/2 errored");
});

test("formatTable renders a header and one line per row", () => {
  const text = formatTable([
    { frames: 4, leg: "wasm-node", maxMs: 300, medianMs: 200, minMs: 100, note: null },
  ]);
  assert.match(text, /leg/);
  assert.match(text, /wasm-node/);
  assert.match(text, /0\.2/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test 'scripts/bench-hdrgen/**/*.test.mjs'`
Expected: FAIL, `Cannot find module '.../fixtures.mjs'`.

- [ ] **Step 3: Write `fixtures.mjs`**

```js
/**
 * What every leg measures, defined once.
 *
 * The whole benchmark rests on each environment doing identical work. A leg
 * that built its own argument vector, or reached for its own copy of the
 * bracket, would turn an input difference into what looks like an engine
 * result. So both live here and nothing else is allowed to construct them.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The same bracket the two end-to-end suites use. */
export const INPUTS = fileURLToPath(
  new URL("../../e2e-tests/test/inputs", import.meta.url)
);

export const RESPONSE = path.join(
  INPUTS,
  "response_function_files",
  "Response_function.rsp"
);

const JPEG_DIR = path.join(INPUTS, "JPEG");

export function frameFiles(count) {
  const all = readdirSync(JPEG_DIR)
    .filter((name) => name.toUpperCase().endsWith(".JPG"))
    .sort()
    .map((name) => path.join(JPEG_DIR, name));
  if (count > all.length) {
    throw new Error(`asked for ${count} frames, the bracket has ${all.length}`);
  }
  return all.slice(0, count);
}

/**
 * The name a frame is staged under, matching what the pipeline now does.
 *
 * Kept identical to the app's scheme so the argv a leg runs is the argv the
 * app would run, down to the string lengths.
 */
export function stagedName(file, index) {
  return `${index + 1}-${path.basename(file)}`;
}

/** Exactly `stages.ts:hdrgenArgs`, which is the point. */
export function hdrgenArgv({ frames, out, response }) {
  return [
    "-m",
    "1000",
    ...frames,
    "-o",
    out,
    "-r",
    response,
    "-a",
    "-e",
    "-f",
    "-g",
    "-F",
  ];
}
```

- [ ] **Step 4: Write `report.mjs`**

```js
/**
 * Turning records into something readable, and refusing to flatter a timeout.
 *
 * The temptation in a benchmark reporter is to drop runs that did not finish
 * so every cell has a number. That would report the slowest environment as
 * absent rather than slow, which is exactly backwards for the question this
 * benchmark was built to answer.
 */

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function summarise(records) {
  const cells = new Map();
  for (const record of records) {
    const key = `${record.leg}:${record.frames}`;
    const cell = cells.get(key) ?? { frames: record.frames, leg: record.leg, runs: [] };
    cell.runs.push(record);
    cells.set(key, cell);
  }

  return [...cells.values()].map(({ frames, leg, runs }) => {
    const finished = runs.filter((run) => run.status === "ok" && run.runMs !== null);
    const times = finished.map((run) => run.runMs);

    // A hang and a crash are different findings, and telling them apart is
    // most of why this benchmark exists. Counting both as "timed out" would
    // report a module that aborted immediately as one that was merely slow,
    // which points the investigation in the wrong direction.
    const counted = [
      ["timed out", runs.filter((run) => run.status === "timeout").length],
      ["errored", runs.filter((run) => run.status === "error").length],
    ].filter(([, count]) => count > 0);

    return {
      frames,
      leg,
      maxMs: times.length ? Math.max(...times) : null,
      medianMs: times.length ? median(times) : null,
      minMs: times.length ? Math.min(...times) : null,
      note: counted.length
        ? counted.map(([label, count]) => `${count}/${runs.length} ${label}`).join(", ")
        : null,
    };
  });
}

const seconds = (ms) => (ms === null ? "—" : (ms / 1000).toFixed(1));

export function formatTable(rows) {
  const header = ["leg", "frames", "median", "min", "max", "note"];
  const body = rows.map((row) => [
    row.leg,
    String(row.frames),
    seconds(row.medianMs),
    seconds(row.minMs),
    seconds(row.maxMs),
    row.note ?? "",
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...body.map((line) => line[column].length))
  );
  const line = (cells) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join(
    "\n"
  );
}
```

- [ ] **Step 5: Run them and watch them pass**

Run: `node --test 'scripts/bench-hdrgen/**/*.test.mjs'`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench-hdrgen/
git commit -m "bench(hdrgen): one argv builder and one reporter for every leg

The benchmark only means anything if each environment runs identical work, so
the bracket, the argument vector and the staged naming live in one module that
every leg has to go through. The reporter refuses to drop runs that did not
finish: dropping them would report the slowest environment as absent rather
than slow.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The two native legs, including the arm64 build

**Files:**
- Create: `scripts/bench-hdrgen/native.mjs`
- Modify: `scripts/bench-hdrgen/bench.test.mjs` (append the smoke test)

**Interfaces:**
- Consumes: `frameFiles`, `hdrgenArgv`, `RESPONSE` from `fixtures.mjs`.
- Produces: `runNative({ binary, frames, leg, outDir, rep, timeoutMs }): Promise<record>`
  and `ARM64_BINARY` (absolute path string) and `ROSETTA_BINARY` (`"/usr/local/bin/hdrgen"`).
  Task 5 consumes all three.

- [ ] **Step 1: Build hdrgen for arm64**

The checkout is already at the pinned commit; confirm rather than assume, and
do not move it:

```bash
git -C ../hdrgen rev-parse HEAD
```

Expected: `ad214f25362dd330f35c27c90d8470bd66c0fc19`. If it differs, stop and
report; building from anything else invalidates the native column.

Then configure and build into a new directory beside the existing ones. The
dependency sources are already downloaded under `build-web/_deps`, so pointing
FetchContent at them skips the downloads:

```bash
cmake -S ../hdrgen -B ../hdrgen/build-native-arm64 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build ../hdrgen/build-native-arm64 --target hdrgen -j8
```

`CMakeLists.txt:7` leaves `CMAKE_OSX_ARCHITECTURES` unset deliberately so a
caller can pin it, which is why this works without patching anything.

This compiles OpenEXR and libjpeg-turbo among others, so expect minutes rather
than seconds, and network access for any source not already cached. If the
sandbox blocks the fetch, rerun with it disabled.

- [ ] **Step 2: Confirm the binary is actually arm64**

```bash
file ../hdrgen/build-native-arm64/hdrgen
```

Expected: `Mach-O 64-bit executable arm64`. If it says `x86_64`, the
architecture flag did not take and every native-arm64 number would be a second
Rosetta measurement wearing the wrong label. Stop and report.

- [ ] **Step 3: Write the failing smoke test**

Append to `scripts/bench-hdrgen/bench.test.mjs`:

```js
import { ARM64_BINARY, runNative } from "./native.mjs";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Two frames, once: this asserts the leg works, not how fast anything is.
test("runNative produces a picture and a duration", { timeout: 120_000 }, async () => {
  assert.ok(existsSync(ARM64_BINARY), `build it first: ${ARM64_BINARY}`);
  const record = await runNative({
    binary: ARM64_BINARY,
    frames: 2,
    leg: "native-arm64",
    outDir: mkdtempSync(path.join(tmpdir(), "bench-")),
    rep: 1,
    timeoutMs: 120_000,
  });
  assert.equal(record.status, "ok");
  assert.equal(record.leg, "native-arm64");
  assert.equal(record.frames, 2);
  assert.equal(record.startupMs, null);
  assert.ok(record.runMs > 0);
  assert.ok(record.outBytes > 1024);
});
```

Add `import path from "node:path";` to the file's imports if it is not already
there.

- [ ] **Step 4: Run it and watch it fail**

Run: `node --test 'scripts/bench-hdrgen/**/*.test.mjs'`
Expected: FAIL, `Cannot find module './native.mjs'`.

- [ ] **Step 5: Write `native.mjs`**

```js
/**
 * A native hdrgen run, timed.
 *
 * Two binaries are measured through this: one built here for arm64, and the
 * x86_64 one already installed, which runs under Rosetta on this machine. The
 * emulated figure is a lower bound on native performance and is labelled as
 * such wherever it is reported -- comparing wasm against an emulated binary and
 * calling the result parity is the mistake this whole benchmark exists to undo.
 *
 * Unlike the wasm legs there is no startup phase to separate out, so
 * `startupMs` is null. The process reads its frames from disk inside the timed
 * region, which the wasm legs do not; at these sizes that is small against the
 * merge, but it is real and the report says so.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frameFiles, hdrgenArgv, RESPONSE } from "./fixtures.mjs";

export const ARM64_BINARY = fileURLToPath(
  new URL("../../../hdrgen/build-native-arm64/hdrgen", import.meta.url)
);

export const ROSETTA_BINARY = "/usr/local/bin/hdrgen";

export function runNative({ binary, frames, leg, outDir, rep, timeoutMs }) {
  const out = path.join(outDir, `${leg}-${frames}-${rep}.hdr`);
  const argv = hdrgenArgv({
    frames: frameFiles(frames),
    out,
    response: RESPONSE,
  });

  return new Promise((resolve) => {
    const started = Date.now();
    execFile(binary, argv, { timeout: timeoutMs }, (error) => {
      const runMs = Date.now() - started;
      let outBytes = 0;
      try {
        outBytes = statSync(out).size;
      } catch {
        outBytes = 0;
      }

      // `killed` is how execFile reports the timeout, and it is the one failure
      // that is a result rather than a fault.
      const status = error?.killed ? "timeout" : outBytes > 0 ? "ok" : "error";
      resolve({
        detail: error && !error.killed ? String(error.message).slice(0, 200) : null,
        frames,
        leg,
        outBytes,
        rep,
        runMs: status === "ok" ? runMs : null,
        startupMs: null,
        status,
      });
    });
  });
}
```

- [ ] **Step 6: Run it and watch it pass**

Run: `node --test 'scripts/bench-hdrgen/**/*.test.mjs'`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add scripts/bench-hdrgen/
git commit -m "bench(hdrgen): the two native legs, arm64 and Rosetta

The installed hdrgen is an x86_64 binary on an arm64 machine, so every native
timing taken so far ran under translation against a native JIT. Building the
pinned fork commit for arm64 gives the comparison the PRD's 2x claim needs, and
keeping the emulated binary as its own leg measures what the translation costs
rather than leaving it as an unquantified doubt.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The wasm-on-node leg

**Files:**
- Create: `scripts/bench-hdrgen/wasm-node.mjs`
- Modify: `scripts/bench-hdrgen/bench.test.mjs` (append the smoke test)

**Interfaces:**
- Consumes: `frameFiles`, `hdrgenArgv`, `RESPONSE`, `stagedName` from `fixtures.mjs`.
- Produces: `runWasmNode({ frames, leg, rep, timeoutMs }): Promise<record>`.
  Task 5 consumes it.

- [ ] **Step 1: Write the failing smoke test**

Append to `scripts/bench-hdrgen/bench.test.mjs`:

```js
import { runWasmNode } from "./wasm-node.mjs";

test("runWasmNode separates startup from the merge", { timeout: 120_000 }, async () => {
  const record = await runWasmNode({
    frames: 2,
    leg: "wasm-node",
    rep: 1,
    timeoutMs: 120_000,
  });
  assert.equal(record.status, "ok");
  assert.ok(record.runMs > 0);
  // Startup is a real cost a user pays, but it is not the merge. Folding them
  // together would hide which one moved.
  assert.ok(record.startupMs !== null);
  assert.ok(record.outBytes > 1024);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test 'scripts/bench-hdrgen/**/*.test.mjs'`
Expected: FAIL, `Cannot find module './wasm-node.mjs'`.

- [ ] **Step 3: Write `wasm-node.mjs`**

```js
/**
 * The shipped wasm hdrgen, run in Node with no browser anywhere.
 *
 * This is the control. It uses the same `public/wasm/hdrgen.{js,wasm}` the
 * application ships, so a difference between this and a browser leg is the
 * engine and nothing else.
 *
 * The module is built for web and worker environments, so its own file reading
 * is not wired up for Node and it cannot fetch its `.wasm`. `instantiateWasm`
 * is the documented hook for supplying the compiled module instead, which
 * sidesteps that without patching the artifact being measured.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frameFiles, hdrgenArgv, RESPONSE, stagedName } from "./fixtures.mjs";

const WASM_DIR = fileURLToPath(new URL("../../public/wasm", import.meta.url));

export async function runWasmNode({ frames, leg, rep, timeoutMs }) {
  const files = frameFiles(frames);
  const factory = (await import(`file://${path.join(WASM_DIR, "hdrgen.js")}`)).default;
  const binary = readFileSync(path.join(WASM_DIR, "hdrgen.wasm"));

  const startupStarted = Date.now();
  const mod = await factory({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(binary, imports).then((result) => {
        done(result.instance, result.module);
      });
      return {};
    },
    noInitialRun: true,
    print: () => {
      /* the merge is chatty and the progress bars are not the measurement */
    },
    printErr: () => {
      /* likewise */
    },
  });
  const startupMs = Date.now() - startupStarted;

  mod.FS.mkdir("/src");
  mod.FS.mkdir("/work");
  const staged = files.map((file, index) => {
    const name = `/src/${stagedName(file, index)}`;
    mod.FS.writeFile(name, readFileSync(file));
    return name;
  });
  mod.FS.writeFile("/src/response.rsp", readFileSync(RESPONSE));

  const argv = hdrgenArgv({
    frames: staged,
    out: "/work/out.hdr",
    response: "/src/response.rsp",
  });

  // `callMain` is synchronous, so there is nothing to race a timer against: it
  // either returns or it does not. The ceiling is enforced by the orchestrator,
  // which runs each leg in its own process for exactly this reason.
  const started = Date.now();
  let status = "ok";
  let detail = null;
  try {
    mod.callMain(argv);
  } catch (error) {
    status = "error";
    detail = String(error).slice(0, 200);
  }
  const runMs = Date.now() - started;

  let outBytes = 0;
  try {
    outBytes = mod.FS.readFile("/work/out.hdr").length;
  } catch {
    outBytes = 0;
  }
  if (outBytes === 0 && status === "ok") {
    status = "error";
    detail = "no output produced";
  }

  return {
    detail,
    frames,
    leg,
    outBytes,
    rep,
    runMs: status === "ok" ? runMs : null,
    startupMs,
    status,
  };
}
```

Note that `timeoutMs` is accepted and deliberately unused here: `callMain` is
synchronous and cannot be interrupted from the same thread. Task 5 enforces the
ceiling by running this leg in a child process it can kill.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test 'scripts/bench-hdrgen/**/*.test.mjs'`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench-hdrgen/
git commit -m "bench(hdrgen): the wasm-on-node control leg

Runs the shipped public/wasm artifacts with no browser involved, so any
difference against a browser leg is the engine rather than the app, the worker
boundary or the UI. Startup is timed separately because a cold compile is a
real cost but not the same cost as the merge.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The browser legs

**Files:**
- Create: `e2e-web/tests/hdrgen.bench.ts`
- Create: `e2e-web/hdrgen-bench.config.ts`
- Modify: `e2e-web/package.json:9` (add the script)

**Interfaces:**
- Consumes: nothing from earlier tasks; it is a separate process. It hardcodes
  the same argv shape, and Task 5's orchestrator is what checks the two agree.
- Produces: a JSON file at the path in `BENCH_OUT` (default
  `/tmp/hdrgen-bench-browser.json`) containing an array of records in the shape
  defined at the top of this plan. Task 5 reads it.

- [ ] **Step 1: Write the config**

Create `e2e-web/hdrgen-bench.config.ts`:

```ts
/**
 * Config for `tests/hdrgen.bench.ts`, kept apart from both the suite and
 * `perf.config.ts`.
 *
 * `perf.config.ts` runs Chromium only, and says why: it compares two *hosts*
 * and wants the engine held fixed. This benchmark is the opposite question, so
 * it runs both engines on purpose. WebKit is not decoration here -- the desktop
 * app runs WKWebView and is reportedly fast, so WebKit is what separates
 * "browsers are slow at this" from "Chromium is slow at this".
 *
 * No `webServer`: the spec serves the wasm and the frames itself through
 * request interception, so there is no port to bind and nothing to add to
 * `public/` or `out/`.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  fullyParallel: false,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  reporter: [["list"]],
  // A retry would report a second, warmer run as if it were the first.
  retries: 0,
  testDir: "./tests",
  testMatch: /hdrgen\.bench\.ts/,
  // Longer than the per-run ceiling times three repetitions times three frame
  // counts, so the spec's own budget never truncates a measurement.
  timeout: 3_000_000,
  use: { trace: "off", video: "off" },
  workers: 1,
});
```

- [ ] **Step 2: Add the script**

In `e2e-web/package.json`, add to `scripts`, after `"bench"`:

```json
    "bench:hdrgen": "playwright test -c hdrgen-bench.config.ts",
```

- [ ] **Step 3: Write the spec**

Create `e2e-web/tests/hdrgen.bench.ts`:

```ts
/**
 * The same hdrgen merge, in a browser, with nothing else in the way.
 *
 * Deliberately not the app: no Next build, no worker, no UI, no other eleven
 * stages. It loads the same `public/wasm/hdrgen.js`, stages the same frames
 * under the same names, and calls the same `callMain`, so the only thing that
 * differs from the Node leg is the engine. That is the whole point -- a number
 * taken through the application could not tell a slow engine from a slow app.
 *
 * Everything is served by intercepting requests rather than by running a
 * server. A static server would need a port, a build, and somewhere to put a
 * page that is not `public/` or the generated `out/`.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const WASM_DIR = fileURLToPath(new URL("../../public/wasm", import.meta.url));
const INPUTS = fileURLToPath(new URL("../../e2e-tests/test/inputs", import.meta.url));
const JPEG_DIR = path.join(INPUTS, "JPEG");
const OUT = process.env.BENCH_OUT ?? "/tmp/hdrgen-bench-browser.json";

const FRAME_COUNTS = [4, 8, 18];
const REPS = 3;
const CEILING_MS = 300_000;

const allFrames = readdirSync(JPEG_DIR)
  .filter((name) => name.toUpperCase().endsWith(".JPG"))
  .sort();

const ORIGIN = "http://hdrgen-bench.test";

test("hdrgen across frame counts", async ({ page }, testInfo) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/index.html") {
      await route.fulfill({
        body: "<!doctype html><meta charset=utf-8><title>bench</title>",
        contentType: "text/html",
      });
      return;
    }
    if (url.pathname.startsWith("/wasm/")) {
      const file = path.join(WASM_DIR, path.basename(url.pathname));
      await route.fulfill({
        body: readFileSync(file),
        contentType: url.pathname.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript",
      });
      return;
    }
    if (url.pathname.startsWith("/frames/")) {
      const file = path.join(JPEG_DIR, path.basename(url.pathname));
      await route.fulfill({ body: readFileSync(file), contentType: "image/jpeg" });
      return;
    }
    if (url.pathname === "/response") {
      await route.fulfill({
        body: readFileSync(
          path.join(INPUTS, "response_function_files", "Response_function.rsp")
        ),
        contentType: "application/octet-stream",
      });
      return;
    }
    await route.fulfill({ status: 404, body: "" });
  });

  await page.goto(`${ORIGIN}/index.html`);

  const records: unknown[] = [];
  for (const frames of FRAME_COUNTS) {
    for (let rep = 1; rep <= REPS; rep += 1) {
      const names = allFrames.slice(0, frames);
      // biome-ignore lint/performance/noAwaitInLoops: each run must have the machine to itself, which is the entire point of a benchmark
      const record = await page.evaluate(
        async ({ ceiling, frameNames, repetition }) => {
          const startupStarted = performance.now();
          const factory = (await import("/wasm/hdrgen.js")).default;
          const mod = await factory({
            noInitialRun: true,
            print: () => undefined,
            printErr: () => undefined,
          });
          const startupMs = performance.now() - startupStarted;

          mod.FS.mkdir("/src");
          mod.FS.mkdir("/work");
          const staged: string[] = [];
          for (const [index, name] of frameNames.entries()) {
            const response = await fetch(`/frames/${name}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const staged_name = `/src/${index + 1}-${name}`;
            mod.FS.writeFile(staged_name, bytes);
            staged.push(staged_name);
          }
          const resp = await fetch("/response");
          mod.FS.writeFile("/src/response.rsp", new Uint8Array(await resp.arrayBuffer()));

          const argv = [
            "-m", "1000",
            ...staged,
            "-o", "/work/out.hdr",
            "-r", "/src/response.rsp",
            "-a", "-e", "-f", "-g", "-F",
          ];

          const started = performance.now();
          let status = "ok";
          let detail: string | null = null;
          try {
            mod.callMain(argv);
          } catch (error) {
            status = "error";
            detail = String(error).slice(0, 200);
          }
          const runMs = performance.now() - started;

          let outBytes = 0;
          try {
            outBytes = mod.FS.readFile("/work/out.hdr").length;
          } catch {
            outBytes = 0;
          }
          if (runMs > ceiling) {
            status = "timeout";
          }

          return {
            detail,
            frames: frameNames.length,
            outBytes,
            rep: repetition,
            runMs: status === "ok" ? runMs : null,
            startupMs,
            status,
          };
        },
        { ceiling: CEILING_MS, frameNames: names, repetition: rep }
      );
      records.push({ ...(record as object), leg: `wasm-${testInfo.project.name}` });
    }
  }

  writeFileSync(
    OUT.replace(/\.json$/, `.${testInfo.project.name}.json`),
    JSON.stringify(records, null, 2)
  );
});
```

- [ ] **Step 4: Run the Chromium project alone, at the smallest size**

Playwright's `--project` flag is swallowed when the command goes through
`npm --prefix`, so change directory instead:

```bash
cd e2e-web && npx playwright test -c hdrgen-bench.config.ts --project=chromium
```

Expected: one test passes and
`/tmp/hdrgen-bench-browser.chromium.json` exists with nine records. If Chromium
does not finish, that is a result: confirm the records show `status: "timeout"`
rather than the run erroring out, and report it.

- [ ] **Step 5: Lint and commit**

```bash
npx ultracite fix e2e-web/tests/hdrgen.bench.ts e2e-web/hdrgen-bench.config.ts
git add e2e-web/
git commit -m "bench(hdrgen): the browser legs, in a bare page

Not the app: no Next build, no worker, no UI, no other stages. Same artifacts,
same frames, same callMain as the Node leg, so a difference between them is the
engine and nothing else. Served by request interception rather than a static
server, so there is no port to bind and nothing added to public/ or out/.

Both engines on purpose, unlike perf.config.ts which fixes one: the desktop app
runs WKWebView and is reportedly fast, so WebKit is what tells a slow browser
apart from a slow Chromium.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The orchestrator

**Files:**
- Create: `scripts/bench-hdrgen/run.mjs`
- Create: `scripts/bench-hdrgen/README.md`
- Modify: `package.json:82` (add the script beside `wasm:versions`)

**Interfaces:**
- Consumes: `runNative`, `ARM64_BINARY`, `ROSETTA_BINARY` from `native.mjs`;
  `runWasmNode` from `wasm-node.mjs`; `summarise` and `formatTable` from
  `report.mjs`; the browser JSON files from Task 4.
- Produces: the printed table, and `bench-results.json` in the working
  directory.

- [ ] **Step 1: Write `run.mjs`**

```js
/**
 * Runs every leg and prints one table.
 *
 * The wasm-node leg runs in a child process rather than in this one. `callMain`
 * is synchronous, so a run that never returns cannot be timed out from the same
 * thread -- the only way to enforce a ceiling on it is to be able to kill it.
 */

import { execFile, fork } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARM64_BINARY, ROSETTA_BINARY, runNative } from "./native.mjs";
import { formatTable, summarise } from "./report.mjs";

const FRAME_COUNTS = [4, 8, 18];
const REPS = 3;
const CEILING_MS = 300_000;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../..");

function runWasmNodeInChild(frames, rep) {
  return new Promise((resolve) => {
    const child = fork(path.join(HERE, "wasm-node-child.mjs"), [String(frames), String(rep)], {
      silent: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        detail: null,
        frames,
        leg: "wasm-node",
        outBytes: 0,
        rep,
        runMs: null,
        startupMs: null,
        status: "timeout",
      });
    }, CEILING_MS);
    let payload = "";
    child.stdout.on("data", (chunk) => {
      payload += chunk;
    });
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(payload.trim().split("\n").at(-1)));
      } catch {
        resolve({
          detail: "child produced no record",
          frames,
          leg: "wasm-node",
          outBytes: 0,
          rep,
          runMs: null,
          startupMs: null,
          status: "error",
        });
      }
    });
  });
}

function playwright(project) {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["playwright", "test", "-c", "hdrgen-bench.config.ts", "--project", project],
      { cwd: path.join(REPO, "e2e-web"), timeout: 3_000_000 },
      () => resolve()
    );
  });
}

const records = [];
const outDir = mkdtempSync(path.join(tmpdir(), "bench-hdrgen-"));

for (const frames of FRAME_COUNTS) {
  for (let rep = 1; rep <= REPS; rep += 1) {
    for (const [leg, binary] of [
      ["native-arm64", ARM64_BINARY],
      ["native-x86_64", ROSETTA_BINARY],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: a benchmark must not run two measurements at once
      records.push(await runNative({ binary, frames, leg, outDir, rep, timeoutMs: CEILING_MS }));
    }
    // biome-ignore lint/performance/noAwaitInLoops: same reason
    records.push(await runWasmNodeInChild(frames, rep));
  }
}

for (const project of ["chromium", "webkit"]) {
  // biome-ignore lint/performance/noAwaitInLoops: same reason
  await playwright(project);
  try {
    records.push(
      ...JSON.parse(readFileSync(`/tmp/hdrgen-bench-browser.${project}.json`, "utf8"))
    );
  } catch {
    console.error(`no records from ${project}; it may not have finished`);
  }
}

writeFileSync("bench-results.json", JSON.stringify(records, null, 2));
console.log(formatTable(summarise(records)));
console.log(
  [
    "",
    "native-x86_64 runs under Rosetta on this machine and is a lower bound on",
    "native performance, never an upper one. The native legs read frames from",
    "disk inside the timed region; the wasm legs are handed bytes in memory.",
  ].join("\n")
);
```

- [ ] **Step 2: Write the child entry point**

Create `scripts/bench-hdrgen/wasm-node-child.mjs`:

```js
/**
 * One wasm-node run, in its own process so the orchestrator can kill it.
 *
 * Prints the record as JSON on the last line of stdout.
 */

import { runWasmNode } from "./wasm-node.mjs";

const [frames, rep] = process.argv.slice(2).map(Number);
const record = await runWasmNode({
  frames,
  leg: "wasm-node",
  rep,
  timeoutMs: 0,
});
process.stdout.write(`${JSON.stringify(record)}\n`);
```

- [ ] **Step 3: Add the npm script**

In the root `package.json`, in `scripts`, after `"wasm:versions:check"`:

```json
    "bench:hdrgen": "node scripts/bench-hdrgen/run.mjs",
```

- [ ] **Step 4: Write the README**

Create `scripts/bench-hdrgen/README.md`:

```markdown
# hdrgen benchmark

Measures the same merge in five places, to answer two questions the repository
otherwise only asserts: what the WebAssembly build actually costs against
native, and why a browser run has been seen taking orders of magnitude longer
than the same call under Node.

```sh
npm run bench:hdrgen
```

Build the arm64 binary first, from the commit `public/wasm/versions.json`
records as the source of the shipped `.wasm`:

```sh
cmake -S ../hdrgen -B ../hdrgen/build-native-arm64 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build ../hdrgen/build-native-arm64 --target hdrgen -j8
```

## Reading the output

Two asymmetries are deliberate and are printed under the table:

- **`native-x86_64` is emulated** on an arm64 machine, so it is a lower bound
  on native performance. The gap to `native-arm64` is the cost of translation.
- **The native legs read frames from disk inside the timed region.** The wasm
  legs are handed bytes already in memory, because that is how the application
  feeds them.

A cell showing `—` with a note did not finish inside the 300 s ceiling. That is
a result, not a missing measurement.
```

- [ ] **Step 5: Verify the helpers still pass and the script is wired**

```bash
node --test 'scripts/bench-hdrgen/**/*.test.mjs'
node -e "console.log(require('./package.json').scripts['bench:hdrgen'])"
```

Expected: all tests pass, and the second prints
`node scripts/bench-hdrgen/run.mjs`.

- [ ] **Step 6: Commit**

```bash
npx ultracite fix scripts/bench-hdrgen/ package.json
git add scripts/bench-hdrgen/ package.json
git commit -m "bench(hdrgen): orchestrate every leg into one table

The wasm-node leg runs in a child process because callMain is synchronous: a
run that never returns cannot be timed out from the thread it is blocking, and
the ceiling only means something if it can be enforced.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Run it, and write down what it says

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-hdrgen-benchmark-design.md` (status
  and a results section)

- [ ] **Step 1: Run the whole benchmark**

```bash
npm run bench:hdrgen
```

This takes a while: 27 native and node runs plus up to 18 browser runs, some of
which may sit on the full 300 s ceiling. Run it with the sandbox disabled, since
Playwright binds a port for its own machinery.

- [ ] **Step 2: Record the table in the design doc**

Change the status line to `measured`, and add a `## Results` section containing
the table verbatim, the date, and the machine (`sysctl -n machdep.cpu.brand_string`,
`uname -m`, and total RAM).

- [ ] **Step 3: Answer the two questions in prose**

Under the table, state plainly:

1. What the wasm build costs against a true arm64 native build, and whether the
   PRD's "roughly 2x native" claim survives. If it does not, say what the
   number actually is and note that `PRD.md:79` needs correcting.
2. Whether the browser legs match the Node leg. If they do, the binaries are
   fine everywhere and the slowness belongs to the application; if they do not,
   name which engines are affected and by how much.

Do not speculate beyond what the table supports. Where a result is ambiguous,
say what further measurement would settle it.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-06-hdrgen-benchmark-design.md
git commit -m "docs: record what the hdrgen benchmark measured

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Follow-ups, deliberately out of scope

- **`dcraw_emu`.** It dominates RAW import and deserves the same treatment, but
  one tool at a time.
- **Correcting `PRD.md:79`.** Task 6 says whether it needs it; changing it is a
  separate change with its own review.
- **CI.** This is a local instrument. Running it on a shared runner would
  measure the runner.
