# Batch Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run every image set the user queued, not just the first, reporting each set's success or failure separately.

**Architecture:** The loop lives in the frontend. Each set is one `invoke("pipeline", …)` through the existing single-scene Rust path, which already takes an explicit file list, so a curated set is honoured exactly as assembled. Orchestration (order, continue-on-failure, stop-between-sets) is isolated in a plain async function with no React and no Tauri in it, so the control flow that carries the risk is unit-tested rather than only reproducible with ten real directories and a twenty-minute run. Rust gains a set name for output filenames and loses its own unreachable batch implementation.

**Tech Stack:** Next.js 15 / React 19 / TypeScript, react-hook-form, Tauri v2 (Rust backend), Jest + Testing Library (jsdom), `cargo test`, Biome via `ultracite`.

**Spec:** `docs/superpowers/specs/2026-07-27-batch-processing-design.md`
**Issue:** [#224](https://github.com/radiantlab/LumiLab/issues/224)

## Global Constraints

- **Set positions are 1-based everywhere**: display text, `beginSet`, the `RunRecord.id` suffix, and Rust's `set_index`. Never mix a 0-based array index into a position. The one exception is `imageSetIssues`, which is keyed by array index because `ImageMatrixInput` maps rows with `value.map((row, index) => …)`; convert with `position - 1` at that single call site and nowhere else.
- **#183's calibration wording is verbatim and must not drift:** title `Not all calibration files have been uploaded`, question `Did you mean to not upload them all, or do you want to go back?`, confirm button `Generate anyway`, cancel button `Go back`. A single set with incomplete calibration files must produce exactly today's dialog.
- **Do not use em dashes in prose** (project-wide writing rule). Comments and copy included.
- **`describeRunBlocker` runs once, before the loop**, against the global config and the *selected preview image's* dimensions. Per-set mask validation is explicitly out of scope; do not move this call inside the loop.
- **Do not derive "a run is in progress" from `progress !== 100`.** Rust emits `Done` with `progress: 100` at the end of *every* `invoke`, so between sets the bar reads 100 while the batch is still running. Run state is an explicit boolean owned by `page.tsx`.
- **Do not call `clearLog()` between sets.** It resets the output ref and the transcript; the console is meant to show the whole batch. It is called once, before the loop.
- Object literal keys and import statements are alphabetically sorted in this codebase; Biome enforces it. Run `npm run fix` before committing if unsure.
- Rust code is formatted with `cargo fmt`; run it before committing Rust changes.

## Out of scope (do not implement)

Per-set calibration files (#173), per-set mask validation, cancelling mid-set, batch-wide progress, making set names unique, and expanding a parent directory into one set per subdirectory.

## File Structure

**Rust**

| File | Responsibility |
|---|---|
| `src-tauri/src/pipeline/output_naming.rs` | **New.** Pure: turns a set name plus a timestamp into an output filename stem, sanitised so a name cannot escape the output directory. Also the run's completion message. |
| `src-tauri/src/pipeline.rs` | Modified. Gains a `set_name` parameter; loses the unreachable directory-batching branch and `get_images_from_dir`. |

**Frontend**

| File | Responsibility |
|---|---|
| `src/app/home-page/run-batch.ts` | **New.** The loop: order, continue-on-failure, stop-between-sets, counts. No React, no Tauri. |
| `src/app/home-page/run-confirm-dialog.tsx` | **Renamed** from `calibration-confirm-dialog.tsx`. One pre-run dialog covering both the shared-settings notice and the calibration question, plus the pure rule for when it appears. |
| `src/app/pipeline-status-context.tsx` | Modified. Gains `beginSet`, which the loop calls before each `invoke`. |
| `src/app/home-page/build-pipeline-params.ts` | Modified. Gains a required `setName` argument. |
| `src/app/home-page/pipeline-status.tsx` | Modified. Gains Stop, and takes run state as a prop instead of inferring it from progress. |
| `src/app/home-page/page.tsx` | Modified. Replaces `const [imageSet] = data.inputSets` with the loop; writes one record per set. |

**Tests**

`__tests__/run-batch.test.ts` (new), `__tests__/run-confirm-dialog.test.tsx` (renamed from `calibration-confirm-dialog.test.tsx`), `__tests__/pipeline-status-log.test.tsx` (extended), `__tests__/build-pipeline-params.test.ts` (updated call sites), Rust tests inline in `output_naming.rs`.

---

### Task 1: Delete the unreachable directory-batching path in Rust

`pipeline.rs` has a second batch implementation selected by sniffing whether `input_images[0]` is a directory. The frontend always sends files, so it never runs. It is deleted first, before anything is added, so the rest of the work happens on a file with one code path instead of two. Its own defects (a `StepProgress` shared across sets, and `return Err` on the first failure) are why leaving it as a reference is not an option: someone would revive it.

**Files:**
- Modify: `src-tauri/src/pipeline.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: a `pipeline` command with a single code path. `get_images_from_dir` no longer exists.

- [ ] **Step 1: Confirm the current tests pass, so any breakage is attributable**

Run: `cd src-tauri && cargo test`
Expected: PASS (48 tests at time of writing).

- [ ] **Step 2: Delete the directory sniff**

Remove these lines (currently `pipeline.rs:283-287`):

```rust
    let is_directory = if input_images.len() > 0 {
        Path::new(&input_images[0]).is_dir()
    } else {
        false
    };
```

- [ ] **Step 3: Delete the processing-mode debug print**

Inside the `if DEBUG {` block, remove (currently `pipeline.rs:319-324`):

```rust
        println!("\n\nPROCESSING MODE");
        if is_directory {
            println!("\tUser selected directories. (Batch processing)");
        } else {
            println!("\tUser selected images. (Single scene)");
        }
```

- [ ] **Step 4: Replace the branch with the single-scene body**

> The file does not compile between this step and Step 5: `return_path` is deleted here and its last use is removed there. Do not run `cargo` in between. The `emit_status` block that reports the run finishing sits *after* the branch being deleted and stays where it is.

Delete everything from `let mut return_path: PathBuf = PathBuf::new();` through the closing `}` of the `else` block (currently `pipeline.rs:355-566`) and put this in its place, un-indented by one level:

```rust
    // Ensure images are a supported format
    for input_image in &input_images {
        if !is_supported_format(&PathBuf::from(input_image)) {
            return Err(PipelineError::InvalidInput {
                field: "inputImages".to_string(),
                value: "unsupported-format".to_string(),
            });
        }
    }

    // Run the HDRGen and Radiance pipeline on the images
    let result = process_image_set(
        &app,
        &config_settings,
        &luminance_args,
        input_images,
        response_function.clone(),
        fisheye_correction_cal.clone(),
        vignetting_correction_cal.clone(),
        photometric_adjustment_cal.clone(),
        neutral_density_cal.clone(),
        diameter.clone(),
        xleft.clone(),
        ytop.clone(),
        xdim.clone(),
        ydim.clone(),
        vertical_angle.clone(),
        horizontal_angle.clone(),
        projection.clone(),
        measured_vertical_illuminance,
        &mut progress,
        filter_images,
    );
    if let Err(error) = result {
        emit_status(
            &app,
            PipelineStatusPayload {
                kind: PipelineStatusKind::Error,
                progress: None,
                step: None,
                message: Some(format!("{:?}", error)),
                set_index: None,
                set_total: None,
            },
        )?;
        return Err(error);
    }

    // Get current local date and time and format output name with it
    let datetime = format!("{}", Local::now().format("%F_%H-%M-%S"));
    let output_file_name = config_settings
        .output_path
        .join(format!("{}.hdr", datetime));

    // Copy the final output hdr image to output directory
    let mut copy_result = copy(
        &config_settings.temp_path.join("header_editing.hdr"),
        &output_file_name,
    );
    if copy_result.is_err() {
        return Err(PipelineError::Processing {
            message: "Error copying final hdr image to output directory.".to_string(),
        });
    }
    emit_pipeline_output(&app, &output_file_name)?;

    let luminance_file_name = config_settings
        .output_path
        .join(format!("{}_fc.hdr", datetime));
    copy_result = copy(
        &config_settings.temp_path.join("falsecolor_output.hdr"),
        &luminance_file_name,
    );
    if copy_result.is_err() {
        return Err(PipelineError::Processing {
            message: "Error copying final hdr luminance image to output directory.".to_string(),
        });
    }
```

- [ ] **Step 5: Return the output path directly**

`return_path` existed only because the two branches disagreed about it. Replace the final return (currently `pipeline.rs:581`):

```rust
    Ok(return_path.to_string_lossy().to_string())
```

with:

```rust
    Ok(config_settings.output_path.to_string_lossy().to_string())
```

- [ ] **Step 6: Delete `get_images_from_dir`**

Remove the whole function and its doc comment (currently `pipeline.rs:584-613`), including:

```rust
/*
 * Retrieves all JPG and CR2 images from a directory, ignoring other files or directories.
 * Does not check for images to be of the same format.
 */
pub fn get_images_from_dir(input_dir: &String) -> Result<Vec<String>, PipelineError> {
```

Leave `is_supported_format` alone: it is still used by the format check in step 4. Leave `fs::{self, …}` in the imports alone: `fs::read_to_string` is still used at `pipeline.rs:125`.

- [ ] **Step 7: Drop the now-unnecessary `mut`**

The removed branch was the only thing that reassigned `config_settings.temp_path`, so the compiler will warn that the binding need not be mutable. Change:

```rust
    let mut config_settings = ConfigSettings {
```

to:

```rust
    let config_settings = ConfigSettings {
```

- [ ] **Step 8: Build and test, expecting no warnings**

Run: `cd src-tauri && cargo fmt && cargo test 2>&1 | tail -30`
Expected: PASS, same test count as step 1, and no `unused` or `does not need to be mutable` warnings. If `PathBuf` or `Path` is reported unused, leave the import: both are still used elsewhere in the file. Investigate any warning rather than suppressing it.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/pipeline.rs
git commit -m "refactor(pipeline): delete the unreachable directory-batching path"
```

---

### Task 2: Name outputs after the set, in Rust

Single-scene mode writes `<datetime>.hdr`. Two sets finishing in the same second collide, and even when they do not, the results are indistinguishable. The set name becomes part of a filename, so it is sanitised where the file is written rather than trusted from the caller.

**Files:**
- Create: `src-tauri/src/pipeline/output_naming.rs`
- Modify: `src-tauri/src/pipeline.rs`

**Interfaces:**
- Consumes: Task 1's single-path `pipeline` command.
- Produces: `pub fn output_stem(set_name: &str, datetime: &str) -> String` and `pub fn completion_message(set_name: &str) -> String` in `crate::pipeline::output_naming`. The `pipeline` command gains a `set_name: String` parameter, which Tauri matches to a `setName` key in the JS payload (Task 3 sends it).

> **Note, beyond the approved design:** `completion_message` is an addition the spec does not call for. A batch runs this command once per set, so the existing hardcoded `"Pipeline complete."` would appear in the console after the first of ten sets and read as though the whole batch had finished. It is one function in a module this task creates anyway. If it is not wanted, drop `completion_message` and its two tests and leave the `Done` message as `"Pipeline complete.".to_string()`; nothing else in the plan depends on it.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/pipeline/output_naming.rs` with only the tests, so the first run fails to compile on the missing functions:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const DATETIME: &str = "2026-07-28_14-30-00";

    #[test]
    fn a_named_set_leads_the_stem() {
        assert_eq!(
            output_stem("kitchen", DATETIME),
            format!("kitchen_{DATETIME}")
        );
    }

    #[test]
    fn an_empty_name_keeps_the_single_scene_stem() {
        assert_eq!(output_stem("", DATETIME), DATETIME);
    }

    #[test]
    fn a_name_with_nothing_usable_in_it_keeps_the_single_scene_stem() {
        assert_eq!(output_stem("///", DATETIME), DATETIME);
        assert_eq!(output_stem("   ", DATETIME), DATETIME);
    }

    #[test]
    fn a_traversing_name_cannot_escape_the_output_directory() {
        let stem = output_stem("../../etc/passwd", DATETIME);

        assert!(!stem.contains('/'));
        assert!(!stem.contains(".."));

        let output_dir = Path::new("/tmp/hdri-output");
        let written = output_dir.join(format!("{stem}.hdr"));
        assert_eq!(written.parent(), Some(output_dir));
    }

    #[test]
    fn a_windows_traversing_name_cannot_escape_either() {
        let stem = output_stem("..\\..\\Windows", DATETIME);

        assert!(!stem.contains('\\'));
        assert_eq!(stem, format!("Windows_{DATETIME}"));
    }

    #[test]
    fn a_long_name_is_truncated() {
        let stem = output_stem(&"a".repeat(200), DATETIME);

        assert_eq!(stem, format!("{}_{DATETIME}", "a".repeat(64)));
    }

    #[test]
    fn an_unnamed_run_reports_the_pipeline_finishing() {
        assert_eq!(completion_message(""), "Pipeline complete.");
    }

    #[test]
    fn a_named_run_reports_which_set_finished() {
        assert_eq!(completion_message("kitchen"), "Finished kitchen.");
    }
}
```

Register the module in `src-tauri/src/pipeline.rs` by adding it to the `mod` list at the top, after `mod nullify_exposure_value;`:

```rust
mod output_naming;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test output_naming`
Expected: FAIL to compile, `cannot find function output_stem in this scope`.

- [ ] **Step 3: Write the implementation**

Insert above the `#[cfg(test)]` block in `src-tauri/src/pipeline/output_naming.rs`:

```rust
/// Long enough for a descriptive directory name, short enough that the stem
/// plus the timestamp and the `_fc.hdr` suffix stays well inside the 255-byte
/// filename limit every filesystem the app targets imposes.
const MAX_SET_NAME: usize = 64;

/// Builds the stem that one run's outputs share.
///
/// The set name arrives from the frontend and becomes part of a filename, so it
/// is sanitised here, where the file is written, rather than trusted from the
/// caller. Everything outside an ASCII-safe set becomes an underscore, which
/// leaves no path separator, no parent reference and no drive letter for a name
/// to escape the output directory with.
///
/// A run with no set name keeps the plain `<datetime>` stem, so a single scene
/// is named exactly as it was before batches existed.
pub fn output_stem(set_name: &str, datetime: &str) -> String {
    let sanitised = sanitise_set_name(set_name);
    if sanitised.is_empty() {
        datetime.to_string()
    } else {
        format!("{sanitised}_{datetime}")
    }
}

/// What the console shows when one run ends.
///
/// A batch calls the pipeline command once per set, so a bare "Pipeline
/// complete." would appear after the first of ten sets and read as though the
/// whole batch had finished. The raw name is used here rather than the
/// sanitised one: this is a sentence, not a path.
pub fn completion_message(set_name: &str) -> String {
    let trimmed = set_name.trim();
    if trimmed.is_empty() {
        "Pipeline complete.".to_string()
    } else {
        format!("Finished {trimmed}.")
    }
}

/// Dots are replaced along with everything else. It costs a directory named
/// `2026.07.28` its dots, and in exchange there is no `..` left to reason
/// about. Non-ASCII letters go the same way: a name is a filename here, not a
/// label, and the label the user sees comes from the frontend.
fn sanitise_set_name(set_name: &str) -> String {
    let replaced: String = set_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Trimmed before truncating so a leading run of separators does not eat the
    // budget, and after so truncation cannot leave a trailing underscore.
    let truncated: String = replaced
        .trim_matches('_')
        .chars()
        .take(MAX_SET_NAME)
        .collect();
    truncated.trim_matches('_').to_string()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test output_naming`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the `set_name` parameter to the pipeline command**

In `src-tauri/src/pipeline.rs`, import the helpers next to the other pipeline-module `use` lines:

```rust
use output_naming::{completion_message, output_stem};
```

Add the parameter to the command signature, immediately after `input_images`:

```rust
    input_images: Vec<String>,
    set_name: String,
```

Add a line to the parameter documentation block above `#[tauri::command]`, next to the `input_images` entry:

```rust
// set_name:
//      Names this set in the output filenames, so a batch produces
//      <set>_<datetime>.hdr rather than N files distinguishable only by a
//      timestamp. Empty for a run with no set name, which keeps the plain
//      <datetime>.hdr. Sanitised in output_naming.rs, because it becomes a
//      filename.
```

- [ ] **Step 6: Use the stem for both outputs**

Replace the naming introduced in Task 1:

```rust
    // Get current local date and time and format output name with it
    let datetime = format!("{}", Local::now().format("%F_%H-%M-%S"));
    let output_file_name = config_settings
        .output_path
        .join(format!("{}.hdr", datetime));
```

with:

```rust
    // Get current local date and time and format output name with it
    let datetime = format!("{}", Local::now().format("%F_%H-%M-%S"));
    let stem = output_stem(&set_name, &datetime);
    let output_file_name = config_settings.output_path.join(format!("{stem}.hdr"));
```

and:

```rust
    let luminance_file_name = config_settings
        .output_path
        .join(format!("{}_fc.hdr", datetime));
```

with:

```rust
    let luminance_file_name = config_settings
        .output_path
        .join(format!("{stem}_fc.hdr"));
```

- [ ] **Step 7: Use the completion message**

In the final `emit_status` call, replace:

```rust
            message: Some("Pipeline complete.".to_string()),
```

with:

```rust
            message: Some(completion_message(&set_name)),
```

- [ ] **Step 8: Build and test**

Run: `cd src-tauri && cargo fmt && cargo test`
Expected: PASS, previous count plus 8.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/pipeline/output_naming.rs src-tauri/src/pipeline.rs
git commit -m "feat(pipeline): name outputs after the image set"
```

---

### Task 3: Send the set name from the frontend

`buildPipelineParams` is the only place the Tauri payload is built, and it is also what the run history stores verbatim. The argument is required rather than optional so the compiler names every call site that has to decide what the set is called.

**Files:**
- Modify: `src/app/home-page/build-pipeline-params.ts`
- Test: `__tests__/build-pipeline-params.test.ts`

**Interfaces:**
- Consumes: Task 2's `set_name` parameter.
- Produces: `buildPipelineParams(data: pipelineConfig, settings: PipelineToolSettings, inputImages: string[], setName: string)`, whose return object now contains `setName: string`. Tasks 7 and 8 call it with a set's `name`.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/build-pipeline-params.test.ts`, inside the existing `describe("buildPipelineParams", …)`:

```ts
  it("forwards the set name so the output can be named after it", () => {
    const params = buildPipelineParams(config, settings, ["a.jpg"], "kitchen");

    expect(params.setName).toBe("kitchen");
  });

  // A single scene has no set to name, and Rust falls back to the plain
  // timestamp, which is what the app produced before batches existed.
  it("forwards an empty name unchanged", () => {
    const params = buildPipelineParams(config, settings, ["a.jpg"], "");

    expect(params.setName).toBe("");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest build-pipeline-params`
Expected: FAIL, `Expected: "kitchen"  Received: undefined`.

- [ ] **Step 3: Add the parameter**

In `src/app/home-page/build-pipeline-params.ts`, change the signature:

```ts
export function buildPipelineParams(
  data: pipelineConfig,
  settings: PipelineToolSettings,
  inputImages: string[],
  setName: string
) {
```

and add the key to the returned object, between `scaleLimit` and `verticalAngle` so the alphabetical ordering Biome enforces is preserved:

```ts
    scaleLimit: "",
    setName,
    verticalAngle: data.fisheyeView.verticalViewDegrees,
```

Extend the function's doc comment with a sentence on why the name is not sanitised here:

```ts
 * `setName` is passed through as the user typed or as the directory was named.
 * It becomes part of a filename, so it is sanitised in Rust where the file is
 * written rather than here, where a caller could bypass it.
```

- [ ] **Step 4: Update the five existing call sites in the test file**

Every existing call in `__tests__/build-pipeline-params.test.ts` passes three arguments and must now pass four. Add `, ""` to each:

```ts
    const params = buildPipelineParams(config, settings, ["a.jpg"], "");
```

and, for the two multi-line calls:

```ts
    const params = buildPipelineParams(
      { ...config, fisheyeView: { ...config.fisheyeView, projection: "vth" } },
      settings,
      ["a.jpg"],
      ""
    );
```

```ts
    const params = buildPipelineParams(
      { ...config, validityCheck: { measuredVerticalIlluminanceLux: 1240 } },
      settings,
      ["a.jpg"],
      ""
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest build-pipeline-params && npx tsc --noEmit`
Expected: jest PASS (7 tests). `tsc` will report two errors in `src/app/home-page/page.tsx` for its own three-argument calls; those are fixed in Task 7 and are expected here. Note them and continue.

- [ ] **Step 6: Commit**

```bash
git add src/app/home-page/build-pipeline-params.ts __tests__/build-pipeline-params.test.ts
git commit -m "feat(pipeline): send the set name in the pipeline payload"
```

---

### Task 4: The batch loop, isolated

This is where the behaviour of the feature lives: does a failure stop the queue, does Stop take effect at the right boundary, is the order right, is a single set still handled exactly as before. Isolating it from React and Tauri makes each of those a unit test.

**Files:**
- Create: `src/app/home-page/run-batch.ts`
- Test: `__tests__/run-batch.test.ts`

**Interfaces:**
- Consumes: `ImageSet` from `@/components/ui/image-set-preview` (shape `{ files: string[]; name: string }`).
- Produces:
  - `interface SetPosition { position: number; set: ImageSet; total: number }`: `position` is 1-based.
  - `interface BatchSummary { failed: number; skipped: number; succeeded: number; total: number }`
  - `async function runBatch(options: { onBeginSet?: (at: SetPosition) => void; runSet: (at: SetPosition) => Promise<void>; sets: ImageSet[]; shouldStop?: () => boolean }): Promise<BatchSummary>`
  - Task 7 supplies `runSet` and `shouldStop`; Task 5's `beginSet` is what `onBeginSet` calls.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/run-batch.test.ts`:

```ts
import { describe, expect, it, jest } from "@jest/globals";
import type { ImageSet } from "../src/components/ui/image-set-preview";
import { runBatch } from "../src/app/home-page/run-batch";

function set(name: string): ImageSet {
  return { files: [`${name}/a.jpg`, `${name}/b.jpg`], name };
}

describe("runBatch", () => {
  it("runs every set, in order", async () => {
    const ran: string[] = [];

    const summary = await runBatch({
      runSet: async ({ set: current }) => {
        ran.push(current.name);
      },
      sets: [set("one"), set("two"), set("three")],
    });

    expect(ran).toEqual(["one", "two", "three"]);
    expect(summary).toEqual({
      failed: 0,
      skipped: 0,
      succeeded: 3,
      total: 3,
    });
  });

  // The point of the whole change: one bad directory must not cost an
  // overnight batch the other nine.
  it("carries on past a failing set and counts it as failed", async () => {
    const ran: string[] = [];

    const summary = await runBatch({
      runSet: async ({ set: current }) => {
        ran.push(current.name);
        if (current.name === "two") {
          throw new Error("hdrgen exited 1");
        }
      },
      sets: [set("one"), set("two"), set("three")],
    });

    expect(ran).toEqual(["one", "two", "three"]);
    expect(summary).toEqual({
      failed: 1,
      skipped: 0,
      succeeded: 2,
      total: 3,
    });
  });

  it("abandons the remaining sets when stopping is requested", async () => {
    const ran: string[] = [];
    let stop = false;

    const summary = await runBatch({
      runSet: async ({ set: current }) => {
        ran.push(current.name);
        if (current.name === "one") {
          stop = true;
        }
      },
      sets: [set("one"), set("two"), set("three")],
      shouldStop: () => stop,
    });

    expect(ran).toEqual(["one"]);
    expect(summary).toEqual({
      failed: 0,
      skipped: 2,
      succeeded: 1,
      total: 3,
    });
  });

  // Stopping is a boundary, not an abort: a set that is already merging
  // exposures finishes rather than leaving a half-written output.
  it("lets a set that is already running finish", async () => {
    const finished: string[] = [];
    let stop = false;

    await runBatch({
      runSet: async ({ set: current }) => {
        stop = true;
        await Promise.resolve();
        finished.push(current.name);
      },
      sets: [set("one"), set("two")],
      shouldStop: () => stop,
    });

    expect(finished).toEqual(["one"]);
  });

  it("announces each set before running it, with its position in the batch", async () => {
    const onBeginSet =
      jest.fn<(at: { position: number; total: number }) => void>();

    await runBatch({
      onBeginSet,
      runSet: () => Promise.resolve(),
      sets: [set("one"), set("two")],
    });

    expect(onBeginSet.mock.calls.map(([at]) => at.position)).toEqual([1, 2]);
    expect(onBeginSet.mock.calls.every(([at]) => at.total === 2)).toBe(true);
  });

  // A single set is the overwhelmingly common case and must not have gained
  // any batch machinery: one call, and a summary the caller can stay quiet
  // about.
  it("treats a single set as one plain run", async () => {
    const runSet = jest.fn<() => Promise<void>>(() => Promise.resolve());

    const summary = await runBatch({ runSet, sets: [set("only")] });

    expect(runSet).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      failed: 0,
      skipped: 0,
      succeeded: 1,
      total: 1,
    });
  });

  it("does nothing when there are no sets", async () => {
    const runSet = jest.fn<() => Promise<void>>(() => Promise.resolve());

    const summary = await runBatch({ runSet, sets: [] });

    expect(runSet).not.toHaveBeenCalled();
    expect(summary).toEqual({
      failed: 0,
      skipped: 0,
      succeeded: 0,
      total: 0,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest run-batch`
Expected: FAIL, `Cannot find module '../src/app/home-page/run-batch'`.

- [ ] **Step 3: Write the implementation**

Create `src/app/home-page/run-batch.ts`:

```ts
import type { ImageSet } from "@/components/ui/image-set-preview";

/** Where a set sits in the batch. `position` is 1-based, as shown to the user. */
export interface SetPosition {
  position: number;
  set: ImageSet;
  total: number;
}

export interface BatchSummary {
  failed: number;
  /** Sets that were never begun, because stopping was requested first. */
  skipped: number;
  succeeded: number;
  total: number;
}

/**
 * Runs each image set in turn, reporting what happened to each.
 *
 * Deliberately free of React and Tauri. The risk in batching is control flow,
 * not wiring: whether a failure stops the queue, whether Stop takes effect at
 * the right boundary, whether a single set still behaves exactly as it did
 * before. Keeping that here makes each of those a unit test rather than
 * something only reproducible with ten real directories and a twenty-minute
 * run.
 *
 * `runSet` is expected to report a set's own outcome, since only the caller
 * knows how to record and display one. Throwing is how it says the set failed;
 * the queue carries on either way.
 *
 * `shouldStop` is read between sets and never during one. Cancelling a set in
 * flight would mean killing Radiance and hdrgen child processes, which is a
 * separate piece of work; stopping at a boundary is what makes an overnight
 * batch recoverable without discarding what it already produced.
 */
export async function runBatch({
  onBeginSet,
  runSet,
  sets,
  shouldStop,
}: {
  onBeginSet?: (at: SetPosition) => void;
  runSet: (at: SetPosition) => Promise<void>;
  sets: ImageSet[];
  shouldStop?: () => boolean;
}): Promise<BatchSummary> {
  let failed = 0;
  let started = 0;
  let succeeded = 0;

  for (const [index, set] of sets.entries()) {
    if (shouldStop?.()) {
      break;
    }

    const at: SetPosition = { position: index + 1, set, total: sets.length };
    started += 1;
    onBeginSet?.(at);

    try {
      // biome-ignore lint/performance/noAwaitInLoops: the sets must run one at a time. They share the pipeline's tmp directory and compete for the same external binaries, and running them concurrently would interleave the progress and log events the console reports.
      await runSet(at);
      succeeded += 1;
    } catch {
      // The error itself is the caller's to report, against the set it belongs
      // to. All that is decided here is that the queue continues.
      failed += 1;
    }
  }

  return { failed, skipped: sets.length - started, succeeded, total: sets.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest run-batch`
Expected: PASS, 7 tests.

- [ ] **Step 5: Check formatting and types**

Run: `npx ultracite check src/app/home-page/run-batch.ts __tests__/run-batch.test.ts && npx tsc --noEmit`
Expected: lint clean. `tsc` still reports the two `page.tsx` errors from Task 3; nothing new.

- [ ] **Step 6: Commit**

```bash
git add src/app/home-page/run-batch.ts __tests__/run-batch.test.ts
git commit -m "feat(home): add the batch loop, isolated from React and Tauri"
```

---

### Task 5: Announce each set in the status context

The context already holds `setIndex` and `setTotal`, written today only from Rust payloads that no longer arrive now that the directory path is gone. The loop writes them instead. It also resets progress, because Rust emits `Done` with 100 percent at the end of every set and the bar would otherwise sit full while the next set merged exposures.

**Files:**
- Modify: `src/app/pipeline-status-context.tsx`
- Test: `__tests__/pipeline-status-log.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `beginSet(position: number, total: number, name: string): void` on the value returned by `usePipelineStatus()`. Task 7 calls it from `onBeginSet`.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/pipeline-status-log.test.tsx`. It needs a component that can call `beginSet` and show the state, so add this next to the existing `LogView`:

```tsx
function BatchView() {
  const { beginSet, log, progress, setIndex, setTotal, statusText } =
    usePipelineStatus();
  return (
    <div>
      <button onClick={() => beginSet(2, 3, "kitchen")} type="button">
        begin
      </button>
      <p data-testid="position">
        {setIndex} of {setTotal}
      </p>
      <p data-testid="progress">{progress}</p>
      <p data-testid="status">{statusText}</p>
      <ul>
        {log.map((entry) => (
          <li key={`${entry.at}-${entry.message}`}>{entry.message}</li>
        ))}
      </ul>
    </div>
  );
}
```

and this `describe` block:

```tsx
describe("beginning a set", () => {
  async function renderBatch() {
    await act(() => {
      render(
        <PipelineStatusProvider>
          <BatchView />
        </PipelineStatusProvider>
      );
      return Promise.resolve();
    });
  }

  it("records the set's position in the batch", async () => {
    await renderBatch();

    act(() => {
      screen.getByRole("button", { name: "begin" }).click();
    });

    expect(screen.getByTestId("position")).toHaveTextContent("2 of 3");
    expect(screen.getByText("Processing set 2 of 3: kitchen")).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent(
      "Processing set 2 of 3: kitchen"
    );
  });

  // Rust emits a Done event at 100 percent at the end of every set, so without
  // this the bar would sit full for the whole of the next set.
  it("returns the bar to zero for the new set", async () => {
    await renderBatch();

    act(() => {
      emit("pipeline-status", { kind: "done", progress: 100, message: "done" });
    });
    expect(screen.getByTestId("progress")).toHaveTextContent("100");

    act(() => {
      screen.getByRole("button", { name: "begin" }).click();
    });

    expect(screen.getByTestId("progress")).toHaveTextContent("0");
  });

  // The console shows the whole batch, so earlier sets' transcripts stay.
  it("keeps the transcript of the sets that already ran", async () => {
    await renderBatch();

    act(() => {
      emit("pipeline-status", { kind: "step", message: "Merging exposures" });
    });
    act(() => {
      screen.getByRole("button", { name: "begin" }).click();
    });

    expect(screen.getByText("Merging exposures")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest pipeline-status-log`
Expected: FAIL, `beginSet is not a function`.

- [ ] **Step 3: Add `beginSet` to the provider**

In `src/app/pipeline-status-context.tsx`, add to the context type, in alphabetical position at the top of the interface:

```ts
interface PipelineStatusContextValue {
  /**
   * Announces the set the frontend is about to run.
   *
   * Batching is a frontend loop over single-scene runs, so nothing in Rust
   * knows a set's position any more. Progress is returned to zero because the
   * backend reports a run finishing at the end of every set.
   */
  beginSet: (position: number, total: number, name: string) => void;
  clearLog: () => void;
```

Add the implementation next to `clearLog`:

```ts
  const beginSet = useCallback(
    (position: number, total: number, name: string) => {
      const message = `Processing set ${position} of ${total}: ${name}`;
      setSetIndex(position);
      setSetTotal(total);
      setProgress(0);
      setStatusText(message);
      setLog((entries) => [
        ...entries,
        {
          at: new Date().toISOString(),
          kind: "step",
          message,
          step: "image_set",
        },
      ]);
    },
    []
  );
```

Add `beginSet` to the `useMemo` value object and to its dependency array, in both cases as the first entry so the alphabetical ordering holds:

```ts
  const value = useMemo(
    () => ({
      beginSet,
      clearLog,
      // …
    }),
    [
      beginSet,
      clearLog,
      // …
    ]
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest pipeline-status-log`
Expected: PASS, the existing tests plus 3.

- [ ] **Step 5: Commit**

```bash
git add src/app/pipeline-status-context.tsx __tests__/pipeline-status-log.test.tsx
git commit -m "feat(pipeline): announce each set from the frontend loop"
```

---

### Task 6: One pre-run dialog covering both concerns

A second dialog for the shared-settings notice would mean answering two prompts to start one run, so the existing calibration dialog is generalised. #183's wording is a regression lock: a single set with incomplete calibration files must produce exactly today's dialog, and the six existing tests carry across unchanged to hold that.

**Files:**
- Rename: `src/app/home-page/calibration-confirm-dialog.tsx` to `src/app/home-page/run-confirm-dialog.tsx`
- Rename: `__tests__/calibration-confirm-dialog.test.tsx` to `__tests__/run-confirm-dialog.test.tsx`

**Interfaces:**
- Consumes: `usePendingConfirmation<T>` (unchanged; its subject simply becomes a richer object).
- Produces:
  - `interface RunConfirmation { setCount: number; unsupplied: string[] }`
  - `function describeRunConfirmation(setCount: number, unsupplied: string[]): RunConfirmation | null`: null means there is nothing to ask about.
  - `function RunConfirmDialog({ confirmation, onDecision }: { confirmation: RunConfirmation | null; onDecision: (proceed: boolean) => void })`
  - Task 7 renders it and calls `describeRunConfirmation`.

The behaviour, which is the spec's table:

| Sets | Calibration | Dialog |
|---|---|---|
| 1 | complete | none |
| 1 | incomplete | today's wording, unchanged |
| many | complete | shared-settings notice |
| many | incomplete | both, in one dialog |

- [ ] **Step 1: Rename both files, preserving history**

```bash
git mv src/app/home-page/calibration-confirm-dialog.tsx src/app/home-page/run-confirm-dialog.tsx
git mv __tests__/calibration-confirm-dialog.test.tsx __tests__/run-confirm-dialog.test.tsx
```

- [ ] **Step 2: Rewrite the test file**

Replace the whole contents of `__tests__/run-confirm-dialog.test.tsx`. The first `describe` is the six existing tests, adapted only in how they call the component: their assertions are unchanged, because a single incomplete set must look exactly as it does today.

```tsx
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  describeRunConfirmation,
  type RunConfirmation,
  RunConfirmDialog,
} from "../src/app/home-page/run-confirm-dialog";

const TITLE = /Not all calibration files have been uploaded/i;
const GO_BACK = /Go back/i;
const GENERATE_ANYWAY = /Generate anyway/i;
const GENERATE_ALL = /Generate all/i;
const MISSING = /missing/i;
const SHARED = /same settings/i;

function renderDialog(confirmation: RunConfirmation | null) {
  const onDecision = jest.fn<(proceed: boolean) => void>();
  render(
    <RunConfirmDialog confirmation={confirmation} onDecision={onDecision} />
  );
  return onDecision;
}

function oneSetMissing(unsupplied: string[]): RunConfirmation {
  return { setCount: 1, unsupplied };
}

describe("RunConfirmDialog, one set", () => {
  it("stays closed when there is nothing to ask about", () => {
    renderDialog(null);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The point of #183: the files may have been left out deliberately, so the
  // copy must not accuse the user of forgetting them.
  it("does not describe the files as missing", () => {
    renderDialog(oneSetMissing(["Camera response"]));

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.queryByText(MISSING)).toBeNull();
  });

  it("lists the files that were left out", () => {
    renderDialog(
      oneSetMissing(["Vignetting correction", "Calibration factor"])
    );

    expect(screen.getByText("Vignetting correction")).toBeInTheDocument();
    expect(screen.getByText("Calibration factor")).toBeInTheDocument();
  });

  it("reports going back so the run is abandoned", () => {
    const onDecision = renderDialog(oneSetMissing(["Camera response"]));

    fireEvent.click(screen.getByRole("button", { name: GO_BACK }));

    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("reports proceeding so a deliberate choice is honoured", () => {
    const onDecision = renderDialog(oneSetMissing(["Camera response"]));

    fireEvent.click(screen.getByRole("button", { name: GENERATE_ANYWAY }));

    expect(onDecision).toHaveBeenCalledWith(true);
  });

  // Dismissing is not an instruction to run the pipeline.
  it("treats Escape as going back", () => {
    const onDecision = renderDialog(oneSetMissing(["Camera response"]));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onDecision).toHaveBeenCalledWith(false);
  });

  // One set with everything supplied must not gain a prompt it never had.
  it("says nothing about shared settings", () => {
    renderDialog(oneSetMissing(["Camera response"]));

    expect(screen.queryByText(SHARED)).toBeNull();
  });
});

describe("RunConfirmDialog, several sets", () => {
  it("says how many sets will run and that the settings are shared", () => {
    renderDialog({ setCount: 4, unsupplied: [] });

    expect(screen.getByText(/Generate 4 HDR images\?/i)).toBeInTheDocument();
    expect(screen.getByText(SHARED)).toBeInTheDocument();
    expect(screen.getByText(/Lens mask/i)).toBeInTheDocument();
    expect(screen.getByText(/view angles/i)).toBeInTheDocument();
    expect(screen.getByText(/Target resolution/i)).toBeInTheDocument();
    expect(screen.getByText(/Calibration files/i)).toBeInTheDocument();
  });

  it("confirms with a label that matches what is about to happen", () => {
    const onDecision = renderDialog({ setCount: 4, unsupplied: [] });

    fireEvent.click(screen.getByRole("button", { name: GENERATE_ALL }));

    expect(onDecision).toHaveBeenCalledWith(true);
  });

  // Answering two prompts to start one run is what this dialog exists to
  // avoid, so both concerns appear together and #183's wording survives.
  it("asks about calibration in the same dialog, in the agreed words", () => {
    renderDialog({ setCount: 4, unsupplied: ["Camera response"] });

    expect(screen.getByText(SHARED)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Not all calibration files have been uploaded. Did you mean to not upload them all, or do you want to go back?"
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Camera response")).toBeInTheDocument();
  });
});

describe("describeRunConfirmation", () => {
  it("has nothing to ask about one complete set", () => {
    expect(describeRunConfirmation(1, [])).toBeNull();
  });

  it("asks about one set with a calibration file left out", () => {
    expect(describeRunConfirmation(1, ["Camera response"])).toEqual({
      setCount: 1,
      unsupplied: ["Camera response"],
    });
  });

  it("asks about several complete sets", () => {
    expect(describeRunConfirmation(3, [])).toEqual({
      setCount: 3,
      unsupplied: [],
    });
  });

  it("asks about several sets with a calibration file left out", () => {
    expect(describeRunConfirmation(3, ["Camera response"])).toEqual({
      setCount: 3,
      unsupplied: ["Camera response"],
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest run-confirm-dialog`
Expected: FAIL, `RunConfirmDialog is not exported` / `describeRunConfirmation is not a function`.

- [ ] **Step 4: Rewrite the component**

Replace the whole contents of `src/app/home-page/run-confirm-dialog.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** What a pre-run dialog has to say. */
export interface RunConfirmation {
  setCount: number;
  unsupplied: string[];
}

/**
 * Decides whether there is anything to ask before a run starts, and what.
 *
 * Two things are worth confirming and neither is worth its own prompt:
 * answering two dialogs to start one run is worse than reading two paragraphs
 * in one. Null means go straight to the pipeline.
 */
export function describeRunConfirmation(
  setCount: number,
  unsupplied: string[]
): RunConfirmation | null {
  if (setCount > 1 || unsupplied.length > 0) {
    return { setCount, unsupplied };
  }
  return null;
}

// #183 settled this phrasing. It avoids calling the files "missing": the user
// may well have meant to leave them out, and telling someone they forgot
// something they did on purpose reads as a bug in the app rather than a
// question. Kept as constants so the batch variant reuses the exact words
// rather than a paraphrase of them.
const CALIBRATION_TITLE = "Not all calibration files have been uploaded";
const CALIBRATION_QUESTION =
  "Did you mean to not upload them all, or do you want to go back?";

/**
 * Asks whatever needs asking before a run starts.
 *
 * `confirmation` doubles as the open flag. The dialog has no opinion on when it
 * should be shown, and a caller with nothing to ask about has nothing to pass.
 */
export function RunConfirmDialog({
  confirmation,
  onDecision,
}: {
  confirmation: RunConfirmation | null;
  onDecision: (proceed: boolean) => void;
}) {
  const setCount = confirmation?.setCount ?? 1;
  const unsupplied = confirmation?.unsupplied ?? [];
  const batch = setCount > 1;
  const incomplete = unsupplied.length > 0;

  return (
    <Dialog
      // Escape and the overlay both close the dialog. Neither is an
      // instruction to run the pipeline, so both mean go back.
      onOpenChange={(open) => {
        if (!open) {
          onDecision(false);
        }
      }}
      open={confirmation !== null}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {batch ? `Generate ${setCount} HDR images?` : CALIBRATION_TITLE}
          </DialogTitle>
          <DialogDescription>
            {batch
              ? `The same settings on this page are applied to all ${setCount} sets.`
              : CALIBRATION_QUESTION}
          </DialogDescription>
        </DialogHeader>

        {batch ? (
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
            <li>Lens mask position and radius</li>
            <li>Fisheye view angles and projection</li>
            <li>Target resolution</li>
            <li>Calibration files</li>
          </ul>
        ) : null}

        {incomplete ? (
          <div className="space-y-2">
            {/* Repeated in full for a batch, where the title is about the
                sets rather than the files. */}
            {batch ? (
              <p className="font-medium text-sm">
                {`${CALIBRATION_TITLE}. ${CALIBRATION_QUESTION}`}
              </p>
            ) : null}
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
              {unsupplied.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              The pipeline skips the stage each of these would have driven, so
              the output will not be corrected for them.
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button onClick={() => onDecision(false)} variant="outline">
            Go back
          </Button>
          <Button onClick={() => onDecision(true)}>
            {batch ? "Generate all" : "Generate anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest run-confirm-dialog`
Expected: PASS, 15 tests. If the `SHARED` regex (`/same settings/i`) does not match, check the description copy rather than loosening the regex: that phrase is the notice the user asked for.

- [ ] **Step 6: Commit**

The old import in `page.tsx` is now broken; Task 7 fixes it. Commit anyway so the dialog change is reviewable on its own, and note the breakage in the message.

```bash
git add src/app/home-page/run-confirm-dialog.tsx __tests__/run-confirm-dialog.test.tsx
git commit -m "feat(home): one pre-run dialog for shared settings and calibration

page.tsx still imports the old name and is updated in the next commit."
```

---

### Task 7: Run every set from the submit handler

This replaces `const [imageSet] = data.inputSets`. Three attribution details matter and all three are wrong today for anything but a single set: `getOutputs()` accumulates across the whole run, so a record built from it lists earlier sets' files; `setImageSetIssues({ 0: … })` hardcodes the first row, so a failure on set 3 annotates set 1; and `setProgressVisible(false)` on failure would tear down the progress bar while the rest of the batch is still running.

**Files:**
- Modify: `src/app/home-page/page.tsx`

**Interfaces:**
- Consumes: `runBatch`, `SetPosition` (Task 4); `beginSet` (Task 5); `RunConfirmDialog`, `describeRunConfirmation`, `RunConfirmation` (Task 6); `buildPipelineParams(…, setName)` (Task 3).
- Produces: `stopRequestedRef`, `requestStop`, `batchInFlight` and `stopRequested` in `Home`, which Task 8 passes to `PipelineStatus`.

- [ ] **Step 1: Update the imports**

In `src/app/home-page/page.tsx`, add `useCallback` to the React import:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

Replace the dialog import:

```tsx
import { CalibrationConfirmDialog } from "./calibration-confirm-dialog";
```

with:

```tsx
import {
  describeRunConfirmation,
  type RunConfirmation,
  RunConfirmDialog,
} from "./run-confirm-dialog";
```

and add, in alphabetical position among the local imports:

```tsx
import { runBatch, type SetPosition } from "./run-batch";
```

- [ ] **Step 2: Add the run-state hooks**

Replace:

```tsx
  const [progressVisible, setProgressVisible] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const { clearLog, getOutputs, log } = usePipelineStatus();
```

with:

```tsx
  const [progressVisible, setProgressVisible] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const { beginSet, clearLog, getOutputs, log, setTotal } =
    usePipelineStatus();

  // Whether a run is in flight, held explicitly rather than inferred from the
  // progress bar. The backend reports a run finishing at the end of every set,
  // so between sets the bar reads 100 while the batch is still going.
  const [batchInFlight, setBatchInFlight] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  // Read by the loop between sets, from a closure created before the button
  // was ever pressed, so it cannot be the state value.
  const stopRequestedRef = useRef(false);
  const requestStop = useCallback(() => {
    stopRequestedRef.current = true;
    setStopRequested(true);
  }, []);
```

- [ ] **Step 3: Rename the confirmation hook's bindings**

Replace:

```tsx
  const {
    ask: confirmIncompleteCalibration,
    decide: decideCalibration,
    subject: unsuppliedCalibration,
  } = usePendingConfirmation<string[]>();
```

with:

```tsx
  const {
    ask: confirmRun,
    decide: decideRun,
    subject: runConfirmation,
  } = usePendingConfirmation<RunConfirmation>();
```

- [ ] **Step 4: Give `recordAttempt` a set to attribute the record to**

Replace the whole `recordAttempt` definition inside the submit handler:

```tsx
            const recordAttempt = (
              failure: string | null,
              outputPaths: string[],
              files: string[]
            ) =>
              appendRun({
                finishedAt: new Date().toISOString(),
                id: startedAt,
                inputs: buildPipelineParams(
                  data,
                  toolSettings,
                  files
                ) as unknown as Record<string, unknown>,
```

with:

```tsx
            // One record per set. `startedAt` is the batch's, so a night's
            // work groups together on the Runs page, and the position keeps
            // the ids distinct.
            const recordAttempt = (
              failure: string | null,
              outputPaths: string[],
              files: string[],
              setName: string,
              position: number
            ) =>
              appendRun({
                finishedAt: new Date().toISOString(),
                id: `${startedAt}-${position}`,
                inputs: buildPipelineParams(
                  data,
                  toolSettings,
                  files,
                  setName
                ) as unknown as Record<string, unknown>,
```

Leave the rest of the object as it is.

- [ ] **Step 5: Add the per-set failure reporter**

Immediately after the `recordAttempt` definition, still inside the submit handler, add:

```tsx
            // Reports one set's failure against that set, and only that set.
            // The batch carries on, so nothing here may tear down the progress
            // UI or clear another set's annotation.
            const reportSetFailure = async (
              error: unknown,
              position: number,
              params: Record<string, unknown>
            ) => {
              const knownHdrgenIssue = getKnownHdrgenIssue(error);
              if (knownHdrgenIssue) {
                // Keyed by array index, because that is how ImageMatrixInput
                // maps its rows. The only place a position is converted.
                setImageSetIssues((issues) => ({
                  ...issues,
                  [position - 1]: knownHdrgenIssue,
                }));
                toast.error("HDRGen could not merge the selected image set.", {
                  icon: <AlertTriangle className="size-4 text-red-500" />,
                });
                return;
              }

              let tracePath: string | null = null;
              try {
                tracePath = await writePipelineTrace(
                  params,
                  error,
                  settings.outputPath
                );
              } catch (traceError) {
                toast.error(`Failed to write pipeline trace: ${traceError}`);
              }
              const toastMessage = tracePath
                ? "Pipeline failed. Trace saved. (Send this file to a maintainer)"
                : "Pipeline failed. Trace could not be saved.";
              toast.error(toastMessage, {
                action: tracePath
                  ? {
                      label: "Show in folder",
                      onClick: () =>
                        toast.promise(revealItemInDir(tracePath), {
                          error: "Failed to reveal in folder",
                          loading: "Revealing in folder...",
                          success: "Revealed in folder",
                        }),
                    }
                  : undefined,
                icon: <AlertTriangle className="size-4 text-red-500" />,
              });
            };
```

- [ ] **Step 6: Update the pre-flight rejections**

Replace:

```tsx
            const maskSize = (await maskPreviewMetadata)?.size ?? null;
            const blocker = describeRunBlocker(data, maskSize);
            if (blocker) {
              toast.error(blocker);
              recordAttempt(blocker, [], []);
              return;
            }
```

with:

```tsx
            const maskSize = (await maskPreviewMetadata)?.size ?? null;
            // Runs once, against the global configuration, because that is
            // what every set is run with. Deliberately not per set: the mask
            // is checked against the selected preview image only, and
            // validating each set's own dimensions is separate work.
            const blocker = describeRunBlocker(data, maskSize);
            if (blocker) {
              toast.error(blocker);
              await recordAttempt(blocker, [], [], "", 1);
              return;
            }

            const sets = data.inputSets;
            if (sets.length === 0) {
              await recordAttempt("No image set selected.", [], [], "", 1);
              return;
            }
```

- [ ] **Step 7: Replace the confirmation block**

Replace:

```tsx
            // The only check that asks rather than
            // refuses: skipping a calibration file is a legitimate choice, so
            // this confirms intent instead of blocking. Everything above is a
            // value the pipeline cannot run with at all.
            const unsupplied = unsuppliedCalibrationFiles(data);
            if (
              unsupplied.length > 0 &&
              !(await confirmIncompleteCalibration(unsupplied))
            ) {
              recordAttempt(
                `Cancelled: ${unsupplied.join(", ")} not uploaded.`,
                [],
                []
              );
              return;
            }
```

with:

```tsx
            // The only check that asks rather than refuses. Skipping a
            // calibration file is a legitimate choice, and so is applying one
            // set of settings to ten directories; both are worth stating and
            // neither is worth blocking.
            const unsupplied = unsuppliedCalibrationFiles(data);
            const confirmation = describeRunConfirmation(
              sets.length,
              unsupplied
            );
            if (confirmation && !(await confirmRun(confirmation))) {
              await recordAttempt(
                unsupplied.length > 0
                  ? `Cancelled: ${unsupplied.join(", ")} not uploaded.`
                  : "Cancelled before starting.",
                [],
                [],
                "",
                1
              );
              return;
            }
```

- [ ] **Step 8: Replace the single-set run with the loop**

Delete the block that starts at the comment `// TODO: implement batch processing` and ends with the closing `});` of the `invoke<string>("pipeline", params)` promise chain, which is the whole `.then(…)` and `.catch(async (error) => {…})` (currently `page.tsx:379-450`, ending just before the `},` that closes the submit callback). The `getKnownHdrgenIssue` and `writePipelineTrace` handling inside that `.catch` has already been reproduced in `reportSetFailure` in step 5, so it is deleted here rather than moved.

Put this in its place:

```tsx
            setImageSetIssues({});
            setProgressVisible(true);
            // A new run starts a fresh transcript. Called once, not per set:
            // it also resets the output paths the records are built from, and
            // the console shows the whole batch.
            clearLog();
            setConsoleOpen(true);
            stopRequestedRef.current = false;
            setStopRequested(false);
            setBatchInFlight(true);

            const summary = await runBatch({
              onBeginSet: ({ position, set, total }: SetPosition) =>
                beginSet(position, total, set.name),
              runSet: async ({ position, set }: SetPosition) => {
                // The outputs are accumulated across the whole run, so a set's
                // own are the ones appended while it was running.
                const outputsBefore = getOutputs().length;
                const params = buildPipelineParams(
                  data,
                  toolSettings,
                  set.files,
                  set.name
                );
                try {
                  await invoke<string>("pipeline", params);
                  await recordAttempt(
                    null,
                    getOutputs().slice(outputsBefore),
                    set.files,
                    set.name,
                    position
                  );
                } catch (error) {
                  // Normally empty: the backend announces an output only after
                  // copying it, so a set that failed has none. Sliced anyway
                  // rather than hardcoded, so a stage that does produce a file
                  // before failing is still attributed to this set.
                  await recordAttempt(
                    String(error),
                    getOutputs().slice(outputsBefore),
                    set.files,
                    set.name,
                    position
                  );
                  await reportSetFailure(error, position, params);
                  // Rethrown so the loop counts this set as failed. It does not
                  // stop the queue.
                  throw error;
                }
              },
              sets,
              shouldStop: () => stopRequestedRef.current,
            });

            setBatchInFlight(false);

            // A single set already reported itself, through the progress bar
            // on success and a toast on failure, so it gains no summary.
            if (summary.total > 1) {
              const parts = [
                `${summary.succeeded} of ${summary.total} sets completed`,
              ];
              if (summary.skipped > 0) {
                parts.push(`${summary.skipped} not started`);
              }
              const message = `${parts.join(", ")}.`;
              if (summary.failed > 0 || summary.skipped > 0) {
                toast.warning(message);
              } else {
                toast.success(message);
              }
            }
```

- [ ] **Step 9: Update the dialog at the render site**

Replace:

```tsx
                <CalibrationConfirmDialog
                  onDecision={decideCalibration}
                  unsupplied={unsuppliedCalibration}
                />
```

with:

```tsx
                <RunConfirmDialog
                  confirmation={runConfirmation}
                  onDecision={decideRun}
                />
```

- [ ] **Step 10: Verify the build and the full suite**

Run: `npx tsc --noEmit && npx jest && npx ultracite check`
Expected: `tsc` clean (the Task 3 errors are now resolved), all jest suites pass, lint clean.

If Biome reports cognitive complexity on the submit handler, extract the summary toast into a module-level `function describeBatchSummary(summary: BatchSummary): string | null` in `run-batch.ts` (returning null for a single set) with a test per branch, rather than suppressing the rule. `setTotal` is unused until Task 8; if the linter objects, complete Task 8 before committing.

- [ ] **Step 11: Commit**

```bash
git add src/app/home-page/page.tsx
git commit -m "feat(home): run every image set, not just the first

Closes #224."
```

---

### Task 8: Stop after the current set

A batch is something you start and walk away from, so it needs a way to end it that does not discard what it has already produced. Stopping is checked between sets: cancelling one in flight would mean killing Radiance and hdrgen child processes, which is separate work.

This task also fixes what the batch broke in `PipelineStatus`. Every control there is gated on `progress !== 100`, and Rust now emits 100 at the end of every set, so mid-batch the Dismiss button and the output dropdown become enabled and Dismiss tears down the progress UI while the run continues.

**Files:**
- Modify: `src/app/home-page/pipeline-status.tsx`
- Modify: `src/app/home-page/page.tsx`

**Interfaces:**
- Consumes: `requestStop`, `batchInFlight`, `stopRequested` and `setTotal` from Task 7.
- Produces: `PipelineStatus` props `onStop: (() => void) | null`, `running: boolean`, `stopRequested: boolean`.

- [ ] **Step 1: Take run state as a prop**

In `src/app/home-page/pipeline-status.tsx`, replace the component signature:

```tsx
export function PipelineStatus({
  onFinishAcknowledgment,
  onShowConsole,
}: {
  onFinishAcknowledgment: () => void;
  onShowConsole: () => void;
}) {
  const { progress, statusText, lastEmittedOutput } = usePipelineStatus();
```

with:

```tsx
export function PipelineStatus({
  onFinishAcknowledgment,
  onShowConsole,
  onStop,
  running,
  stopRequested,
}: {
  onFinishAcknowledgment: () => void;
  onShowConsole: () => void;
  /**
   * Null when there is no later set to stop before, which is every run of a
   * single image set.
   */
  onStop: (() => void) | null;
  /**
   * Whether the run is still going. Not derived from progress: the backend
   * reports a run finishing at the end of every set, so the bar reads 100
   * between sets while the batch continues.
   */
  running: boolean;
  stopRequested: boolean;
}) {
  const { progress, statusText, lastEmittedOutput } = usePipelineStatus();
```

- [ ] **Step 2: Gate every control on `running` instead of the percentage**

In the same file, replace `{progress !== 100 && <Spinner className="size-4" />}` with:

```tsx
          {running && <Spinner className="size-4" />}
```

and each of the three `disabled={progress !== 100}` occurrences (the Dismiss `Button`, the dropdown trigger `Button`) with:

```tsx
          disabled={running}
```

- [ ] **Step 3: Add the Stop button**

Insert between the `Show log` button and the `Dismiss` button:

```tsx
        {onStop && running ? (
          <Button
            disabled={stopRequested}
            onClick={onStop}
            type="button"
            variant="outline"
          >
            {stopRequested ? "Stopping after this set" : "Stop"}
          </Button>
        ) : null}
```

- [ ] **Step 4: Pass the state from the page**

In `src/app/home-page/page.tsx`, replace:

```tsx
                  <PipelineStatus
                    onFinishAcknowledgment={() => setProgressVisible(false)}
                    onShowConsole={() => setConsoleOpen(true)}
                  />
```

with:

```tsx
                  <PipelineStatus
                    onFinishAcknowledgment={() => setProgressVisible(false)}
                    onShowConsole={() => setConsoleOpen(true)}
                    onStop={(setTotal ?? 1) > 1 ? requestStop : null}
                    running={batchInFlight}
                    stopRequested={stopRequested}
                  />
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx jest && npx ultracite check`
Expected: all clean. `__tests__/page.test.jsx` renders `Home` and must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/home-page/pipeline-status.tsx src/app/home-page/page.tsx
git commit -m "feat(home): stop a batch after the set that is running"
```

---

### Task 9: Verify against real images and record the outcome

Everything above is unit-tested, but nothing so far has run hdrgen. The spec's acceptance is a two-directory batch where one directory is deliberately broken.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-batch-processing-design.md`

- [ ] **Step 1: Run the whole suite one more time**

```bash
npx jest && npx tsc --noEmit && npx ultracite check && (cd src-tauri && cargo fmt --check && cargo test)
```
Expected: all pass.

- [ ] **Step 2: Prepare two image sets**

The real RAW bracket lives at
`/Users/ulbrical/Library/CloudStorage/GoogleDrive-ulbrical@oregonstate.edu/Shared drives/radiantlab LumiLab/examples/inputs/CR2/`.
Copy it to two scratch directories, and delete all but one exposure from the second so it cannot merge:

```bash
SRC="/Users/ulbrical/Library/CloudStorage/GoogleDrive-ulbrical@oregonstate.edu/Shared drives/radiantlab LumiLab/examples/inputs/CR2"
mkdir -p "$TMPDIR/batch-check/good" "$TMPDIR/batch-check/broken"
cp "$SRC"/*.cr2 "$TMPDIR/batch-check/good/"
cp "$SRC"/capt01.cr2 "$TMPDIR/batch-check/broken/"
ls -l "$TMPDIR/batch-check/good" "$TMPDIR/batch-check/broken"
```

- [ ] **Step 3: Run the app and check each claim**

```bash
npm run tauri dev
```

Drag both directories in, set the lens mask against the preview (the CR2 frames are 5796x3870, so the mask must fit inside that), and press Generate. Check:

1. The dialog appears, says both sets share the settings, and names the calibration files left out.
2. The console reads `Processing set 1 of 2: good`, then `Finished good.`, then `Processing set 2 of 2: broken`.
3. The progress bar returns to 0 at the start of set 2 rather than staying at 100.
4. Set 2 fails, the failure is annotated on the *broken* row and not the good one, and the batch does not stop before it reports.
5. A summary toast reads `1 of 2 sets completed.`.
6. The output directory holds `good_<datetime>.hdr` and `good_<datetime>_fc.hdr`, and nothing named after `broken`.
7. The Runs page shows two records, one success and one failure, and the successful one lists only the good set's outputs.
8. The two records have distinct ids. This is the spec's "N sets write N run records with distinct ids" check, and it is verified here rather than in jsdom, because the id is assembled in the submit handler and reaching it in a test would mean driving react-hook-form's file inputs. Read them directly:

History is written under `appConfigDir()`, which on macOS is `~/Library/Application Support/<identifier>` with the identifier from `src-tauri/tauri.conf.json`:

```bash
python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print([r['id'] for r in d['runs']])" \
  ~/Library/Application\ Support/hdricalibrationinterface/history/runs.json
```

Expected: two ids ending `-1` and `-2`, sharing a timestamp prefix. If the file is not there, locate it with `find ~/Library/Application\ Support -name runs.json`.

Then run both good directories (copy `good` to `good2`), press Stop during set 1, and check that set 1 finishes, set 2 never starts, and only one record is written.

- [ ] **Step 4: Record the result in the spec**

Change the spec's status line from:

```markdown
**Status:** approved design, not yet implemented
```

to:

```markdown
**Status:** implemented, 2026-07-28
```

and add a short note under `## Testing` recording what the manual run actually showed, including anything that did not match.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-27-batch-processing-design.md
git commit -m "docs: record the batch processing verification run"
```

---

## Known gaps this plan leaves open

Stated so a reviewer does not mistake them for oversights:

- **The temp directory is shared between sets.** Every set writes to `<output>/tmp` and overwrites the previous set's intermediates. That is harmless because the sets run strictly one at a time and each output is copied out before the next begins, but it means a failed set's intermediates are gone by the time anyone looks. Giving each set its own subdirectory is a follow-up.
- **`RunRecord.startedAt` is the batch's start, not the set's.** All of a batch's records therefore sort together on the Runs page. `finishedAt` is per set. This is the spec's choice; the id suffix is what keeps the records distinct.
- **Set names are not unique.** Rows are keyed by directory basename, so two directories with the same basename already collide in the UI. The timestamp keeps the output filenames apart.
- **Progress is per set, not batch-wide.** "Set 3 of 10" carries overall position. A batch-wide bar would have to assume every set costs the same.
- **Record writing is verified manually, not in jsdom.** Every decision the loop makes is unit-tested in `run-batch.test.ts`, but the step that turns a set's outcome into a `RunRecord` lives in the submit handler, and reaching it from a test would mean driving react-hook-form's file inputs and mocking four Tauri plugins. Task 9 step 3 checks it against real output instead. If this becomes a recurring cost, the fix is to extract the record builder from `page.tsx`, not to add a page test.
