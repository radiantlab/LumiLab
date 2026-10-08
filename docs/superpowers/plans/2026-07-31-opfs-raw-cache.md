# Persistent RAW-to-TIFF Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RAW-to-TIFF conversions survive a page reload, so a 10-frame CR2 bracket costs ~19 s of demosaic once rather than on every visit.

**Architecture:** A persistent tier sits behind the existing in-memory session tier, inside the RAW worker (`src/lib/raw-worker.ts`). The worker already holds the source bytes, so it hashes them, looks the hash up in a content-addressed blob store, and converts only on a miss. Blobs live in OPFS (or IndexedDB; Task 1 decides); a small index in IndexedDB carries sizes and last-used stamps, because OPFS exposes no access time and LRU eviction is unimplementable without it.

**Tech Stack:** TypeScript, Next.js static export, Web Workers, OPFS (`navigator.storage.getDirectory`), IndexedDB, Jest + jsdom for unit tests, Playwright (`e2e-web`) and WebdriverIO (`e2e-tests`) for browser and desktop.

**Design doc:** `docs/superpowers/specs/2026-07-31-opfs-raw-cache-design.md`
**Issue:** [#243](https://github.com/radiantlab/LumiLab/issues/243)

## Global Constraints

- **Budget: 2 GB**, fixed, for the persistent tier. Constant `BUDGET_BYTES = 2 * 1024 * 1024 * 1024`.
- **The cache may never be the reason a conversion fails.** A read failure is a miss; a write failure is logged and swallowed.
- **The session tier is untouched.** `src/lib/raw-preview.ts`, its 768 MB budget and its `path|size:mtime` key do not change.
- **`dcrawArgs` stays the single flag set.** Do not add a second, faster set for previews.
- **The cache write must precede the `postMessage` transfer.** Transferring detaches the buffer; caching afterwards persists a zero-byte file. This is the failure already fixed in `93ba5fc`.
- **The worker must resolve `versions.json` from the absolute `request.wasmBaseUrl`**, never a relative `/wasm`, which in a worker resolves against the worker's own chunk.
- **Never import `src/lib/presets.ts` from worker code.** It pulls in a React config provider. That is why Task 2 exists.
- Lint with `npm run check`; fix with `npm run fix`. Unit tests: `npm test`.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/lib/hash.ts` | `sha256Hex`, extracted so worker code can hash without importing preset machinery. |
| `src/lib/raw-cache.types.ts` | `BlobStore`, `CacheEntry`, `CacheIndex`. Importable without an implementation. |
| `src/lib/raw-cache.ts` | The tier: get, put, eviction, index, sweep, usage, clear. Storage injected. |
| `src/lib/raw-cache-key.ts` | Content hash + tool tag. Separate from storage because it is derivation, not I/O. |
| `src/lib/raw-cache-opfs.ts` | `opfsBlobStore()`. The only file that touches OPFS. |
| `e2e-web/tests/storage-probe.spec.ts` | Task 1's compatibility probe. |

> **Deviation from the spec, noted deliberately:** the design's component table lists three new files; this plan has four, splitting key derivation (`raw-cache-key.ts`) from storage (`raw-cache.ts`). They have different dependencies (the key needs `dcrawArgs` and `versions.json`, the store needs IndexedDB), and mixing them would make the cache untestable without stubbing a fetch.

**Modify:**

- `src/lib/presets.ts`: re-export `sha256Hex` from `hash.ts` (Task 2).
- `src/lib/storage/kv.ts`: add `updateDocument` (Task 3).
- `src/lib/raw-worker.ts`: consult and populate the cache (Task 8).
- `src/app/settings-page/page.tsx`: usage read-out and Clear button (Task 9).
- `e2e-web/tests/perf.bench.ts`: reload-survival measurement (Task 10).

---

### Task 1: Probe OPFS and IndexedDB across hosts

Gates the backend choice. Produces a compatibility table, not a feature. **Do not start Task 7 until this is recorded.**

**Files:**
- Create: `e2e-web/tests/storage-probe.spec.ts`
- Modify: `docs/superpowers/specs/2026-07-31-opfs-raw-cache-design.md` (record results)

**Interfaces:**
- Consumes: nothing.
- Produces: a decision, approach **A** (OPFS blobs) or **B** (IndexedDB blobs), which Task 7 implements.

- [ ] **Step 1: Write the probe**

```ts
// e2e-web/tests/storage-probe.spec.ts
/**
 * Answers #243's open question: does OPFS work where this app runs?
 *
 * Not a regression test. It reports a table and asserts only that the browser
 * did not lie -- bytes written must read back identical. Run it once per host
 * and record the result in the design doc; it decides whether the persistent
 * cache stores blobs in OPFS or in IndexedDB.
 */
import { expect, test } from "@playwright/test";

/** One converted CR2 frame, near enough. The realistic unit, not a token blob. */
const BLOB_BYTES = 67 * 1024 * 1024;

test("OPFS and IndexedDB accept a converted-frame-sized blob", async ({
  page,
}) => {
  await page.goto("/home-page");

  const report = await page.evaluate(async (size) => {
    const out: Record<string, unknown> = {};

    const estimate = await navigator.storage?.estimate?.();
    out.quota = estimate?.quota ?? null;
    out.usage = estimate?.usage ?? null;

    // A recognisable, non-uniform pattern: a run of zeroes would survive a
    // truncated write and still compare equal.
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i += 4096) {
      source[i] = (i / 4096) % 251;
    }

    out.opfsAvailable = typeof navigator.storage?.getDirectory === "function";
    if (out.opfsAvailable) {
      // Measured inside a dedicated worker, because `createSyncAccessHandle`
      // exists nowhere else -- which is the whole reason the persistent tier
      // sits in a worker. Timed against `createWritable` below so the choice
      // between them is made on numbers rather than on reasoning.
      const workerSource = `
        self.onmessage = async (event) => {
          const size = event.data;
          try {
            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle("probe-sync.bin", { create: true });
            if (typeof handle.createSyncAccessHandle !== "function") {
              self.postMessage({ available: false });
              return;
            }
            const access = await handle.createSyncAccessHandle();
            const bytes = new Uint8Array(size);
            const started = performance.now();
            access.write(bytes, { at: 0 });
            access.flush();
            const written = access.getSize();
            access.close();
            self.postMessage({
              available: true,
              writeMs: Math.round(performance.now() - started),
              written,
            });
            await root.removeEntry("probe-sync.bin");
          } catch (error) {
            self.postMessage({ available: true, error: String(error) });
          }
        };
      `;
      const worker = new Worker(
        URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }))
      );
      out.opfsSync = await new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ error: "timed out after 60s" }),
          60_000
        );
        worker.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.postMessage(size);
      });
      worker.terminate();

      try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle("probe.bin", { create: true });
        const writable = await handle.createWritable();
        const started = performance.now();
        await writable.write(source);
        await writable.close();
        out.opfsWriteMs = Math.round(performance.now() - started);

        const readStarted = performance.now();
        const back = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        out.opfsReadMs = Math.round(performance.now() - readStarted);
        out.opfsRoundTrips =
          back.length === source.length &&
          back[0] === source[0] &&
          back[size - 4096] === source[size - 4096];

        await root.removeEntry("probe.bin");
        out.opfsRemoved = true;
      } catch (error) {
        out.opfsError = String(error);
      }
    }

    try {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("probe-db", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("blobs");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const started = performance.now();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("blobs", "readwrite");
        transaction.objectStore("blobs").put(source.buffer.slice(0), "probe");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      out.idbWriteMs = Math.round(performance.now() - started);
      out.idbRoundTrips = true;
      database.close();
      indexedDB.deleteDatabase("probe-db");
    } catch (error) {
      out.idbError = String(error);
    }

    return out;
  }, BLOB_BYTES);

  process.stdout.write(
    `\n===STORAGE_PROBE===\n${JSON.stringify(report, null, 2)}\n===END===\n`
  );

  // Absence fails loudly rather than passing quietly. A green test on a host
  // with no OPFS would read as "verified" when nothing was verified at all,
  // and this run exists precisely to find out which hosts those are. A failure
  // here is a result to record, not a bug to fix.
  expect(report.opfsAvailable, "OPFS is available on this host").toBe(true);
  expect(report.opfsError, "OPFS write/read raised nothing").toBeUndefined();
  expect(report.opfsRoundTrips, "OPFS bytes read back identical").toBe(true);
  expect(report.idbError, "IndexedDB accepted a 67 MB value").toBeUndefined();
});
```

- [ ] **Step 2: Run it in both browser engines**

```bash
npm run build
npm --prefix e2e-web exec playwright test tests/storage-probe.spec.ts --project=webkit
npm --prefix e2e-web exec playwright test tests/storage-probe.spec.ts --project=chromium
```

Expected: PASS on both, with a `===STORAGE_PROBE===` block printed. WebKit is the one to watch; Safari has a history of OPFS write bugs.

- [ ] **Step 3: Run it on the desktop hosts**

The desktop suite is WebdriverIO, not Playwright. Port the `page.evaluate` body into a `browser.execute` call in a new `e2e-tests/test/specs/storage-probe.e2e.ts`, following the structure of `e2e-tests/test/specs/app.e2e.ts`. Run locally for WKWebView:

```bash
npm run test:e2e:desktop
```

For WebView2 (Windows) and WebKitGTK (Linux), push the branch and read the `e2e-tests` job output in CI, which already runs all three platforms.

- [ ] **Step 4: Record the results and decide**

Add a "Probe results" section to the design doc with a row per host:
`opfsAvailable`, `opfsRoundTrips`, `opfsWriteMs`, `opfsSync.available`,
`opfsSync.writeMs`, `quota`, `idbWriteMs`, and any error strings.

Decision rules, stated in advance so results are not rationalised after the fact.

**Backend:**
- OPFS round-trips correctly on **all five** engines (WebKit, Chromium, WKWebView, WebView2, WebKitGTK) → **approach A**.
- OPFS fails or corrupts on **any** engine → **approach B**, and note which.

**Write path**, if approach A wins:
- `createSyncAccessHandle` unavailable or erroring on any engine → `createWritable`.
- Available everywhere **and** more than 2x faster than `createWritable` on any
  engine → `createSyncAccessHandle`, and the implementer must never hold the
  handle across an `await`.
- Available everywhere but within 2x → `createWritable`, because the lock
  hazard buys nothing.

**Also amend the design doc's rationale for worker placement.** It currently
says the tier is in the worker *because* `createSyncAccessHandle` is worker-only.
That holds only if the sync path wins. The placement is correct regardless --
the worker already holds the source bytes, and hashing 22 MB on the main thread
would jank the UI the RAW worker exists to keep responsive -- so state that as
the primary reason and the API restriction as an additional one.

- [ ] **Step 5: Commit**

```bash
git add e2e-web/tests/storage-probe.spec.ts e2e-tests/test/specs/storage-probe.e2e.ts docs/superpowers/specs/2026-07-31-opfs-raw-cache-design.md
git commit -m "test(storage): probe OPFS and IndexedDB across every host

#243 assumes OPFS works in the three Tauri webviews and in Safari. Nothing in
the codebase uses OPFS today, so that was an assumption rather than a finding.
This records what each engine actually does with a converted-frame-sized blob."
```

---

### Task 2: Extract `sha256Hex` so worker code can hash

**Files:**
- Create: `src/lib/hash.ts`, `src/lib/hash.test.ts`
- Modify: `src/lib/presets.ts:79-85`

**Interfaces:**
- Consumes: nothing.
- Produces: `sha256Hex(bytes: Uint8Array): Promise<string>`, lowercase hex, 64 chars.

Why: `presets.ts` imports `pipelineConfig` from a React config provider, so importing it into a worker would drag React into the worker bundle.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/hash.test.ts
import { sha256Hex } from "./hash";

describe("sha256Hex", () => {
  it("returns the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("returns 64 lowercase hex characters", async () => {
    const digest = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes different bytes", async () => {
    expect(await sha256Hex(new Uint8Array([1]))).not.toBe(
      await sha256Hex(new Uint8Array([2]))
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/lib/hash.test.ts`
Expected: FAIL, `Cannot find module './hash'`.

- [ ] **Step 3: Create the module**

```ts
// src/lib/hash.ts
/**
 * Content hashing, in its own module so a worker can use it.
 *
 * This lived in `presets.ts`, which imports a React config provider. Importing
 * that into `raw-worker.ts` would pull React into the worker bundle for the
 * sake of one twelve-line function.
 */

/** Lowercase hex SHA-256. `crypto.subtle` is polyfilled for tests in jest.setup.js. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 4: Point `presets.ts` at it**

In `src/lib/presets.ts`, delete the `sha256Hex` function body and add to the imports:

```ts
import { sha256Hex } from "./hash";
```

Then re-export it, because other modules import it from here:

```ts
export { sha256Hex };
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, including the existing preset tests. If anything imported `sha256Hex` from `presets.ts`, the re-export keeps it working.

- [ ] **Step 6: Commit**

```bash
git add src/lib/hash.ts src/lib/hash.test.ts src/lib/presets.ts
git commit -m "refactor: extract sha256Hex so worker code can hash

presets.ts imports a React config provider, so a worker importing it for one
hash function would pull React into the worker bundle."
```

---

### Task 3: Atomic read-modify-write for documents

**Files:**
- Modify: `src/lib/storage/kv.ts`
- Test: `src/lib/storage/kv.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `updateDocument<T>(key: string, change: (current: T | undefined) => T): Promise<T>`. It reads, applies `change`, writes, all inside one IndexedDB transaction, and returns the written value.

Why: the cache index is a read-modify-write. `run()` puts one request per transaction, so a get-then-put via two calls can interleave with the Settings "Clear" action and lose an update.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/storage/kv.test.ts
import { getDocument, putDocument, updateDocument } from "./kv";

describe("updateDocument", () => {
  it("creates a document when none exists", async () => {
    const written = await updateDocument<number[]>("counter-a", (current) => [
      ...(current ?? []),
      1,
    ]);
    expect(written).toEqual([1]);
    expect(await getDocument<number[]>("counter-a")).toEqual([1]);
  });

  it("applies the change to the stored value", async () => {
    await putDocument("counter-b", [1, 2]);
    const written = await updateDocument<number[]>("counter-b", (current) => [
      ...(current ?? []),
      3,
    ]);
    expect(written).toEqual([1, 2, 3]);
  });

  it("does not lose concurrent updates", async () => {
    await putDocument("counter-c", []);
    await Promise.all(
      [1, 2, 3, 4, 5].map((value) =>
        updateDocument<number[]>("counter-c", (current) => [
          ...(current ?? []),
          value,
        ])
      )
    );
    const stored = await getDocument<number[]>("counter-c");
    expect(stored).toHaveLength(5);
  });
});
```

Note: `jest.config.js` uses jsdom, which has no IndexedDB. Add `fake-indexeddb` as a devDependency and import it at the top of this test file:

```bash
npm install --save-dev fake-indexeddb
```

```ts
import "fake-indexeddb/auto";
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/lib/storage/kv.test.ts`
Expected: FAIL, `updateDocument is not a function`.

- [ ] **Step 3: Implement it**

Add to `src/lib/storage/kv.ts`, below `deleteDocument`:

```ts
/**
 * Reads, changes and writes a document inside one transaction.
 *
 * `run()` issues a single request per transaction, so `getDocument` followed
 * by `putDocument` is two transactions with a window between them. The RAW
 * cache index is written by the worker on every conversion and cleared from
 * the settings page, and a lost update there means a leaked blob nothing will
 * ever evict.
 */
export function updateDocument<T>(
  key: string,
  change: (current: T | undefined) => T
): Promise<T> {
  return open().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(DOCUMENTS, "readwrite");
        const store = transaction.objectStore(DOCUMENTS);
        const read = store.get(key);
        let written: T;
        read.onsuccess = () => {
          written = change(read.result as T | undefined);
          store.put(written, key);
        };
        read.onerror = () =>
          reject(read.error ?? new Error(`${DOCUMENTS}: read failed`));
        // Resolved on the transaction, not the put: the write is only durable
        // once the transaction commits, and a quota abort can follow a
        // successful request.
        transaction.oncomplete = () => resolve(written);
        transaction.onabort = () =>
          reject(transaction.error ?? new Error(`${DOCUMENTS}: aborted`));
      })
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/lib/storage/kv.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/kv.ts src/lib/storage/kv.test.ts package.json package-lock.json
git commit -m "feat(storage): add updateDocument for atomic read-modify-write

The RAW cache index is written by the worker on every conversion and cleared
from the settings page. Two transactions leave a window where one loses the
other's update, and a lost index entry is a blob nothing will evict."
```

---

### Task 4: The cache types and core get/put

**Files:**
- Create: `src/lib/raw-cache.types.ts`, `src/lib/raw-cache.ts`, `src/lib/raw-cache.test.ts`

**Interfaces:**
- Consumes: `updateDocument`, `getDocument` (Task 3).
- Produces:
  - `interface BlobStore { read(key): Promise<Uint8Array | undefined>; write(key, bytes): Promise<void>; remove(key): Promise<void>; keys(): Promise<string[]> }`
  - `interface CacheEntry { size: number; lastUsed: number }`
  - `type CacheIndex = Record<string, CacheEntry>`
  - `createRawCache(options: RawCacheOptions): RawCache`
  - `interface RawCache { get(key): Promise<Uint8Array | undefined>; put(key, bytes): Promise<void>; usage(): Promise<number>; clear(): Promise<void> }`
  - `BUDGET_BYTES: number`

- [ ] **Step 1: Write the types**

```ts
// src/lib/raw-cache.types.ts
/**
 * The persistent RAW cache's storage seam.
 *
 * In its own module so `raw-worker.ts` and the settings page can name these
 * types without importing an implementation -- and so the OPFS implementation
 * is never pulled into a Jest run, where `navigator.storage` does not exist.
 */

/** Somewhere large binary blobs live, addressed by key. */
export interface BlobStore {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key present. Reconciliation only; not a hot path. */
  keys(): Promise<string[]>;
}

export interface CacheEntry {
  size: number;
  /** Epoch milliseconds. Eviction is least-recently-*used*, not oldest. */
  lastUsed: number;
}

/** key -> entry. About 30 entries at a 2 GB budget, so one document holds it. */
export type CacheIndex = Record<string, CacheEntry>;
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/raw-cache.test.ts
import "fake-indexeddb/auto";
import { BUDGET_BYTES, createRawCache } from "./raw-cache";
import type { BlobStore } from "./raw-cache.types";

function fakeStore(): BlobStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    keys: () => Promise.resolve(Array.from(blobs.keys())),
    read: (key) => Promise.resolve(blobs.get(key)),
    remove: (key) => {
      blobs.delete(key);
      return Promise.resolve();
    },
    write: (key, bytes) => {
      blobs.set(key, bytes);
      return Promise.resolve();
    },
  };
}

/** A distinct clock, so "least recently used" is decided rather than raced. */
function clock() {
  let time = 1000;
  return () => {
    time += 1000;
    return time;
  };
}

describe("the persistent RAW cache", () => {
  it("returns undefined for a key it has never seen", async () => {
    const cache = createRawCache({ now: clock(), store: fakeStore() });
    expect(await cache.get("absent")).toBeUndefined();
  });

  it("returns what was put", async () => {
    const cache = createRawCache({ now: clock(), store: fakeStore() });
    await cache.put("a", new Uint8Array([1, 2, 3]));
    expect(Array.from((await cache.get("a")) ?? [])).toEqual([1, 2, 3]);
  });

  it("reports usage as the sum of stored sizes", async () => {
    const cache = createRawCache({ now: clock(), store: fakeStore() });
    await cache.put("a", new Uint8Array(10));
    await cache.put("b", new Uint8Array(15));
    expect(await cache.usage()).toBe(25);
  });

  it("evicts least recently used first when over budget", async () => {
    const store = fakeStore();
    const cache = createRawCache({ budgetBytes: 30, now: clock(), store });

    await cache.put("old", new Uint8Array(10));
    await cache.put("mid", new Uint8Array(10));
    await cache.get("old"); // touches "old", making "mid" the oldest use
    await cache.put("new", new Uint8Array(15));

    expect(store.blobs.has("mid")).toBe(false);
    expect(store.blobs.has("old")).toBe(true);
    expect(store.blobs.has("new")).toBe(true);
  });

  it("never evicts the entry just added", async () => {
    const store = fakeStore();
    const cache = createRawCache({ budgetBytes: 20, now: clock(), store });
    await cache.put("a", new Uint8Array(20));
    await cache.put("b", new Uint8Array(20));
    expect(store.blobs.has("b")).toBe(true);
  });

  it("refuses a blob larger than the whole budget", async () => {
    const store = fakeStore();
    const cache = createRawCache({ budgetBytes: 10, now: clock(), store });
    await cache.put("huge", new Uint8Array(11));
    expect(store.blobs.has("huge")).toBe(false);
    expect(await cache.usage()).toBe(0);
  });

  it("clears every blob and resets usage", async () => {
    const store = fakeStore();
    const cache = createRawCache({ now: clock(), store });
    await cache.put("a", new Uint8Array(10));
    await cache.clear();
    expect(store.blobs.size).toBe(0);
    expect(await cache.usage()).toBe(0);
  });

  it("defaults to a 2 GB budget", () => {
    expect(BUDGET_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx jest src/lib/raw-cache.test.ts`
Expected: FAIL, `Cannot find module './raw-cache'`.

- [ ] **Step 4: Implement**

```ts
// src/lib/raw-cache.ts
/**
 * The persistent tier of the RAW-to-TIFF cache.
 *
 * Sits behind the session tier in `raw-preview.ts` and in front of conversion.
 * Content-addressed, so a file that moved is still a hit and a file that
 * changed is not -- which is a correctness requirement rather than a nicety in
 * the browser, where `registerSessionFile` mints `/session/<n>/<name>` from a
 * counter that restarts each session and therefore names different bytes with
 * the same string across visits.
 *
 * Storage is injected. OPFS is the intended backing (`raw-cache-opfs.ts`), but
 * this module never names it: the eviction and index logic is the part worth
 * testing, and `navigator.storage` does not exist under Jest.
 *
 * The index is a single document rather than a row per entry. At a 2 GB budget
 * and ~67 MB per converted frame that is about thirty entries, so one document
 * is small, updates atomically, and can be read straight from the page for the
 * settings read-out without involving the worker.
 */

import { getDocument, updateDocument } from "./storage/kv";
import type { BlobStore, CacheEntry, CacheIndex } from "./raw-cache.types";

const INDEX_KEY = "raw-cache-index";

/** See the design doc. Fixed rather than a share of the origin quota. */
export const BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export interface RawCacheOptions {
  store: BlobStore;
  budgetBytes?: number;
  /** Injected so eviction order is decided in tests rather than raced. */
  now?: () => number;
}

export interface RawCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  usage(): Promise<number>;
  clear(): Promise<void>;
}

export function createRawCache(options: RawCacheOptions): RawCache {
  const { store } = options;
  const budget = options.budgetBytes ?? BUDGET_BYTES;
  const now = options.now ?? (() => Date.now());

  async function readIndex(): Promise<CacheIndex> {
    return (await getDocument<CacheIndex>(INDEX_KEY)) ?? {};
  }

  async function get(key: string): Promise<Uint8Array | undefined> {
    const index = await readIndex();
    if (!index[key]) {
      return;
    }

    const bytes = await store.read(key).catch(() => undefined);
    if (!bytes) {
      // Phantom: the index remembers a blob the store no longer has, which is
      // what a browser reclaiming storage under quota pressure leaves behind.
      // Dropping the entry turns it into an ordinary miss.
      await updateIndex((current) => {
        delete current[key];
        return current;
      });
      return;
    }

    await updateIndex((current) => {
      const entry = current[key];
      if (entry) {
        entry.lastUsed = now();
      }
      return current;
    });
    return bytes;
  }

  async function put(key: string, bytes: Uint8Array): Promise<void> {
    // A blob bigger than the whole budget would evict everything and then
    // itself, so it is never stored at all.
    if (bytes.byteLength > budget) {
      return;
    }

    // Blob first, index second. An interrupted write then leaves an orphan,
    // which `sweep` reclaims, rather than a phantom the next reader must
    // discover.
    await store.write(key, bytes);

    const evicted: string[] = [];
    await updateIndex((current) => {
      current[key] = { lastUsed: now(), size: bytes.byteLength };
      let total = Object.values(current).reduce(
        (sum, entry) => sum + entry.size,
        0
      );
      const order = Object.entries(current)
        .filter(([candidate]) => candidate !== key)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
      for (const [candidate, entry] of order) {
        if (total <= budget) {
          break;
        }
        delete current[candidate];
        total -= entry.size;
        evicted.push(candidate);
      }
      return current;
    });

    // Outside the index update: a failed removal must not roll back an index
    // that is already correct. What it leaves is an orphan, which sweeps.
    await Promise.all(
      evicted.map((candidate) => store.remove(candidate).catch(() => undefined))
    );
  }

  async function usage(): Promise<number> {
    const index = await readIndex();
    return Object.values(index).reduce((sum, entry) => sum + entry.size, 0);
  }

  async function clear(): Promise<void> {
    const present = await store.keys().catch(() => [] as string[]);
    await Promise.all(
      present.map((key) => store.remove(key).catch(() => undefined))
    );
    await updateIndex(() => ({}));
  }

  return { clear, get, put, usage };
}

function updateIndex(
  change: (current: CacheIndex) => CacheIndex
): Promise<CacheIndex> {
  return updateDocument<CacheIndex>(INDEX_KEY, (current) =>
    change(current ?? {})
  );
}

export type { BlobStore, CacheEntry, CacheIndex };
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/lib/raw-cache.test.ts`
Expected: PASS, all eight.

- [ ] **Step 6: Commit**

```bash
git add src/lib/raw-cache.ts src/lib/raw-cache.types.ts src/lib/raw-cache.test.ts
git commit -m "feat(raw): add the persistent cache tier, storage injected

Content-addressed with an LRU bound. Storage is a seam rather than OPFS
directly: the eviction and index logic is the part worth testing, and
navigator.storage does not exist under Jest."
```

---

### Task 5: Reconciliation (orphan sweep)

Task 4 already self-heals phantoms. This adds the other half.

**Files:**
- Modify: `src/lib/raw-cache.ts`, `src/lib/raw-cache.test.ts`

**Interfaces:**
- Consumes: `createRawCache` (Task 4).
- Produces: `RawCache.sweep(): Promise<void>`, and `get`/`put` run it lazily once per cache instance.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/raw-cache.test.ts`:

```ts
describe("reconciliation", () => {
  it("reports a miss and forgets the entry when the blob has vanished", async () => {
    const store = fakeStore();
    const cache = createRawCache({ now: clock(), store });
    await cache.put("a", new Uint8Array(10));

    store.blobs.delete("a"); // as a browser reclaiming storage would

    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.usage()).toBe(0);
  });

  it("deletes blobs the index does not know about", async () => {
    const store = fakeStore();
    store.blobs.set("orphan", new Uint8Array(10)); // a crashed write

    const cache = createRawCache({ now: clock(), store });
    await cache.sweep();

    expect(store.blobs.has("orphan")).toBe(false);
  });

  it("sweeps once, not on every call", async () => {
    const store = fakeStore();
    let listed = 0;
    const counting = {
      ...store,
      keys: () => {
        listed += 1;
        return store.keys();
      },
    };
    const cache = createRawCache({ now: clock(), store: counting });

    await cache.get("a");
    await cache.get("b");
    await cache.put("c", new Uint8Array(1));

    expect(listed).toBe(1);
  });

  it("keeps blobs the index does know about", async () => {
    const store = fakeStore();
    const cache = createRawCache({ now: clock(), store });
    await cache.put("kept", new Uint8Array(10));

    await cache.sweep();

    expect(store.blobs.has("kept")).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/lib/raw-cache.test.ts -t reconciliation`
Expected: FAIL, `cache.sweep is not a function`.

- [ ] **Step 3: Implement**

In `src/lib/raw-cache.ts`, add `sweep` to the interface:

```ts
export interface RawCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  usage(): Promise<number>;
  clear(): Promise<void>;
  /** Deletes blobs the index does not know about. Runs once per instance. */
  sweep(): Promise<void>;
}
```

Inside `createRawCache`, add:

```ts
  /**
   * Blobs with no index entry, deleted.
   *
   * A write that landed but whose index update did not is invisible to
   * eviction, so it would consume disk for the life of the origin. About
   * thirty keys at this budget, so listing them is cheap.
   */
  async function sweep(): Promise<void> {
    const index = await readIndex();
    const present = await store.keys().catch(() => [] as string[]);
    await Promise.all(
      present
        .filter((key) => !index[key])
        .map((key) => store.remove(key).catch(() => undefined))
    );
  }

  /** Once per instance: a sweep on every lookup would list the store per frame. */
  let swept: Promise<void> | undefined;
  function sweepOnce(): Promise<void> {
    swept ??= sweep().catch(() => undefined);
    return swept;
  }
```

Then make `get` and `put` await it as their first line:

```ts
  async function get(key: string): Promise<Uint8Array | undefined> {
    await sweepOnce();
    const index = await readIndex();
    // ...unchanged from here
```

```ts
  async function put(key: string, bytes: Uint8Array): Promise<void> {
    await sweepOnce();
    if (bytes.byteLength > budget) {
      return;
    }
    // ...unchanged from here
```

And return it: `return { clear, get, put, sweep, usage };`

- [ ] **Step 4: Run the tests**

Run: `npx jest src/lib/raw-cache.test.ts`
Expected: PASS, all twelve.

- [ ] **Step 5: Commit**

```bash
git add src/lib/raw-cache.ts src/lib/raw-cache.test.ts
git commit -m "feat(raw): reconcile the cache index against the blob store

Two stores can disagree. A phantom index entry self-heals into a miss on read;
an orphaned blob is invisible to eviction and would consume disk forever, so it
is swept once per session."
```

---

### Task 6: The cache key, including tool identity

**Files:**
- Create: `src/lib/raw-cache-key.ts`, `src/lib/raw-cache-key.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` (Task 2), `dcrawArgs` from `./pipeline/stages`.
- Produces:
  - `toolTag(wasmBaseUrl: string): Promise<string>`: 12 hex chars, memoised per URL.
  - `rawCacheKey(bytes: Uint8Array, tag: string): Promise<string>`: `"<64 hex>-<12 hex>"`.
  - `resetToolTagForTests(): void`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/raw-cache-key.test.ts
import { rawCacheKey, resetToolTagForTests, toolTag } from "./raw-cache-key";

const VERSIONS = {
  emscripten: "6.0.4",
  tools: { dcraw_emu: { commit: "c9d6743", describe: "", repository: "", version: "" } },
};

function mockFetch(body: unknown) {
  globalThis.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve(body), ok: true })
  ) as unknown as typeof fetch;
}

describe("the RAW cache key", () => {
  beforeEach(() => {
    resetToolTagForTests();
  });

  it("joins a content hash and a tool tag", async () => {
    const key = await rawCacheKey(new Uint8Array([1, 2, 3]), "abc123def456");
    expect(key).toMatch(/^[0-9a-f]{64}-abc123def456$/);
  });

  it("gives different keys to different bytes", async () => {
    expect(await rawCacheKey(new Uint8Array([1]), "t")).not.toBe(
      await rawCacheKey(new Uint8Array([2]), "t")
    );
  });

  it("derives a twelve-character tag from the recorded commit", async () => {
    mockFetch(VERSIONS);
    const tag = await toolTag("https://example.test/wasm");
    expect(tag).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes the tag when the dcraw_emu commit changes", async () => {
    mockFetch(VERSIONS);
    const before = await toolTag("https://example.test/wasm");

    resetToolTagForTests();
    mockFetch({ ...VERSIONS, tools: { dcraw_emu: { ...VERSIONS.tools.dcraw_emu, commit: "deadbee" } } });
    const after = await toolTag("https://example.test/wasm");

    expect(after).not.toBe(before);
  });

  it("fetches versions.json from the absolute base it is given", async () => {
    mockFetch(VERSIONS);
    await toolTag("https://example.test/wasm");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.test/wasm/versions.json"
    );
  });

  it("asks once per base URL", async () => {
    mockFetch(VERSIONS);
    await toolTag("https://example.test/wasm");
    await toolTag("https://example.test/wasm");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/lib/raw-cache-key.test.ts`
Expected: FAIL, `Cannot find module './raw-cache-key'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/raw-cache-key.ts
/**
 * What names a cached conversion.
 *
 * Two parts, and the second is the one that is easy to leave out:
 *
 *  - **The content hash.** Not the path. `registerSessionFile` mints
 *    `/session/<n>/<name>` from a counter that restarts each session, so the
 *    same path names different bytes across visits and a path-keyed cache
 *    would serve the wrong image.
 *  - **A tool tag**, derived from the `dcraw_emu` commit the wasm was built
 *    from and the flags it is run with. Without it, rebuilding the artifacts
 *    (#244 automates exactly that) would serve pixels produced by a different
 *    demosaic while reporting success -- undoing the byte-identical guarantee
 *    `raw-preview.ts` exists to hold.
 *
 * Folded into the key rather than checked on read, so a tool change simply
 * misses, stale entries age out by LRU, and a rollback re-hits its own entries
 * instead of having discarded them.
 */

import { sha256Hex } from "./hash";
import { dcrawArgs } from "./pipeline/stages";

interface VersionsDocument {
  tools?: Record<string, { commit?: string } | undefined>;
}

/** Memoised per base URL: the file describes committed artifacts. */
const tags = new Map<string, Promise<string>>();

/**
 * Identity of the converter, as twelve hex characters.
 *
 * `build-versions.ts` is not reused here because it hardcodes a relative
 * `/wasm`, and in a worker a relative URL resolves against the worker's own
 * chunk rather than the document. The absolute base is passed in instead.
 */
export function toolTag(wasmBaseUrl: string): Promise<string> {
  const cached = tags.get(wasmBaseUrl);
  if (cached) {
    return cached;
  }
  const deriving = derive(wasmBaseUrl).catch((error: unknown) => {
    // Not remembered, so a transient fetch failure does not pin an
    // "unknown" tag for the life of the worker.
    tags.delete(wasmBaseUrl);
    throw error;
  });
  tags.set(wasmBaseUrl, deriving);
  return deriving;
}

async function derive(wasmBaseUrl: string): Promise<string> {
  const response = await fetch(`${wasmBaseUrl}/versions.json`);
  if (!response.ok) {
    throw new Error(
      `${wasmBaseUrl}/versions.json returned ${response.status}`
    );
  }
  const versions = (await response.json()) as VersionsDocument;
  const commit = versions.tools?.dcraw_emu?.commit ?? "unknown";
  // Placeholder paths, so the tag tracks the flags and does not vary per frame.
  const args = dcrawArgs("in", "out").join(" ");
  const digest = await sha256Hex(
    new TextEncoder().encode(`${commit} ${args}`)
  );
  return digest.slice(0, 12);
}

/** `<content hash>-<tool tag>`. */
export async function rawCacheKey(
  bytes: Uint8Array,
  tag: string
): Promise<string> {
  return `${await sha256Hex(bytes)}-${tag}`;
}

export function resetToolTagForTests(): void {
  tags.clear();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/lib/raw-cache-key.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add src/lib/raw-cache-key.ts src/lib/raw-cache-key.test.ts
git commit -m "feat(raw): derive the cache key from content and tool identity

The content hash is required for correctness in a browser, where session paths
restart from a counter and name different bytes across visits. The tool tag
stops a rebuilt dcraw_emu from silently serving the previous demosaic."
```

---

### Task 7: The blob store, IndexedDB (approach B, decided by Task 1)

**Task 1 decided this.** The probe found `navigator.storage.getDirectory` **absent** in both WebKit (Playwright, CI) and WebKitGTK 605.1.15 (Tauri's Linux webview): `opfsAvailable: false`, `quota: null`. That is not a quota or memory failure; the API does not exist. OPFS worked in Chromium and WebView2. By the rule stated in advance ("OPFS fails or corrupts on **any** engine -> approach B"), two of five engines have no OPFS at all, so approach A is dead. Approach C (OPFS with an IndexedDB fallback) stays rejected: #243 warns that a second caching implementation is the thing that drifts.

IndexedDB round-tripped 67 MB on every engine tested, including both WebKits.

**Files:**
- Create: `src/lib/raw-cache-idb.ts`, `src/lib/raw-cache-idb.test.ts`
- Modify: `src/lib/storage/kv.ts` (a third object store)

**Interfaces:**
- Consumes: `BlobStore` (Task 4).
- Produces: `idbBlobStore(): BlobStore`, `blobStoreAvailable(): boolean`.

**On what the unit test is for.** It proves our *use* of the API: that a written blob reads back identical, that a missing key is `undefined` rather than a throw, and that `keys()` and `remove()` behave. `fake-indexeddb` is already wired (Task 3), so this is testable in Jest directly, unlike OPFS, which was the original reason this task was going to go untested.

- [ ] **Step 1: Add the object store**

In `src/lib/storage/kv.ts`, add beside `DOCUMENTS` and `FILES`:

```ts
/** Converted RAW frames, by content-addressed key. See `raw-cache.ts`. */
const BLOBS = "blobs";
```

Bump the version and create it. The existing `onupgradeneeded` already guards each store with `contains`, so the same handler serves a fresh database and an upgrade from version 1:

```ts
const DATABASE_VERSION = 2;
```

```ts
      if (!database.objectStoreNames.contains(BLOBS)) {
        database.createObjectStore(BLOBS);
      }
```

Then export the three operations the seam needs:

```ts
/**
 * Reads a cached blob.
 *
 * Separate from `getFile` despite the identical shape, because these live in
 * their own store: the RAW cache evicts on a budget and is cleared wholesale
 * from the settings page, and neither may touch a preset's calibration files.
 */
export async function getBlob(key: string): Promise<Uint8Array | undefined> {
  const stored = await run<ArrayBuffer | undefined>(BLOBS, "readonly", (store) =>
    store.get(key)
  );
  return stored ? new Uint8Array(stored) : undefined;
}

export function putBlob(key: string, bytes: Uint8Array): Promise<unknown> {
  // Stored as ArrayBuffer for the reason `putFile` gives: a view carries its
  // offset and length, so a subarray of a larger buffer would be cloned whole.
  return run(BLOBS, "readwrite", (store) =>
    store.put(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
      key
    )
  );
}

export function deleteBlob(key: string): Promise<unknown> {
  return run(BLOBS, "readwrite", (store) => store.delete(key));
}

export async function blobKeys(): Promise<string[]> {
  const keys = await run<IDBValidKey[]>(BLOBS, "readonly", (store) =>
    store.getAllKeys()
  );
  return keys.filter((key): key is string => typeof key === "string");
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/raw-cache-idb.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "@jest/globals";
import { idbBlobStore } from "./raw-cache-idb";

describe("the IndexedDB blob store", () => {
  beforeEach(async () => {
    const store = idbBlobStore();
    for (const key of await store.keys()) {
      await store.remove(key);
    }
  });

  it("round-trips bytes through write and read", async () => {
    const store = idbBlobStore();
    await store.write("a", new Uint8Array([1, 2, 3]));
    expect(Array.from((await store.read("a")) ?? [])).toEqual([1, 2, 3]);
  });

  it("returns undefined for a key that was never written", async () => {
    expect(await idbBlobStore().read("absent")).toBeUndefined();
  });

  it("overwrites an existing key rather than appending", async () => {
    const store = idbBlobStore();
    await store.write("a", new Uint8Array([1, 2, 3]));
    await store.write("a", new Uint8Array([9]));
    expect(Array.from((await store.read("a")) ?? [])).toEqual([9]);
  });

  it("lists and removes keys", async () => {
    const store = idbBlobStore();
    await store.write("a", new Uint8Array([1]));
    await store.write("b", new Uint8Array([2]));
    expect((await store.keys()).toSorted()).toEqual(["a", "b"]);

    await store.remove("a");
    expect(await store.keys()).toEqual(["b"]);
  });

  it("swallows a removal of something absent", async () => {
    await expect(idbBlobStore().remove("absent")).resolves.toBeUndefined();
  });

  it("stores a view of a larger buffer without dragging the whole buffer in", async () => {
    // The defect `putFile` documents: a subarray carries its parent's buffer,
    // so storing the view rather than a slice would persist far more than was
    // asked for -- and read back the wrong bytes.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await idbBlobStore().write("view", backing.subarray(2, 5));
    expect(Array.from((await idbBlobStore().read("view")) ?? [])).toEqual([
      3, 4, 5,
    ]);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx jest src/lib/raw-cache-idb.test.ts`
Expected: FAIL, `Cannot find module './raw-cache-idb'`.

- [ ] **Step 4: Implement**

```ts
// src/lib/raw-cache-idb.ts
/**
 * IndexedDB backing for the persistent RAW cache.
 *
 * IndexedDB rather than OPFS, and that was measured rather than assumed.
 * #243 specified OPFS for its `createSyncAccessHandle` fast path; the probe in
 * `e2e-web/tests/storage-probe.spec.ts` found `navigator.storage.getDirectory`
 * **absent** in WebKit and in WebKitGTK 605.1.15, the webview Tauri uses on
 * Linux -- not slow, not quota-limited, simply not implemented. An OPFS cache
 * would have silently never worked for Safari users or Linux desktop users.
 * IndexedDB round-tripped a 67 MB blob on every engine tested.
 *
 * The cost is a structured clone on each read and write, against roughly 2 s
 * of demosaic per frame that it avoids. `perf.bench.ts` measures the result
 * rather than assuming it.
 *
 * A second consequence worth knowing: blobs and index now live in the same
 * database, so the reconciliation in `raw-cache.ts` guards a narrower window
 * than it was designed for. It is kept because the two are still written in
 * separate transactions, so a crash between them remains possible.
 */

import type { BlobStore } from "./raw-cache.types";
import { blobKeys, deleteBlob, getBlob, putBlob } from "./storage/kv";

/**
 * Whether this host can back the cache at all.
 *
 * Always true where the app runs -- IndexedDB is what presets, settings and
 * run history already depend on -- but the caller reads better for asking,
 * and a host without it degrades to converting every time rather than
 * throwing.
 */
export function blobStoreAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export function idbBlobStore(): BlobStore {
  return {
    keys: () => blobKeys(),
    read: (key) => getBlob(key),
    remove: async (key) => {
      await deleteBlob(key);
    },
    write: async (key, bytes) => {
      await putBlob(key, bytes);
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/lib/raw-cache-idb.test.ts && npm test && npx tsc --noEmit && npm run check`
Expected: PASS, six new tests, no regressions, no type or lint errors.

**Check the version bump did not break existing data.** `src/lib/storage/migrate-tauri-files.ts` and the preset tests exercise the same database; confirm they still pass, since a botched `onupgradeneeded` would lose a user's presets rather than fail loudly.

- [ ] **Step 6: Commit**

```bash
git add src/lib/raw-cache-idb.ts src/lib/raw-cache-idb.test.ts src/lib/storage/kv.ts
git commit -m "feat(raw): back the persistent cache with IndexedDB

#243 specified OPFS. The probe found navigator.storage.getDirectory absent in
WebKit and in WebKitGTK 605.1.15, the webview Tauri uses on Linux -- not slow,
not quota-limited, absent. An OPFS cache would have silently never worked for
Safari or Linux desktop users. IndexedDB round-tripped 67 MB everywhere."
```

---

### Task 8: Wire the cache into the RAW worker

**Files:**
- Modify: `src/lib/raw-worker.ts`
- Test: `src/lib/raw-worker.test.ts` (create)

**Interfaces:**
- Consumes: `createRawCache` (Task 4), `rawCacheKey`/`toolTag` (Task 6), `idbBlobStore`/`blobStoreAvailable` (Task 7).
- Produces: no new exports. Behaviour: identical bytes convert once across reloads.

- [ ] **Step 1: Write the failing test**

Extract the cache decision into a testable function rather than testing the worker's message plumbing, which needs a real `Worker`.

```ts
// src/lib/raw-worker.test.ts
import { convertWithCache } from "./raw-worker";
import type { RawCache } from "./raw-cache";

function fakeCache(seed: Record<string, Uint8Array> = {}) {
  const blobs = new Map(Object.entries(seed));
  const cache: RawCache & { blobs: Map<string, Uint8Array> } = {
    blobs,
    clear: () => Promise.resolve(),
    get: (key) => Promise.resolve(blobs.get(key)),
    put: (key, bytes) => {
      blobs.set(key, bytes);
      return Promise.resolve();
    },
    sweep: () => Promise.resolve(),
    usage: () => Promise.resolve(0),
  };
  return cache;
}

describe("converting with the persistent cache", () => {
  it("returns the cached TIFF without converting", async () => {
    const cache = fakeCache({ "key-1": new Uint8Array([9, 9]) });
    let converted = 0;

    const tiff = await convertWithCache({
      cache,
      convert: () => {
        converted += 1;
        return Promise.resolve(new Uint8Array([1]));
      },
      key: () => Promise.resolve("key-1"),
    });

    expect(Array.from(tiff)).toEqual([9, 9]);
    expect(converted).toBe(0);
  });

  it("converts and stores on a miss", async () => {
    const cache = fakeCache();
    const tiff = await convertWithCache({
      cache,
      convert: () => Promise.resolve(new Uint8Array([4, 5])),
      key: () => Promise.resolve("key-2"),
    });

    expect(Array.from(tiff)).toEqual([4, 5]);
    expect(Array.from(cache.blobs.get("key-2") ?? [])).toEqual([4, 5]);
  });

  it("still converts when the key cannot be derived", async () => {
    const cache = fakeCache();
    const tiff = await convertWithCache({
      cache,
      convert: () => Promise.resolve(new Uint8Array([7])),
      key: () => Promise.reject(new Error("versions.json unreachable")),
    });
    expect(Array.from(tiff)).toEqual([7]);
  });

  it("still returns the TIFF when the cache write fails", async () => {
    const cache = fakeCache();
    cache.put = () => Promise.reject(new Error("quota exceeded"));

    const tiff = await convertWithCache({
      cache,
      convert: () => Promise.resolve(new Uint8Array([8])),
      key: () => Promise.resolve("key-3"),
    });
    expect(Array.from(tiff)).toEqual([8]);
  });

  it("still returns the TIFF when the cache read fails", async () => {
    const cache = fakeCache();
    cache.get = () => Promise.reject(new Error("storage unavailable"));

    const tiff = await convertWithCache({
      cache,
      convert: () => Promise.resolve(new Uint8Array([6])),
      key: () => Promise.resolve("key-4"),
    });
    expect(Array.from(tiff)).toEqual([6]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/lib/raw-worker.test.ts`
Expected: FAIL, `convertWithCache is not a function`.

- [ ] **Step 3: Implement**

In `src/lib/raw-worker.ts`, add the imports:

```ts
import { createRawCache, type RawCache } from "./raw-cache";
import { rawCacheKey, toolTag } from "./raw-cache-key";
import { blobStoreAvailable, idbBlobStore } from "./raw-cache-idb";
```

Add the cache accessor beside `runnerFor`:

```ts
let cache: RawCache | undefined;

/**
 * The persistent tier, or nothing on a host without IndexedDB.
 *
 * Absence is not an error: the conversion path is unchanged and only slower,
 * which is exactly what every host did before this existed.
 */
function cacheFor(): RawCache | undefined {
  if (!blobStoreAvailable()) {
    return;
  }
  cache ??= createRawCache({ store: idbBlobStore() });
  return cache;
}
```

Add the testable decision function:

```ts
export interface CachedConversion {
  cache: RawCache | undefined;
  convert: () => Promise<Uint8Array>;
  key: () => Promise<string>;
}

/**
 * A conversion, answered from the cache where possible.
 *
 * Exported for tests: the worker's own message plumbing needs a real `Worker`,
 * whereas this is the part with the decisions in it.
 *
 * Every cache failure falls through to conversion. The cache may never be the
 * reason a frame fails to convert -- a read error is a miss, and a write error
 * is a slower next session rather than a lost image.
 */
export async function convertWithCache({
  cache: tier,
  convert,
  key,
}: CachedConversion): Promise<Uint8Array> {
  let resolved: string | undefined;
  if (tier) {
    try {
      resolved = await key();
      const hit = await tier.get(resolved);
      if (hit) {
        return hit;
      }
    } catch {
      // Unusable cache: convert, exactly as a host without one does.
      resolved = undefined;
    }
  }

  const tiff = await convert();

  if (tier && resolved) {
    // Before the caller transfers it. `postMessage` with a transfer detaches
    // the buffer, and writing afterwards would persist a zero-byte file that
    // later reads as a corrupt hit -- the failure fixed in 93ba5fc.
    await tier.put(resolved, tiff).catch(() => undefined);
  }

  return tiff;
}
```

Replace the body of `convert`:

```ts
async function convert(request: RawConvertRequest): Promise<Uint8Array> {
  const active = runnerFor(request.wasmBaseUrl);
  try {
    return await convertWithCache({
      cache: cacheFor(),
      convert: () => convertRaw(active, request.path, request.bytes),
      key: async () =>
        rawCacheKey(request.bytes, await toolTag(request.wasmBaseUrl)),
    });
  } finally {
    // Between frames rather than at the end: the runner survives to keep its
    // compiled modules, so its staged bytes must not survive with it.
    active.clear();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/lib/raw-worker.test.ts && npm test`
Expected: PASS. The existing `raw-worker-client.test.ts` and `raw-convert.test.ts` must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/raw-worker.ts src/lib/raw-worker.test.ts
git commit -m "feat(raw): answer conversions from the persistent cache

The cache is consulted before converting and populated after, always before
the caller transfers the buffer: postMessage detaches it, and a write after
that persists a zero-byte file. Every cache failure falls through to
conversion, so the cache can never be why a frame fails."
```

---

### Task 9: Report and clear the cache from Settings

**Files:**
- Modify: `src/app/settings-page/page.tsx`

**Interfaces:**
- Consumes: `createRawCache`, `BUDGET_BYTES` (Task 4), `blobStoreAvailable`/`idbBlobStore` (Task 7).
- Produces: no exports.

- [ ] **Step 1: Add the state and loader**

In `src/app/settings-page/page.tsx`, add imports:

```ts
import prettyBytes from "pretty-bytes";
import { BUDGET_BYTES, createRawCache } from "@/lib/raw-cache";
import { blobStoreAvailable, idbBlobStore } from "@/lib/raw-cache-idb";
```

Inside `SettingsPage`, beside the other `useState` calls:

```ts
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
```

In the existing mount `useEffect`, after the `wasmVersions()` block:

```ts
    // Absent on a host without IndexedDB, where there is no persistent tier to
    // report. Zero would claim an empty cache rather than no cache.
    if (blobStoreAvailable()) {
      createRawCache({ store: idbBlobStore() })
        .usage()
        .then(setCacheBytes)
        .catch(() => setCacheBytes(null));
    }
```

- [ ] **Step 2: Add the handler**

Beside `handleUpdatePath`:

```ts
  /** Empties the persistent RAW cache and re-reads its size. */
  const handleClearCache = async () => {
    const cache = createRawCache({ store: idbBlobStore() });
    try {
      await cache.clear();
      setCacheBytes(await cache.usage());
      toast.success("RAW conversion cache cleared");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not clear the cache"
      );
    }
  };
```

- [ ] **Step 3: Render the row**

Add beside the tool-versions block, following the markup already used there:

```tsx
        {cacheBytes !== null && (
          <div className="flex items-center justify-between gap-4 py-2">
            <div>
              <p className="font-medium text-sm">RAW conversion cache</p>
              <p className="text-muted-foreground text-xs">
                {prettyBytes(cacheBytes)} of {prettyBytes(BUDGET_BYTES)} used.
                Converted frames are reused instead of demosaiced again.
              </p>
            </div>
            <button
              className="rounded-md border px-3 py-1.5 text-sm"
              disabled={cacheBytes === 0}
              onClick={handleClearCache}
              type="button"
            >
              Clear
            </button>
          </div>
        )}
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run check && npm run build
```

Expected: no errors. Then `npm run dev`, open Settings, and confirm the row shows `0 B of 2.15 GB used` with Clear disabled.

- [ ] **Step 5: Commit**

```bash
git add src/app/settings-page/page.tsx
git commit -m "feat(settings): show and clear the RAW conversion cache

A 2 GB cache that a user cannot see or reclaim short of clearing site data is
not an honest default. Hidden entirely where there is no IndexedDB, since zero
would claim an empty cache rather than no cache."
```

---

### Task 10: Prove a reload reuses the conversions

**Files:**
- Modify: `e2e-web/tests/perf.bench.ts`

**Interfaces:**
- Consumes: the whole feature.
- Produces: a `secondImportMs` figure in the benchmark report.

- [ ] **Step 1: Add the reload pass**

In `e2e-web/tests/perf.bench.ts`, in the `MODE === "cr2"` branch, after `runMs` is measured:

```ts
    // The point of #243, measured rather than asserted: reload, re-import the
    // same frames, and the conversion should not happen again. Same files, so
    // the content hash matches; a new tab, so the session tier is empty and
    // only the persistent tier can produce the saving.
    await page.reload({ waitUntil: "load" });
    const secondStart = Date.now();
    await loadCr2Frames(page, FRAMES);
    await expect(
      page.locator(
        '[data-testid="image-set-preview"] .generic-image-container canvas'
      )
    ).toHaveCount(FRAMES, { timeout: RUN_TIMEOUT });
    secondImportMs = Date.now() - secondStart;
```

Declare `let secondImportMs: number | undefined;` beside `runMs`, and add `secondImportMs` to the `report` object.

- [ ] **Step 2: Measure before the feature is on**

Stash the worker wiring to get a baseline:

```bash
git stash push src/lib/raw-worker.ts
npm run build
MODE=cr2 FRAMES=3 npm --prefix e2e-web run bench
git stash pop
```

Expected: `secondImportMs` within noise of `runMs`, about 6000 ms for 3 frames, because nothing is cached.

- [ ] **Step 3: Measure with it on**

```bash
npm run build
MODE=cr2 FRAMES=3 npm --prefix e2e-web run bench
```

Expected: `secondImportMs` falls to a small fraction of `runMs`; the demosaic is skipped and only the IndexedDB read and TIFF decode remain. `requests.wasm` should stay at 2; a rise would mean the worker is being rebuilt.

- [ ] **Step 4: Record the numbers**

Add a "Measured result" section to the design doc with `runMs`, `secondImportMs` and the ratio, for 3 frames and for 10.

- [ ] **Step 5: Commit**

```bash
git add e2e-web/tests/perf.bench.ts docs/superpowers/specs/2026-07-31-opfs-raw-cache-design.md
git commit -m "test(perf): measure that a reload reuses converted frames

#243's acceptance criterion as a number rather than a claim: same frames, new
tab, empty session tier, so any saving is the persistent tier's."
```

---

## Self-Review

**Spec coverage.** Three tiers → Tasks 4/8. Worker-only constraint → Task 8. Content-hash key → Task 6. Tool tag → Task 6. Probe and its three questions → Task 1. `BlobStore` seam → Task 4. Single-document index → Task 4. Write-before-transfer → Task 8. 2 GB LRU and the oversize guard → Task 4. Phantom and orphan → Task 5. `updateDocument` → Task 3. Asymmetric error handling → Task 8. Settings → Task 9. Four test layers → Tasks 1, 4/5/6/8, 8, 10. No gaps.

**Placeholders.** None. Every code step carries the code; the only deferred decision is Task 7's backend, which is explicitly Task 1's output and has stated rules for resolving it.

**Type consistency.** `BlobStore` is `read`/`write`/`remove`/`keys` throughout. `RawCache` gains `sweep` in Task 5 and the Task 8 fake implements all five members. `rawCacheKey(bytes, tag)` and `toolTag(wasmBaseUrl)` match between Tasks 6 and 8. `createRawCache({ store, budgetBytes?, now? })` matches across Tasks 4, 5, 8 and 9.

**One deviation, deliberate:** Task 7 uses `createWritable` rather than the `createSyncAccessHandle` named in the issue. The sync handle is what forces this tier into a worker, and that constraint still holds and still shapes the architecture, but holding an exclusive lock across an await is a deadlock, and conversions are already serialised so the throughput difference never reaches the user. Flagged for the reviewer to overturn if Task 1 shows `createWritable` is the slow path on some host.
