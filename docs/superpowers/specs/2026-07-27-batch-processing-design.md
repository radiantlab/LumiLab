# Batch processing: run every image set, not just the first

**Status:** implemented and manually verified, 2026-07-28
**Date:** 2026-07-27
**Issue:** [#224](https://github.com/radiantlab/LumiLab/issues/224)

## The problem

The upload panel accepts any number of image sets and validates all of them.
Only the first is ever processed:

```ts
// src/app/home-page/page.tsx:380
// TODO: implement batch processing
const [imageSet] = data.inputSets;
```

The validator at the same file requires *every* set to hold at least two images,
so the UI actively asks the user to fix directories it is about to discard. The
run reports success. Someone who queues five directories overnight gets one HDR
image and no indication that four were dropped.

## What already exists, and why it is not the answer

`pipeline.rs:356-483` has a batch path. It is selected by sniffing whether
`input_images[0]` is a directory on disk, loops over the entries, gives each its
own `tmp` subdirectory, emits `set_index`/`set_total`, and names outputs
`<dirname>_<datetime>.hdr`. The frontend never reaches it, because it always
sends files.

Routing the frontend into it was considered and rejected on four counts:

- It re-globs each directory with `get_images_from_dir`, so removing an image
  from a set (`image-matrix-input.tsx:200`) would silently do nothing.
- Sets assembled from dropped files have no single directory to name.
- One `invoke` cannot be interrupted between sets.
- One `invoke` yields one result, which cannot describe per-set outcomes.

It also carries two defects of its own: `StepProgress::new(PIPELINE_STAGES)` is
constructed once and shared across every set, so the bar reaches 100% during set
one and stays there; and `pipeline.rs:439` returns on the first failure,
abandoning the rest of the queue.

## Approach

**The loop lives in the frontend.** Each set is one `invoke("pipeline", …)`
through the existing single-scene path, which already takes an explicit file
list. Curation is honoured because the frontend sends exactly the files the user
chose.

This also puts the loop where the state already is. Per-set run records,
continue-on-failure and stop-between-sets all need the form data, the history
writer and the button, all of which live in the frontend. Keeping the loop in
Rust would split that across the IPC boundary for no gain.

### Forward compatibility

A future requirement is to point at a parent directory and have each
subdirectory become a set. That is frontend work: `image-matrix-input.tsx:122`
already expands directories with `readDir`. It produces ordinary curated sets
and needs no backend change, which is a further argument for keeping the backend
ignorant of directories. **Not in scope here.**

## Design

### 1. `run-batch.ts`: orchestration, isolated

New module `src/app/home-page/run-batch.ts`. A plain async function over the
sets, taking a per-set runner, a `shouldStop` predicate and lifecycle callbacks.
No React, no Tauri, no `invoke`.

The risk in this change is control flow, not wiring: does a failure stop the
queue, does Stop take effect at the right boundary, is the order right, is a
single set still handled exactly as before. Isolating that logic makes each of
those a unit test rather than something only reproducible with ten real
directories and a twenty-minute run.

`page.tsx` supplies the runner. It returns a per-set outcome list that the
caller turns into records and a summary.

### 2. Rust: name outputs after the set

Single-scene mode writes `<datetime>.hdr` (`pipeline.rs:537`). Two sets finishing
in the same second would collide, and the results would be indistinguishable
regardless.

Add a `set_name: String` parameter. Outputs become `<set>_<datetime>.hdr` and
`<set>_<datetime>_fc.hdr`, the convention the directory path already used.

Sanitising happens **in Rust**: the value becomes a filename, so path separators
and parent references are stripped where the file is written rather than trusted
from the caller. An empty name falls back to the current `<datetime>.hdr`, which
keeps the single-set behaviour unchanged for anyone who does not pass one.

Set names are not guaranteed unique: rows are keyed by `path.basename(fileDir)`
(`image-matrix-input.tsx:110`), so two directories with the same basename
collide today in the UI as well. The timestamp keeps the filenames distinct;
making the names unique is out of scope.

### 3. Rust: delete the `is_directory` path

Remove the branch, `get_images_from_dir`, and the `input_images[0].is_dir()`
sniff. Leaving it would keep a second batching implementation, unreachable, with
different failure and progress semantics from the one being written: the kind
of thing that gets revived or "fixed" later by someone who does not know it is
dead.

### 4. Run history: one record per set

A five-set batch writes five `RunRecord`s. Each keeps its own `outcome`,
`outputs`, `inputs` and `reason`, so the Runs page, its grouping and its row
actions work unchanged.

`id` is currently `startedAt`, which would now collide N times; it becomes
`${startedAt}-${index}`.

Sets that never started because Stop was pressed get **no** record. The existing
policy records every *attempt*; a set that was never begun is not one.

### 5. Progress and the console

`pipeline-status-context.tsx` already holds `setIndex`/`setTotal`, written today
only from Rust payloads. Add `beginSet(index, total, name)` that sets both and
appends a log entry; the loop calls it before each `invoke`.

Progress still runs 0→100 within each set rather than across the batch. "Set 3
of 10" carries overall position, and a single honest per-set bar is preferable
to a batch-wide one that assumes every set costs the same.

### 6. Stop after the current set

A Stop button appears while a run of more than one set is in flight. It sets a
flag the loop checks *between* sets; the running set finishes normally.

Deliberately not an abort: cancelling mid-set means killing Radiance and hdrgen
child processes and threading a signal through every stage. That is a separate
piece of work, and stopping at a set boundary is what makes an overnight batch
recoverable without discarding partial results.

### 7. One pre-run confirmation, covering both concerns

`CalibrationConfirmDialog` already fires on Generate when calibration files are
absent. A second dialog for the batch notice would mean answering two prompts to
start one run, so the existing dialog is generalised to cover both.

It appears when there is something to say, and says only what applies:

| Sets | Calibration | Dialog |
|---|---|---|
| 1 | complete | none, unchanged |
| 1 | incomplete | today's wording, unchanged |
| many | complete | shared-settings notice |
| many | incomplete | both, in one dialog |

The shared-settings section states the count and names what is applied to every
set: lens mask, view angles, target resolution, and the calibration files. The
calibration wording is preserved verbatim when it applies ("Not all calibration
files have been uploaded. Did you mean to not upload them all or do you want to
go back?"), because that phrasing was specifically agreed in #183.

`usePendingConfirmation<T>` needs no change; its subject becomes a richer object.

### 8. Validation

`describeRunBlocker` runs once, before the loop. It validates global
configuration, which is what the loop applies to every set.

## Out of scope

- **Per-set calibration files** (#173). Needs the same-vs-different decision
  taken there first.
- **Per-set mask validation.** The mask is checked against the selected preview
  image only, so a set whose images have different dimensions is not
  individually verified. It will fail in `crop` as it does today, now without
  taking the rest of the batch with it.
- **Cancelling mid-set** (see §6).
- **Parent-directory expansion into sets** (see Forward compatibility).
- **Batch-wide progress**, and making set names unique.

## Testing

**`run-batch.ts`, with a fake runner** (this is where the behaviour lives):

- runs every set, in order
- a failing set does not stop the queue, and its failure is reported against
  that set
- `shouldStop` between sets abandons the remainder and reports how many ran
- a set already running when Stop is pressed still completes
- one set behaves exactly as before: one record, no summary noise

**Rust:**

- output named `<set>_<datetime>.hdr` when a set name is given
- falls back to `<datetime>.hdr` when it is empty
- a hostile set name (`../../etc/passwd`, embedded separators) cannot escape the
  output directory
- existing single-scene tests still pass with the parameter absent

**Frontend integration:**

- the confirm dialog shows the shared-settings notice only when more than one
  set is present, and both sections when calibration is also incomplete
- N sets write N run records with distinct ids

**Manual, against the example CR2 bracket:** two directories, one deliberately
broken (a single exposure), confirms the good one still produces an HDR and the
Runs page shows one success and one failure.

Run on 2026-07-28 against the real CR2 bracket: everything works. Merged to
`main` on that basis.

## What shipped that this design did not call for

- **`completion_message`** in `src-tauri/src/pipeline/output_naming.rs`. The
  frontend calls the pipeline command once per set, so the hardcoded
  `"Pipeline complete."` would have appeared in the console after the first of
  ten sets and read as though the whole batch had finished.
- **The input panel is locked while a batch is in flight.** `handleSubmit`
  deep-clones the form values, so the loop runs against a submit-time snapshot
  while `ImageMatrixInput` renders the live array. Failure banners are keyed by
  array index, so removing a set mid-batch made a later set's banner land on an
  innocent row. Gating the add, remove and drop affordances on `batchInFlight`
  makes that unreachable rather than merely unlikely, and is honest about the
  fact that the run committed to a snapshot when Generate was pressed.

## Known gaps, recorded rather than fixed

- **A mid-batch change to the camera response file, or applying a preset, still
  clears every failure banner earned so far.** `inputSetIssueResetKey`
  (`page.tsx:249-258`) is `JSON.stringify({ cameraResponseLocation, inputSets })`,
  so it does not depend only on the array, and the panel lock does not reach
  those two inputs. The severe half is closed: no banner can point at an innocent
  set. What remains is losing an annotation, and the failure itself is not lost
  with it, since the run record keeps its reason. The fix is an early return on
  `batchInFlight` in the effect at `page.tsx:319`.
- **A set's stored transcript loses its own last entry or two.** `logRef` is
  synced by an effect, so at the instant `invoke` resolves it has not absorbed
  the entries committed in that same tick, typically the set's own
  "Finished `<set>`." line and, on failure, the error line. The console keeps
  them; run history does not. Classification is unaffected. The structural fix is
  to move the log ref into `PipelineStatusProvider` beside `outputsRef`, write it
  synchronously in the listener and in `beginSet`, reset it in `clearLog`, and
  expose `getLog()` mirroring `getOutputs()`. That would also create a testable
  seam where there is currently none.
- **`PipelineStatusPayload.set_index` and `set_total` are now dead in Rust.**
  Every construction site passes `None` since the directory-batching path was
  deleted, though the doc comment still advertises them as batch fields. The
  `setIndex`/`setTotal` frontend *state* must stay: `beginSet` writes it and
  `run-console.tsx:83` and `page.tsx:1006` read it.
- **Nothing locks the `buildPipelineParams` key set.** Tauri matches command
  parameters by name at runtime with no compile-time check, and the tests assert
  individual keys only. One `expect(Object.keys(params).sort()).toEqual([...])`
  would catch a future rename, which is the one thing the type system cannot.
- **Duplicate set names are still permitted, and the name is now load-bearing:**
  it determines the output stem. Two dropped parent directories that each contain
  a `scene1` give two rows named `scene1`. The timestamp still keeps the files
  apart.
- **A batch's Runs rows are indistinguishable.** Every record in a batch shares
  `startedAt` by design, and the row shows only time and outcome, nothing naming
  the set.
- **`src/components/ui/dropzone-input.tsx` is dead code** with zero references.
  If it were ever wired up it would be a second writer of `inputSets` that knows
  nothing about the panel lock.
- **The submit handler has no automated coverage.** The control-flow decisions
  live in `run-batch.ts` and are unit-tested; the wiring that reads them is not,
  because reaching it from jsdom means driving react-hook-form's file inputs and
  mocking four Tauri plugins. Both defects found during implementation were in
  that wiring.
