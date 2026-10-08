# Drop RAW Conversions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A RAW frame the user has removed, and which has not yet reached the conversion worker, is never converted, so frames the user does want stop waiting behind it.

**Architecture:** `raw-preview.ts` owns the session cache and gives each entry an `AbortController`. `raw-worker-client.ts` owns the serial queue and checks that signal once, at the front of the queue, immediately before `postMessage`. A frame already sent is left alone. The UI calls a single `dropRawConversions(paths)` and never learns a worker exists.

**Tech Stack:** TypeScript, React 19, Jest (via `next/jest`, SWC transform), Biome through `ultracite`.

**Spec:** `docs/superpowers/specs/2026-08-01-raw-conversion-cancellation-design.md`

## Global Constraints

- **Read the spec first.** It records why two of the three candidate designs were rejected, and re-proposing them wastes a review cycle.
- **TDD, strictly.** Write the test, run it, watch it fail *for the stated reason*, then implement. A test that passes on first run is testing something that already worked; fix the test.
- **Prose uses `--`, not an em dash.** Every comment in `src/lib/raw-*.ts` follows this. Match it.
- **Comments explain why, not what.** This codebase's comments carry reasoning and consequences (see `raw-worker-client.ts:17-28`). Match that density; do not add narration.
- **Run `npx jest <path>` for a single suite** and `npx jest` for the whole suite before any commit. The baseline on this branch before Task 1 is **57 suites / 384 tests**; each task should add tests and regress none. Do not derive the suite count from `--listTests`, which picks up shell-completion noise on this machine.
- **Run `npx ultracite check <files>` and `npx tsc --noEmit` before every commit.** Jest uses SWC and strips types without checking them, so a type error will not fail a test run.
- **Conventional commits**, with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.
- **Branch:** work on `fix/raw-conversion-drop`, cut from `origin/main`.
- Do not touch `raw-cache.ts`, `raw-cache-idb.ts`, or `raw-worker.ts`. #243's page/worker boundary is out of scope.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/raw-worker-client.ts` | The single worker and its serial queue | Accept `RawConvertOptions`; check `signal` and fire `onStart` at the front of the queue |
| `src/lib/raw-worker-client.test.ts` | Pins the serial invariant against a `FakeWorker` | Add three cases |
| `src/lib/raw-preview.ts` | Session cache: dedup, fingerprint, LRU, accounting | Add `controller` and an `EntryFlags` (`started`/`done`) to `Entry`; add `dropRawConversions`; make `forget` identity-aware; fix `held` accounting |
| `src/lib/raw-preview.test.ts` | Pins the sharing guarantees | Add a deferred IO helper and four cases |
| `src/components/ui/image-matrix-input.tsx` | Renders image sets and owns the form value | Fix the sorted/unsorted index bug; call `dropRawConversions` on both removal paths |

Task 1 produces the type Task 2 consumes; Task 2 produces the function Task 3 calls. Each ends green and committable on its own.

---

## Task 1: Skip queued frames in the worker client

**Files:**
- Modify: `src/lib/raw-worker-client.ts:63-81`
- Test: `src/lib/raw-worker-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface RawConvertOptions {
    onStart?: () => void;
    signal?: AbortSignal;
  }

  export function convertRawInWorker(
    path: string,
    bytes: Uint8Array,
    wasmBaseUrl: string,
    options?: RawConvertOptions
  ): Promise<Uint8Array>;
  ```
  The type lives in `raw-worker-client.ts`, not `raw-worker.types.ts`: that file is for messages that cross `postMessage`, and neither a signal nor a callback can be structured-cloned.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/raw-worker-client.test.ts`, inside the existing `describe("driving the RAW worker")` block. Import `type RawConvertOptions` is not needed; the options object is inferred.

```ts
  it("never sends a queued frame whose signal was aborted", async () => {
    install();
    const controller = new AbortController();

    const first = convertRawInWorker("/in/a.CR2", new Uint8Array([1]), "/wasm");
    const dropped = convertRawInWorker(
      "/in/b.CR2",
      new Uint8Array([2]),
      "/wasm",
      { signal: controller.signal }
    );
    const third = convertRawInWorker("/in/c.CR2", new Uint8Array([3]), "/wasm");
    await settle();

    // Only `first` has been sent; the other two are still chained behind it.
    expect(built[0]?.posts).toBe(1);

    controller.abort();
    pending[0]?.respond(new Uint8Array([9]));
    await first;
    await settle();
    pending[1]?.respond(new Uint8Array([7]));
    await settle();

    // Two frames reached the worker, not three: `b` was skipped, so the
    // second `postMessage` was `c`. Asserted on the count the worker actually
    // saw rather than on a flag, so a frame that is merely *marked* dropped
    // still fails here.
    expect(built[0]?.posts).toBe(2);
    await expect(dropped).rejects.toThrow(/abort/i);
    await expect(third).resolves.toEqual(new Uint8Array([7]));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/lib/raw-worker-client.test.ts -t "never sends a queued frame"`

Expected: FAIL at `expect(built[0]?.posts).toBe(2)` with **"Expected: 2, Received: 3"**. Today the fourth argument is ignored, so `b` is sent, `pending[1]` is `b`'s response, and `c` is then sent as a third frame.

If instead it fails with a timeout, the assertion order was changed: the count assertion must come before the two `await expect(...)` lines, because a promise that can never settle times out rather than failing usefully.

- [ ] **Step 3: Write the minimal implementation**

In `src/lib/raw-worker-client.ts`, add the exported type above `convertRawInWorker`:

```ts
/**
 * What a caller may say about a conversion beyond its inputs.
 *
 * Not in `raw-worker.types.ts` with the message shapes: neither a signal nor
 * a callback survives `postMessage`, so these never cross into the worker.
 * They govern whether the frame is sent at all, which is a decision this side
 * makes.
 */
export interface RawConvertOptions {
  /**
   * Called once the frame is past the point of being skipped.
   *
   * `raw-preview.ts` cannot work this out for itself -- only the queue knows
   * when a frame leaves it -- and it needs to, because dropping a frame that
   * has already been sent must forget nothing.
   */
  onStart?: () => void;
  /** Checked once, at the front of the queue. Aborting later does nothing. */
  signal?: AbortSignal;
}
```

Then change `convertRawInWorker`:

```ts
export function convertRawInWorker(
  path: string,
  bytes: Uint8Array,
  wasmBaseUrl: string,
  options?: RawConvertOptions
): Promise<Uint8Array> {
  const conversion = queue.then(() => {
    // Checked here rather than when the call was made, which is the whole
    // point: the work worth skipping is work that has been sitting in the
    // queue. A signal already aborted on arrival takes this same path, so
    // there is no second case for it.
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    // Adjacent to the check on purpose. The instant a frame can no longer be
    // skipped is the instant it counts as started, and nothing may run
    // between the two that could throw and leave them disagreeing.
    options?.onStart?.();
    return send(path, bytes, wasmBaseUrl);
  });
  queue = conversion.then(
    () => undefined,
    () => undefined
  );
  return conversion;
}
```

Leave the existing comment above `queue = conversion.then(...)` in place; it explains why the value is discarded on both paths, and that reasoning is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/raw-worker-client.test.ts`
Expected: PASS, all cases in the file including the five that already existed.

- [ ] **Step 5: Add the two companion cases**

```ts
  it("leaves a frame already in flight alone", async () => {
    install();
    const controller = new AbortController();

    const conversion = convertRawInWorker(
      "/in/a.CR2",
      new Uint8Array([1]),
      "/wasm",
      { signal: controller.signal }
    );
    await settle();
    expect(built[0]?.posts).toBe(1);

    // Past the queue check, so the signal has nothing left to act on. The
    // frame is shared -- the pipeline and the metadata reader may both be
    // waiting on it -- so one consumer losing interest must not cancel it.
    controller.abort();
    pending[0]?.respond(new Uint8Array([9]));

    await expect(conversion).resolves.toEqual(new Uint8Array([9]));
    expect(built[0]?.terminated).toBe(false);
  });

  it("reports each frame as it leaves the queue", async () => {
    install();
    const started: string[] = [];

    const first = convertRawInWorker(
      "/in/a.CR2",
      new Uint8Array([1]),
      "/wasm",
      { onStart: () => started.push("a") }
    );
    const second = convertRawInWorker(
      "/in/b.CR2",
      new Uint8Array([2]),
      "/wasm",
      { onStart: () => started.push("b") }
    );
    await settle();

    // `b` is queued, not started. That distinction is what lets the cache
    // forget a frame it can still skip and keep one it cannot.
    expect(started).toEqual(["a"]);

    pending[0]?.respond(new Uint8Array([9]));
    await first;
    await settle();
    expect(started).toEqual(["a", "b"]);

    pending[1]?.respond(new Uint8Array([8]));
    await expect(second).resolves.toEqual(new Uint8Array([8]));
  });
```

- [ ] **Step 6: Run the whole suite, lint and typecheck**

```bash
npx jest
npx ultracite check src/lib/raw-worker-client.ts src/lib/raw-worker-client.test.ts
npx tsc --noEmit
```
Expected: no regressions against the 57-suite / 384-test baseline (this task adds 3 tests), no lint findings, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/raw-worker-client.ts src/lib/raw-worker-client.test.ts
git commit -m "$(cat <<'EOF'
feat(raw): let the queue skip a frame nobody wants any more

`convertRawInWorker` takes an optional signal, checked once at the front of
the queue rather than when the call was made: the work worth skipping is the
work that has been sitting in it. A skipped frame still occupies and settles
its link, so ordering and the one-frame-at-a-time invariant are untouched,
and `send()` is never entered -- no worker message, no interaction with
`abandon`, no termination.

`onStart` fires immediately after that check, because the cache on the other
side of the seam cannot otherwise tell a queued frame from one already
converting, and it must: forgetting the second kind would let a re-added set
convert the same frame twice.

Refs #248

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Three entry states and `dropRawConversions`

**Files:**
- Modify: `src/lib/raw-preview.ts`: `RawSourceIo` (:69-93), `Entry` (:95-99), `rawToTiff` (:112-148), `forget` (:176-182), `convert` (:184-199)
- Test: `src/lib/raw-preview.test.ts`

**Interfaces:**
- Consumes: `RawConvertOptions` and the four-argument `convertRawInWorker` from Task 1.
- Produces:
  ```ts
  export function dropRawConversions(paths: string[]): void;

  // RawSourceIo.tiffFor, changed:
  tiffFor?: (
    path: string,
    bytes: Uint8Array,
    options?: { onStart?: () => void; signal?: AbortSignal }
  ) => Promise<Uint8Array>;
  ```

**Background the implementer needs.** A frame has three states, and dropping treats the middle one *opposite* to how it treats the first:

| State | `flags.started` | `flags.done` | On drop |
|---|---|---|---|
| Queued, never sent | `false` | `false` | Abort and forget |
| In flight | `true` | `false` | Leave entirely alone |
| Finished | `true` or `false` | `true` | Leave entirely alone |

`started` is not guaranteed on a finished frame: a converter may resolve without ever calling `onStart`, which is what #243's OPFS path does when it answers from a cached TIFF instead of converting. So `done` is what recognizes a finished entry, and the drop check has to test both flags rather than `started` alone.

Forgetting an in-flight entry takes it out of the map while its conversion is still running, so re-adding the same set queues a *second* conversion of the same frame, the duplication this module caches the promise, rather than the result, to prevent. Leaning on the existing `catch → forget` instead fails the other way: a queued frame dropped and instantly re-added would hit the surviving entry and inherit its pending `AbortError`, showing a broken thumbnail for a file the user just asked for.

- [ ] **Step 1: Add the deferred IO helper to the test file**

`countingIo` resolves immediately, so it cannot model a frame that is in flight. Add alongside it in `src/lib/raw-preview.test.ts`:

```ts
/**
 * An IO whose conversions finish only when the test says so.
 *
 * `countingIo` resolves on the spot, which cannot model the state that
 * matters most here: a frame that has left the queue and is still converting.
 * `start()` stands in for the queue handing the frame to the worker, so a
 * test can place an entry in any of its three states deliberately.
 */
function deferredIo(): RawSourceIo & {
  converted: string[];
  finish: (path: string, bytes?: number) => void;
  start: (path: string) => void;
} {
  const converted: string[] = [];
  const starts = new Map<string, () => void>();
  const finishes = new Map<string, (tiff: Uint8Array) => void>();
  return {
    converted,
    finish: (path, bytes = 1024) => finishes.get(path)?.(new Uint8Array(bytes)),
    readFile: () => Promise.resolve(new Uint8Array(64)),
    start: (path) => starts.get(path)?.(),
    tiffFor: (path, _bytes, options) => {
      converted.push(path);
      starts.set(path, () => options?.onStart?.());
      return new Promise<Uint8Array>((resolve, reject) => {
        finishes.set(path, resolve);
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
    },
  };
}
```

Note the contract this encodes: a converter calls `onStart` when its work stops being skippable. `workerTiffFor` gets this for free from the queue; a test-injected converter must say so itself, and one that never calls `onStart` leaves its frames droppable forever.

- [ ] **Step 2: Write the failing test for the middle state**

This is the case that discriminates the three-state model from the two-state one:

```ts
  it("converts a frame once even if it is dropped in flight and re-added", async () => {
    const io = deferredIo();

    const first = rawToTiff("/in/capt01.CR2", io);
    await Promise.resolve();
    io.start("/in/capt01.CR2");

    // The user removes the set, then adds it back -- the wrong folder, or a
    // re-drag. The frame is already converting, so dropping it must not
    // forget it: a forgotten entry is a miss, and a miss here means a second
    // conversion of bytes already being converted.
    dropRawConversions(["/in/capt01.CR2"]);
    const second = rawToTiff("/in/capt01.CR2", io);

    io.finish("/in/capt01.CR2");
    await expect(first).resolves.toHaveLength(1024);
    await expect(second).resolves.toHaveLength(1024);
    expect(io.converted).toEqual(["/in/capt01.CR2"]);
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest src/lib/raw-preview.test.ts -t "dropped in flight"`
Expected: FAIL with **"dropRawConversions is not a function"** (it does not exist yet). Once it exists but forgets in-flight entries, this same test fails on the last line with `["/in/capt01.CR2", "/in/capt01.CR2"]`; keep that in mind, because that is the failure this test is really for.

- [ ] **Step 4: Implement the entry states and the drop**

In `src/lib/raw-preview.ts`, widen `RawSourceIo.tiffFor`:

```ts
  /**
   * Converts one frame, given its path and its bytes.
   *
   * This is the seam, rather than the `ModuleLoader` it replaced, because
   * conversion runs in a worker and a function cannot cross `postMessage`.
   * Defaults to `workerTiffFor`, which drives that worker. Tests inject their
   * own.
   *
   * Named for what it returns rather than what it does: under #243 it will
   * often answer from OPFS without converting anything.
   *
   * `options.signal` lets a frame still waiting in the queue be skipped.
   * `options.onStart` is the converter's half of that bargain: it says the
   * frame can no longer be skipped, which is the only way this module can
   * tell a queued frame from one already converting. A converter that never
   * calls it leaves its frames droppable for their whole life.
   */
  tiffFor?: (
    path: string,
    bytes: Uint8Array,
    options?: { onStart?: () => void; signal?: AbortSignal }
  ) => Promise<Uint8Array>;
```

Forward from the default converter at `:47`:

```ts
/** The default converter: the worker. Tests inject their own. */
function workerTiffFor(
  path: string,
  bytes: Uint8Array,
  options?: RawConvertOptions
): Promise<Uint8Array> {
  return convertRawInWorker(path, bytes, wasmBaseUrl(), options);
}
```

with `import { convertRawInWorker, type RawConvertOptions } from "./raw-worker-client";`.

Widen `Entry`. The two mutable flags live in their own object so that
`convert` can be handed something to write into *before* the entry exists;
the entry needs the promise `convert` returns, so passing the entry itself
would be circular and force a cast:

```ts
/**
 * What a conversion has done so far, separate from the entry so `convert`
 * can be given it before the entry it will belong to exists.
 */
interface EntryFlags {
  /** Set once the conversion settles, either way. */
  done: boolean;
  /** Set when the frame leaves the queue and reaches the worker. */
  started: boolean;
}

interface Entry {
  /** Zero until the conversion resolves, so a pending entry evicts nothing. */
  bytes: number;
  /** Aborting this skips the frame, but only while it is still queued. */
  controller: AbortController;
  flags: EntryFlags;
  tiff: Promise<Uint8Array<ArrayBuffer>>;
}
```

`rawToTiff` then builds the flags and the controller first, and the entry once
it has the promise:

```ts
  const controller = new AbortController();
  const flags: EntryFlags = { done: false, started: false };

  const tiff = convert(path, io, flags, controller.signal).catch(
    (error: unknown) => {
      // A failure must not be remembered as a result, or the file could never
      // be retried without a reload.
      flags.done = true;
      forget(key, flags);
      throw error;
    }
  );

  const entry: Entry = { bytes: 0, controller, flags, tiff };
  cache.set(key, entry);

  tiff
    .then((data) => {
      flags.done = true;
      // Only if this entry is still the live one for its key. An entry that
      // left the map while converting -- evicted, or cleared -- must not add
      // to `held`, because `forget` and `evictDownToBudget` both subtract
      // `entry.bytes`, which was still 0 when they let it go. Accounting for
      // it now would raise `held` permanently and make the budget evict ever
      // more eagerly for the rest of the session.
      const live = cache.get(key);
      if (live?.flags !== flags) {
        return;
      }
      live.bytes = data.byteLength;
      held += data.byteLength;
      evictDownToBudget(key);
    })
    .catch(() => {
      // Handled above; this only prevents an unhandled rejection.
    });

  return tiff;
```

`convert` takes the flags and the signal, not the entry; that is what keeps
it callable before the entry exists:

```ts
async function convert(
  path: string,
  io: RawSourceIo,
  flags: EntryFlags,
  signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await io.readFile(path);
  const tiff = await (io.tiffFor ?? workerTiffFor)(path, bytes, {
    onStart: () => {
      flags.started = true;
    },
    signal,
  });
  // Never a SharedArrayBuffer -- these builds are single-threaded, which is
  // what keeps them hostable without COOP/COEP headers, and a page served
  // without those headers does not even define SharedArrayBuffer. The value
  // now arrives by structured clone from the RAW worker rather than straight
  // from MEMFS, but a cloned or transferred view is always ArrayBuffer-backed
  // either way, so the narrowing still holds. Callers still owe `decodeTiff`
  // a copy of `.buffer`, not a bare handoff: it does `buffer.slice(0)` before
  // posting to the tiff worker.
  return tiff as Uint8Array<ArrayBuffer>;
}
```

`forget` becomes identity-aware:

```ts
/**
 * Removes an entry, if it is still the one holding its key.
 *
 * Identified by its flags rather than by the entry itself, so a conversion's
 * own `catch` can call this without a forward reference to the entry it has
 * not finished building. The two are one-to-one, so the check is the same.
 *
 * That check is what keeps a dropped frame's `AbortError` -- which arrives at
 * the `catch` above one turn later -- from deleting the *fresh* entry a user
 * created by re-adding the same file in between. Without it, that replacement
 * would be orphaned: still converting, no longer cached, and the next
 * consumer to ask would start a third conversion.
 */
function forget(key: string, flags: EntryFlags): void {
  const entry = cache.get(key);
  if (entry?.flags !== flags) {
    return;
  }
  held -= entry.bytes;
  cache.delete(key);
}
```

And the new export:

```ts
/**
 * Gives up on frames the user has removed.
 *
 * Only frames still waiting in the queue are given up on. One already
 * converting is left alone in both senses: it is not skipped, because the
 * queue is past the point where that is possible, and it is not forgotten,
 * because forgetting it would make a re-added set a cache miss and convert
 * the same bytes a second time. A finished frame is kept too -- it costs
 * nothing the LRU budget does not already govern, and it makes re-adding the
 * same file instant. `flags.done` is what recognizes it: a converter is free
 * to resolve without ever calling `onStart` -- #243's OPFS path will do
 * exactly that when it answers from a cached TIFF instead of converting --
 * and such a converter would otherwise leave `flags.started` false on a
 * completed entry, indistinguishable from one still queued.
 *
 * Paths that were never converted, including every non-RAW one, match no key
 * and cost a scan.
 */
export function dropRawConversions(paths: string[]): void {
  for (const path of paths) {
    for (const [key, entry] of Array.from(cache.entries())) {
      if (key !== path && !key.startsWith(`${path}|`)) {
        continue;
      }
      if (entry.flags.started || entry.flags.done) {
        continue;
      }
      entry.controller.abort();
      forget(key, entry.flags);
    }
  }
}
```

The key match covers both shapes `cacheKey` produces: `path` when there is no fingerprint, `path|fingerprint` when there is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/lib/raw-preview.test.ts`
Expected: PASS, including every case that already existed in the file.

- [ ] **Step 6: Add the three remaining cases**

```ts
  it("forgets a frame dropped before it started, so a re-add converts it", async () => {
    const io = deferredIo();

    const dropped = rawToTiff("/in/capt01.CR2", io);
    await Promise.resolve();
    // Deliberately no `io.start(...)`: this frame is still in the queue.
    dropRawConversions(["/in/capt01.CR2"]);
    await expect(dropped).rejects.toThrow(/abort/i);

    const again = rawToTiff("/in/capt01.CR2", io);
    await Promise.resolve();
    io.start("/in/capt01.CR2");
    io.finish("/in/capt01.CR2");

    // A re-added file must convert, not inherit the rejection of the entry
    // the user threw away.
    await expect(again).resolves.toHaveLength(1024);
    expect(io.converted).toHaveLength(2);
  });

  it("keeps a finished frame, so re-adding it is free", async () => {
    const source = countingIo();

    await rawToTiff("/in/capt01.CR2", source);
    dropRawConversions(["/in/capt01.CR2"]);
    await rawToTiff("/in/capt01.CR2", source);

    // Removing a file is not a reason to throw away work already done: the
    // LRU budget already governs how long it lives.
    expect(source.converted).toHaveLength(1);
  });

  it("does not count a conversion that finished after its entry was gone", async () => {
    const io = deferredIo();

    const conversion = rawToTiff("/in/capt01.CR2", io);
    await Promise.resolve();
    io.start("/in/capt01.CR2");
    clearRawPreviewCache();
    io.finish("/in/capt01.CR2");
    await conversion;

    // `forget` and `evictDownToBudget` both subtract `entry.bytes`, which is
    // 0 while a conversion is pending. Accounting for the bytes afterwards
    // would leave `held` permanently ahead of what is actually cached, and a
    // budget that thinks it is fuller than it is evicts frames it should
    // have kept. Reached here through `clearRawPreviewCache` because the
    // eviction path needs 768 MB of real allocation to trigger honestly.
    expect(rawCacheBytes()).toBe(0);
  });
```

Add `dropRawConversions` to the file's existing import from `./raw-preview`.

- [ ] **Step 7: Verify the accounting case actually discriminates**

The last case must fail without its guard. Temporarily delete the identity check from `rawToTiff`'s `.then` (keeping whatever the rest of the block needs to still compile):

```ts
      const live = cache.get(key);
      if (live?.flags !== flags) {
        return;
      }
```

Run: `npx jest src/lib/raw-preview.test.ts -t "finished after its entry was gone"`
Expected: FAIL with **"Expected: 0, Received: 1024"**.

Restore the guard and re-run; expected PASS. Do not commit with the guard removed.

- [ ] **Step 8: Run the whole suite, lint and typecheck**

```bash
npx jest
npx ultracite check src/lib/raw-preview.ts src/lib/raw-preview.test.ts
npx tsc --noEmit
```
Expected: no regressions against the baseline, no findings, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/raw-preview.ts src/lib/raw-preview.test.ts
git commit -m "$(cat <<'EOF'
feat(raw): give up on conversions the user has removed

`dropRawConversions(paths)` abandons frames still waiting in the queue. A
frame is one of three things, and the middle one is handled opposite to the
first: queued frames are aborted and forgotten, frames already converting are
left entirely alone, and finished frames are kept.

Forgetting an in-flight frame would take its entry out of the map while its
conversion ran, so re-adding the same set would miss and convert the same
bytes twice -- the duplication this module caches the promise rather than the
result to prevent. Relying instead on the existing `catch -> forget` fails
the other way round: a queued frame dropped and immediately re-added would
find the entry still there and inherit its pending AbortError, showing a
failed thumbnail for a file the user had just asked for. Telling the two
apart is what `onStart` is for.

`forget` now checks identity before deleting, so a dropped frame's
AbortError arriving a turn later cannot delete the replacement entry a re-add
created in the meantime.

Also fixes a pre-existing accounting leak this feature makes reachable. Both
`forget` and `evictDownToBudget` subtract `entry.bytes`, which is 0 while a
conversion is pending, so an entry that left the map before resolving added
to `held` and never subtracted -- `held` drifting up for the rest of the
session and the 768 MB budget evicting ever more eagerly. It needs two
brackets in play at once, 673 MB each, which is precisely the swap-one-set-
for-another flow this feature exists to serve.

Refs #248

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire the UI, and fix the index it removes by

**Files:**
- Modify: `src/components/ui/image-matrix-input.tsx:212-242`

**Interfaces:**
- Consumes: `dropRawConversions(paths: string[]): void` from Task 2.
- Produces: nothing later tasks depend on.

**Background the implementer needs.** There is a pre-existing bug here, filed as #251, and the wiring is wrong without fixing it. `:214` passes `row.files.toSorted(...)` to `ImageSetPreview`, which maps over that sorted array and reports *its* index (`image-set-preview.tsx:112-136`). `:238` then applies that index to the **unsorted** `row.files`. The two agree only while the stored order happens to be sorted, and `onAdd` at `:216-230` appends, so adding any file that sorts before an existing one desynchronises them and every later removal deletes the wrong frame.

- [ ] **Step 1: Read the current handlers**

Read `src/components/ui/image-matrix-input.tsx:200-245`. There is no unit test for this component and none is added: the behaviour worth pinning lives in the two library modules, and this change is a call plus an index fix. Verification is by reading and by the e2e suite.

- [ ] **Step 2: Hoist the sorted array and fix the index**

Replace the `ImageSetPreview` element's `files` and `onRemoveIndex` props. Add above the `return` inside the `.map` callback, next to `const issue = ...`:

```tsx
          // The preview renders files sorted, and reports the index of what
          // the user actually clicked. Resolving that index here, against the
          // same array, is what keeps "remove this one" meaning the frame
          // under the cursor rather than whichever one happens to sit at that
          // position in the stored order. See #251.
          const sorted = row.files.toSorted((a, b) => a.localeCompare(b));
```

Then:

```tsx
                files={sorted}
```

and:

```tsx
                onRemoveIndex={(deleteIndex) => {
                  const removed = sorted[deleteIndex];
                  dropRawConversions([removed]);
                  value[index] = {
                    ...row,
                    // Filtered by identity rather than by writing `sorted`
                    // back, which would also normalise the stored order on
                    // the first removal -- a change `onAdd` would undo on the
                    // next addition, so the array would flip between sorted
                    // and not depending on which the user did last.
                    files: row.files.filter((file) => file !== removed),
                  };
                  field.onChange([...value]);
                }}
```

- [ ] **Step 3: Drop the whole set's frames on set removal**

```tsx
                onRemove={() => {
                  dropRawConversions(row.files);
                  field.onChange(value.filter((_, i) => i !== index));
                }}
```

Add the import: `import { dropRawConversions } from "@/lib/raw-preview";`

- [ ] **Step 4: Lint, typecheck and run the suite**

```bash
npx ultracite check src/components/ui/image-matrix-input.tsx
npx tsc --noEmit
npx jest
```
Expected: no findings, no type errors, no regressions against the baseline.

- [ ] **Step 5: Verify by hand against the reference bracket**

The libraries are unit-tested; this step checks the wiring is actually connected. Run `npm run dev`, add the CR2 bracket, and confirm both:

1. Remove the set two frames in. The remaining thumbnails for a *newly added* set should start appearing within about two seconds rather than after the removed set's frames finish. Before this change that wait was roughly 15 s for a 10-frame set.
2. Add a file that sorts before an existing one, then remove a thumbnail by right-click. The frame that disappears must be the one that was clicked.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/image-matrix-input.tsx
git commit -m "$(cat <<'EOF'
feat(raw): drop conversions when the user removes the frames

Wires `dropRawConversions` into the two places that already know the user
changed their mind. Removing a set two frames in no longer makes a newly
added set wait about 15 s for frames nobody wants.

Fixes the index those handlers removed by, which had to change for the
wiring to be correct at all. The preview is handed a sorted copy and reports
an index into it; `onRemoveIndex` applied that index to the unsorted stored
array, so once `onAdd` appended a file that sorted earlier, removing an image
deleted the wrong one -- and dropping the conversion for one frame while the
form removed another would have left the cache and the UI disagreeing about
which frame was gone. The index is now resolved against the array the user
saw, and the file removed by identity so the stored order is left alone.

Closes #248
Closes #251

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the "what cancel means" definition and the queue check to Task 1; the three-state table, `dropRawConversions`, identity-aware `forget`, the `tiffFor` seam, `workerTiffFor` forwarding and the accounting fix to Task 2; the wiring and the index bug to Task 3. The spec's error-handling section needs no task of its own: `AbortError` is thrown in Task 1 and the forget-on-drop behaviour is Task 2's. Out-of-scope items (#252, terminating in flight, reference counting) correctly have no tasks.

**Type consistency.** `RawConvertOptions` is defined in Task 1 and consumed in Task 2. `dropRawConversions(paths: string[]): void` is defined in Task 2 and called in Task 3 with `[removed]` and `row.files`, both `string[]`. `Entry`'s `started`/`done`/`controller` are introduced and used only within Task 2. `tiffFor`'s options object is structurally identical to `RawConvertOptions` but written inline in `RawSourceIo`, deliberately: importing the worker client's type into the seam would tie the injectable interface to the worker implementation, which is what the seam exists to avoid.

**One thing the implementer must not smooth over.** In Task 2, the two mutable flags live in their own `EntryFlags` object rather than directly on `Entry`, and `forget` identifies an entry by that object rather than by the entry. This is not incidental style: `convert` must be handed something to write `started` into *before* the entry exists, because the entry needs the promise `convert` returns. Flattening the flags onto `Entry` reintroduces that circularity and forces either a cast on `tiff` or a forward reference to `entry` inside its own `catch`. Leaving `tiff` optional on the interface is not an acceptable escape either; every reader of a cached entry would then have to handle a state that never occurs.
