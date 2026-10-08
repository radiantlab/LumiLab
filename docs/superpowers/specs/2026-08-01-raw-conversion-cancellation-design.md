# Drop RAW conversions the user no longer wants

**Status:** designed, not implemented
**Date:** 2026-08-01
**Closes:** [#248](https://github.com/radiantlab/LumiLab/issues/248)
**Follows:** [#243](https://github.com/radiantlab/LumiLab/issues/243), which added the persistent tier this design deliberately does not touch

## The problem

RAW conversion runs one frame at a time in a dedicated worker. That serialism
is deliberate: `WasmToolRunner.clear()` keeps its compiled modules, so one
long-lived worker compiles `dcraw_emu` once and peaks at a single instance's
~266 MiB, where a pool would compile per worker and multiply that peak.

What the queue has no way to do is stop. `convertRawInWorker(path, bytes,
wasmBaseUrl)` takes no signal and polls nothing.

Because the queue is serial, frames nobody wants any more block frames
somebody does. Remove a 10-frame CR2 set two frames in, or drop a set and add
a different one, and the eight queued frames still convert before the first
frame of the new set starts. That is about 15 s of thumbnails that appear to
hang, on a path that was just fixed so it would stop appearing to hang.

Both siblings already do better. `decodeTiff` takes an `AbortSignal` and
terminates its worker on abort (`tiff-worker-client.ts:29-37`).
`executeInWorker` polls `shouldStop` every 250 ms and terminates between
stages. The RAW worker is the odd one out.

## What #248 assumed, and what the code says

#248 closed with a note worth correcting, because it would have argued this
work down to nothing:

> Once the worker grows an OPFS tier, a "queued" frame may turn out to be a
> cache hit that costs milliseconds, which makes dropping it pointless.

It does not. The persistent lookup lives *inside* the worker:
`convertWithCache` runs in `raw-worker.ts:96`, reached only after the frame
arrives by `postMessage`, which is to say after it has waited its entire turn
in the queue. A frame that is a 5 ms cache hit still sits behind eight 1.9 s
conversions.

So dropping queued frames did not become pointless under #243. If anything the
queue is now the only thing standing between a returning user and an instant
thumbnail.

That observation also implies a second, larger change (resolving cache hits
*before* they queue), which is deliberately **out of scope here**. It means
moving key derivation and the IndexedDB read out of the worker onto the page,
or adding a peek message, and it reworks the boundary #243 has just
established. Filed as
[#252](https://github.com/radiantlab/LumiLab/issues/252).

## What "cancel" means here

**A frame that has not yet been handed to the worker is never handed to it. A
frame already converting runs to completion.**

This is the cheapest of the three definitions #248 offered, and it recovers
almost all of the benefit, because the waste is queue time rather than the
~1.9 s in flight. It is also the only one that carries no risk to sharing:
`rawToTiff` caches the promise rather than its result, so one entry serves
three consumers (thumbnails via `use-tiff-bytes.tsx`, dimensions via
`generic-image-metadata.ts`, and the pipeline via `peekRawTiff`), and one
caller losing interest does not mean the frame is unwanted.

The two rejected alternatives, recorded so they are not re-litigated:

- **Terminate the in-flight frame.** `resetRawWorker()` already does this and
  has no caller outside `onError`. It reclaims up to ~1.9 s more, but throws
  away a frame the pipeline or the metadata reader may still be awaiting, and
  forces a fresh `dcraw_emu` compile on the next frame. Worth revisiting only
  if a case turns up where an in-flight frame is genuinely unwanted by
  everyone.
- **Reference-count the cache entry.** Correct in every case and the most
  work: every consumer acquires and releases, and `peekRawTiff` currently
  borrows without either. Not justified by a symptom that queue-skipping
  already resolves.

## Design

### Ownership

```
image-matrix-input.tsx
        │  dropRawConversions(paths)
        ▼
raw-preview.ts          owns the session cache and one controller per entry
        │  signal
        ▼
raw-worker-client.ts    owns the queue, checks the signal before send()
```

The UI never learns that a worker or a queue exists, which is how it already
reaches conversion: only through `rawToTiff`. `raw-preview.ts` is the only
module that can both abort the conversion and forget the entry, so the drop
API belongs there.

### `raw-worker-client.ts`

`convertRawInWorker` gains an optional `options` argument carrying the signal
and an `onStart` callback:

```ts
const conversion = queue.then(() => {
  if (options?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  options?.onStart?.();
  return send(path, bytes, wasmBaseUrl);
});
```

The two lines are adjacent on purpose: the moment a frame is past the point of
being skipped is the moment it counts as started, and nothing may run between
them that could throw and leave the two disagreeing.

Checked at the front of the queue rather than at call time, which is the whole
point: the work being skipped is work that has been waiting. A signal already
aborted when `convertRawInWorker` is called is caught by the same check, so
there is no second code path for it.

A skipped frame still occupies its link in the chain and still settles it, so
ordering and the one-frame-at-a-time invariant are untouched. `send()` is
never entered, so there is no worker message, no interaction with `abandon`,
and no termination.

### `raw-preview.ts`

A frame has **three** states, not two, and dropping treats each differently.
Collapsing the middle one into the first is the mistake this section exists to
avoid:

| State | `started` | `done` | On drop |
|---|---|---|---|
| Queued, never sent | `false` | `false` | Abort and forget |
| In flight | `true` | `false` | **Leave entirely alone** |
| Finished | `true` | `true` | Leave entirely alone |

The middle row is the one that bites. Aborting an in-flight frame is already a
no-op, since the queue check has passed, but *forgetting* it takes the entry
out of the map while its conversion is still running. Re-add the same set,
which is exactly what #248 describes ("drop a set and add a different one",
or the same one from the right folder), and the frame is a miss, so a
**second** conversion of bytes already converting joins the queue. That is the
duplication `rawToTiff` caches the promise rather than the result to prevent,
in the module whose header calls itself "the only place a RAW file is
demosaiced".

Leaning on the existing `catch → forget` at `:127` instead of forgetting at
drop time does not work either, and for the opposite reason: a *queued* frame
that is dropped and immediately re-added would hit the still-present entry and
inherit its pending `AbortError`, showing a failed thumbnail for a file the
user just asked for. Forget-at-drop is right for queued and wrong for
in-flight, so the two states have to be distinguishable.

`Entry` therefore gains a controller and two flags. The flags live in their own
object rather than directly on the entry, because `convert` has to be handed
something to write `started` into *before* the entry exists -- the entry needs
the promise `convert` returns:

```ts
interface EntryFlags {
  /** Set once the conversion settles, either way. */
  done: boolean;
  /** Set when the frame leaves the queue and reaches the worker. */
  started: boolean;
}

interface Entry {
  bytes: number;
  controller: AbortController;
  flags: EntryFlags;
  tiff: Promise<Uint8Array<ArrayBuffer>>;
}
```

The controller belongs to the *entry*, not to a caller. That is what keeps
sharing intact: there is exactly one conversion per frame and exactly one
thing that can call it off, so no consumer can cancel a frame out from under
the other two.

`started` cannot be inferred on this side of the seam (only the queue knows
when a frame leaves it), so the seam carries a callback back. `RawSourceIo`'s
`tiffFor` takes an options object rather than growing a third positional
parameter:

```ts
tiffFor?: (
  path: string,
  bytes: Uint8Array,
  options?: { signal?: AbortSignal; onStart?: () => void }
) => Promise<Uint8Array>;
```

`workerTiffFor` at `raw-preview.ts:47` is the default implementation and must
forward the options to `convertRawInWorker`: the signal reaches the queue
check and `onStart` fires just past it. A test injecting its own `tiffFor` may
ignore both, which is what makes the cache tests independent of the worker.

New export:

```ts
export function dropRawConversions(paths: string[]): void
```

For each path it matches cache keys by `key === path || key.startsWith(
`${path}|`)` (keys are `path` or `path|fingerprint`) and then applies the
table above: an entry that has neither `started` nor `done` is aborted and
forgotten; anything else is left untouched.

Both flags are tested, not `started` alone. A converter is free to resolve
without ever calling `onStart` -- #243's OPFS path will do exactly that when it
answers from a cached TIFF instead of converting -- and such a converter would
leave `started` false on an entry that has already finished its work. Checking
`started` alone would abort and forget that entry, throwing away a conversion
that is complete.

A finished conversion is deliberately kept rather than evicted. It costs
nothing beyond the LRU budget that already governs it, and keeping it makes
re-adding the same file instant instead of a re-queue. Non-RAW paths match no
key, so callers need not filter by extension.

`forget` becomes identity-aware, taking the flags of the entry it means to
remove and deleting only if `cache.get(key)?.flags === flags`. Identifying by
the flags rather than by the entry lets a conversion's own `catch` call it
without a forward reference to the entry it has not finished building; the two
are one-to-one, so the check is the same. Without that check, a dropped frame's
`AbortError` arriving at the `catch` on `:127` *after* the user has re-added
the file would delete the replacement entry, orphaning a conversion that is
already running and sending the next consumer to a third one.

### The accounting bug this uncovers

`raw-preview.ts:137-141` accounts for a conversion when it resolves:

```ts
entry.bytes = data.byteLength;
held += data.byteLength;
```

`forget()` and `evictDownToBudget()` both subtract `entry.bytes`, which is
**0 while the entry is pending**. So any entry removed from the map before its
conversion resolves adds to `held` and never subtracts. `held` drifts upward
permanently and the 768 MB budget starts evicting far too eagerly.

Dropping itself does **not** reach this. Under the three-state model only an
entry that never started is forgotten, and such an entry rejects rather than
resolving, so its accounting branch never runs. An earlier draft of this spec
claimed dropping made the leak routine; that was true of the two-state design
it was written against and is not true of this one.

What reaches it is the flow this feature exists to serve. `evictDownToBudget`
does not skip pending entries, and `BUDGET_BYTES` is 768 MB against a
ten-frame bracket's 673 MB, so it takes two brackets in play at once for
eviction to land on a frame that is still converting. Dropping one set and
adding another is exactly that, and it is the scenario #248 opens with. The
fix belongs here because this feature is what makes the flow common, not
because dropping performs it.

The `.then` accounts only if the entry is still the live one for its key.

```ts
.then((data) => {
  flags.done = true;
  const live = cache.get(key);
  if (live?.flags !== flags) {
    return;               // dropped or evicted while converting
  }
  live.bytes = data.byteLength;
  held += data.byteLength;
  evictDownToBudget(key);
})
.catch(() => {
  // Handled at `:127`, which is also where `done` is set on the failure
  // path; this only prevents an unhandled rejection, as it did before.
})
```

`done` is set on both paths. A conversion that failed is as finished as one
that succeeded, and `dropRawConversions` must not try to abort either.

### `image-matrix-input.tsx`

Wired to the two places that already know the user changed their mind:

- `onRemove` (the whole set) drops every file in the row.
- `onRemoveIndex` drops the one file removed.

### The index bug this uncovers

`image-set-preview.tsx:112` maps over `files`, which `image-matrix-input.tsx:214`
passes as `row.files.toSorted(...)`. `onRemoveIndex` at
`image-matrix-input.tsx:238` then applies that index to the **unsorted**
`row.files`. Removing an image therefore deletes the wrong frame whenever the
stored order is not already sorted, which `onAdd` guarantees as soon as it
appends a file that sorts before an existing one.

This is a user-facing bug that predates this work, and it is fixed here rather
than separately because the wiring is not correct without it: dropping the
conversion for `sorted[i]` while the form removes `unsorted[i]` leaves the
cache and the UI disagreeing about which frame is gone.

Sort once, and resolve the index against that same array to a *file*, then
remove that file by identity:

```tsx
const sorted = row.files.toSorted((a, b) => a.localeCompare(b));

<ImageSetPreview
  files={sorted}
  onRemoveIndex={(i) => {
    const removed = sorted[i];
    dropRawConversions([removed]);
    value[index] = { ...row, files: row.files.filter((f) => f !== removed) };
    field.onChange([...value]);
  }}
/>
```

Filtering `row.files` by identity rather than writing `sorted` back is
deliberate. Writing the sorted array back would also *normalize the stored
order* on the first removal, which is a behaviour change beyond the bug:
`onAdd` appends, so the stored array would flip between sorted and unsorted
depending on which action the user took last. The index bug is fixed by making
the index mean one thing; stored order is left exactly as it was.

Filed independently as
[#251](https://github.com/radiantlab/LumiLab/issues/251), since it is worth a
changelog line of its own and did not arrive with this feature.

## Error handling

A dropped frame rejects with a `DOMException` named `AbortError`, the same
shape `decodeTiff` uses, so a deliberate drop stays distinguishable from a
genuine conversion failure.

It must not be remembered as a result. `dropRawConversions` calls `forget` at
drop time, and the existing `catch → forget` at `raw-preview.ts:127` covers
the rejection that follows. A frame dropped and then re-added converts afresh
rather than inheriting a rejected promise.

**This section originally claimed there was no new unhandled-rejection
surface, and it was wrong.** It enumerated two handlers -- `raw-preview.ts`'s
own, on the cached promise, and `tiff-image.tsx:50`, on the derived decode
promise -- and concluded that every consumer was covered. It missed a third
consumer that also derives a promise from the cached one:
`generic-image-metadata.ts`'s `getTiffImageMetadata`, which chains
`rawToTiff(...).then(...)` to read the mask preview's dimensions. That promise
had no rejection path at all, and making `AbortError` a routine outcome is
exactly what turned the omission into two user-visible failures:

- The submit handler at `page.tsx:440` awaits that promise outside its own
  `try`, and it is memoized on the path -- so once it rejects, pressing Run did
  nothing at all, with no toast and no recorded attempt, for as long as the
  removed file stayed selected.
- `lens-mask-input.tsx` and `fs-circular-mas-selection.tsx` read it with
  `use()` inside a `Suspense` that has no `ErrorBoundary` above it anywhere.

The cause underneath both is not the drop. It is that `selectedImage` was never
cleared when the file it names is removed, so a path the form no longer
contains went on driving the mask preview. What is true after the fix:

- `image-matrix-input.tsx` clears the selection in `onRemove` and
  `onRemoveIndex` when it points at a file being removed, so no consumer asks
  for the metadata of a removed frame in the first place. The clear is as
  narrow as the removal: removing some other set or sibling frame leaves the
  selection alone.
- `useGenericImageMetadata` attaches a swallowing handler where it memoizes the
  promise, in the same spirit as `tiff-image.tsx:50`, so a metadata promise
  created before the removal cannot surface as an unhandled rejection after the
  selection has moved on. It returns the original promise, not the handled one:
  a genuine conversion failure must still reject rather than look like an image
  with no dimensions.

The thumbnail itself unmounts when its file is removed, so the `AbortError`
still does not reach the `ErrorBoundary` at `tiff-image.tsx:69`.

No `ErrorBoundary` was added over the mask preview. One would be worth having
on its own merits, but it addresses neither failure above -- the submit-handler
one never throws during render -- and it is left as separate work rather than
smuggled in as a fix for this.

## Testing

In `raw-worker-client.test.ts`, against the worker double that already pins
the serial invariant:

- A queued frame whose signal is aborted never reaches the worker. Asserted on
  the double's received-message count, not on a flag, so a frame that is
  merely *marked* dropped still fails the test.
- The frames queued behind a skipped one still convert, in order.
- A frame already in flight is unaffected by an abort and still resolves.

In `raw-preview.test.ts`:

- A dropped queued entry is forgotten, so a later request for the same path
  converts again rather than returning the rejected promise.
- **A frame dropped while in flight is converted exactly once even if it is
  re-added.** This is the test for the three-state model: assert the injected
  `tiffFor` was called once, not that the entry still exists, so a design that
  forgets in-flight entries fails it.
- A completed entry is not forgotten, so a re-add is served from memory.
- `rawCacheBytes()` stays at zero when a conversion settles after its entry
  has left the map. This is the guard on the accounting fix, and it is driven
  through `clearRawPreviewCache()` rather than through eviction: reaching
  `evictDownToBudget` honestly would mean allocating past a 768 MB budget in a
  unit test. The entry point is tests-only, but the guard it exercises is the
  same one the eviction path needs, and it fails against today's code.

The `image-matrix-input.tsx` drop wiring itself is not unit-tested; the
behaviour worth pinning there lives in the two library modules, and the
component change is a two-line call plus the index fix.

The selection clear that removal now performs *is* tested, in
`__tests__/image-matrix-selection-clear.test.tsx`, against the same
RTL-plus-react-hook-form harness `image-matrix-lock.test.tsx` uses. Four cases:
the selection is cleared when its whole set is removed and when that one frame
is removed, and it survives the removal of another set and of a sibling frame.
The last two are what stop an unconditional clear from passing.

## Out of scope

- Resolving persistent-cache hits before they queue:
  [#252](https://github.com/radiantlab/LumiLab/issues/252).
- Terminating in-flight conversions, and reference-counting cache entries.
  Both rejected above, with reasons.
- Any change to `raw-cache.ts`, `raw-cache-idb.ts`, or the worker's own
  caching. #243's boundary is untouched.
