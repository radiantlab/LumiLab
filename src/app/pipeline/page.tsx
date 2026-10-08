/**
 * Home Page Component for the LumiLab.
 *
 * This component serves as the main page for configuring and generating HDR images.
 * It integrates various subcomponents for:
 * - Image selection
 * - View and cropping settings
 * - Response and correction files
 * - Luminance configuration
 * - Process control and execution
 *
 * The component manages the main workflow for generating HDR images using the Tauri backend.
 */
"use client";

import {
  AlertTriangle,
  Aperture,
  Eclipse,
  ImageUpscale,
  InfoIcon,
  Rotate3D,
  Sun,
  SwitchCamera,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { FieldContainerAccordionTrigger } from "@/components/ui/field-accordion-trigger";
import { FileInput } from "@/components/ui/file-input";
import {
  ImageMatrixInput,
  type ImageSetIssue,
} from "@/components/ui/image-matrix-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGenericImageMetadata } from "@/lib/generic-image-metadata";
import { isTauri } from "@/lib/host/env";
import { revealFile } from "@/lib/host/reveal";
import { appendRun, classifyOutcome } from "@/lib/run-history";
import { useMotionValueFormState } from "@/lib/use-motion-value-form-state";
import { usePipelineStatus } from "../pipeline-status-context";
import { useSettingsStore } from "../stores/settings-store";
import {
  PipelineConfigProvider,
  type pipelineConfig,
} from "./(pipeline-configuration)/config-provider";
import { buildPipelineParams } from "./build-pipeline-params";
import { unsuppliedCalibrationFiles } from "./calibration-files";
import { LensMaskInput } from "./lens-mask-input";
import { useGlobalPipelineConfig } from "./pipeline-config-store";
import { PipelineStatus } from "./pipeline-status";
import { describeRunProblem } from "./preflight";
import { PresetBar } from "./preset-bar";
import { describeBatchSummary, runBatch, type SetPosition } from "./run-batch";
import {
  describeRunConfirmation,
  type RunConfirmation,
  RunConfirmDialog,
} from "./run-confirm-dialog";
import { RunConsole } from "./run-console";
import { runWasmPipeline } from "./run-wasm-pipeline";
import { useSelectedImage } from "./selected-image-context";
import { usePendingConfirmation } from "./use-pending-confirmation";

interface PipelineTrace {
  createdAt: string;
  error: unknown;
  input: Record<string, unknown>;
}

interface CommandNonZeroExitError {
  kind: "non_zero_exit";
  program: string;
  status_code?: number | null;
  stderr?: string;
}

interface PipelineCommandError {
  error: CommandNonZeroExitError;
  kind: "command";
}

const HDRGEN_FAILURE_PATTERNS = [
  "cannot solve for response function",
  "trouble finding hdr patches",
  "needs exposure calibration",
  "insufficient exposures to compute hdr image",
];

const HDRGEN_MERGE_FAILURE_MESSAGE =
  "HDRGen could not merge this image set. The selected exposures likely do not overlap enough, or HDRGen could not determine exposure calibration. Try adding more intermediate exposures or provide a camera response (.rsp) file.";

const PATH_SEPARATOR_REGEX = /[/\\]/;
const EXE_EXTENSION_REGEX = /\.exe$/;

function getProgramBaseName(program: string) {
  return program.split(PATH_SEPARATOR_REGEX).pop()?.toLowerCase() ?? "";
}

function getKnownHdrgenIssue(error: unknown): ImageSetIssue | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const pipelineError = error as Partial<PipelineCommandError>;
  if (pipelineError.kind !== "command") {
    return null;
  }
  if (!pipelineError.error || typeof pipelineError.error !== "object") {
    return null;
  }

  const commandError = pipelineError.error as Partial<CommandNonZeroExitError>;
  if (
    commandError.kind !== "non_zero_exit" ||
    typeof commandError.program !== "string"
  ) {
    return null;
  }

  if (
    getProgramBaseName(commandError.program).replace(
      EXE_EXTENSION_REGEX,
      ""
    ) !== "hdrgen"
  ) {
    return null;
  }

  const stderr =
    typeof commandError.stderr === "string" ? commandError.stderr : "";
  const normalizedStderr = stderr.toLowerCase();
  if (
    !HDRGEN_FAILURE_PATTERNS.some((pattern) =>
      normalizedStderr.includes(pattern)
    )
  ) {
    return null;
  }

  return {
    program: commandError.program,
    statusCode:
      typeof commandError.status_code === "number"
        ? commandError.status_code
        : null,
    stderr,
    summary: HDRGEN_MERGE_FAILURE_MESSAGE,
    title: "HDRGen could not merge this image set.",
  };
}

function normalizePipelineError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  if (typeof error === "string") {
    return { message: error };
  }
  return error;
}

/**
 * Writes a diagnostic trace beside the outputs when a run fails.
 *
 * Desktop only. A browser has nowhere to put it that the user would find
 * again, and silently downloading a JSON file after a failure would be
 * startling. The failure itself is still surfaced in the UI and the run log
 * either way; this is the extra detail for a bug report.
 */
async function writePipelineTrace(
  input: Record<string, unknown>,
  error: unknown,
  outputPath: string
) {
  if (!isTauri()) {
    return null;
  }
  const { documentDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
  const createdAt = new Date().toISOString();
  const baseDir = outputPath || (await join(await documentDir(), "LumiLab"));
  const traceDir = await join(baseDir, "pipeline-traces");
  await mkdir(traceDir, { recursive: true });
  const safeTimestamp = createdAt.replace(/[:.]/g, "-");
  const tracePath = await join(
    traceDir,
    `pipeline-trace-${safeTimestamp}.json`
  );
  const trace: PipelineTrace = {
    createdAt,
    error: normalizePipelineError(error),
    input,
  };
  await writeTextFile(tracePath, JSON.stringify(trace, null, 2));
  return tracePath;
}

/**
 * Main Home page component for image configuration and processing
 *
 * @returns React component with the main application interface
 */
export default function Home() {
  // since this is at the page level, it id safe to assume this is the only instance of the global pipeline config
  const globalPipelineConfig = useGlobalPipelineConfig();
  const form = useForm<pipelineConfig>({
    defaultValues: globalPipelineConfig,
  });
  const { control, register, setValue, watch } = form;
  const formValues = watch();
  // keep the global pipeline config in sync with the form values
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally depend on the stringified value rather than the object reference; react-hook-form's watch() returns a new object every render, so depending on formValues/globalPipelineConfig.set directly reruns this effect (and re-renders) every render, causing an infinite loop.
  useEffect(() => {
    globalPipelineConfig.set(formValues);
  }, [JSON.stringify(formValues)]);

  const { settings } = useSettingsStore();

  const inputSets = watch("inputSets");
  const cameraResponseLocation = watch("cameraResponseLocation");

  const { selectedImage } = useSelectedImage();
  // The mask is expressed in the pixels of this image, so its dimensions are
  // what the mask has to fit inside. Awaited in the submit handler rather than
  // read with use(), so the page never suspends on it.
  const maskPreviewMetadata = useGenericImageMetadata(selectedImage);
  const inputSetIssueResetKey = useMemo(
    () =>
      JSON.stringify({
        cameraResponseLocation,
        inputSets: inputSets?.map((set) => ({
          files: set.files,
          name: set.name,
        })),
      }),
    [inputSets, cameraResponseLocation]
  );

  const initialLensMaskX = form.getValues("lensMask.x");
  const initialLensMaskY = form.getValues("lensMask.y");
  const initialLensMaskRadius = form.getValues("lensMask.radius");

  // The mask is three numbers: a centre and a radius. It used to be four, with
  // a separate handle position the radius was derived from, which let the two
  // drift apart between the inline preview and the full-size editor.
  const centerX = useMotionValueFormState(
    initialLensMaskX,
    setValue,
    "lensMask.x"
  );
  const centerY = useMotionValueFormState(
    initialLensMaskY,
    setValue,
    "lensMask.y"
  );
  const radius = useMotionValueFormState(
    initialLensMaskRadius,
    setValue,
    "lensMask.radius"
  );

  // The image size the current mask was drawn against, carried from the preset
  // it came from so the mask input can say whether it still fits the selected
  // image.
  const [maskSourceSize, setMaskSourceSize] = useState<[number, number] | null>(
    null
  );

  // Any movement of the mask drops that provenance: once the user has placed
  // the circle against an image themselves, where it originally came from no
  // longer describes it, and a warning about the old size would be nagging
  // about something they have already dealt with.
  useEffect(() => {
    const forget = () => setMaskSourceSize(null);
    const unsubscribe = [
      centerX.on("change", forget),
      centerY.on("change", forget),
      radius.on("change", forget),
    ];
    return () => {
      for (const stop of unsubscribe) {
        stop();
      }
    };
  }, [centerX, centerY, radius]);

  const [progressVisible, setProgressVisible] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const { beginSet, clearLog, getOutputs, log, setTotal } = usePipelineStatus();

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
  // The record is written when a run ends, by which time the log has grown.
  // Capturing `log` in the submit closure would persist an empty transcript.
  const logRef = useRef(log);
  useEffect(() => {
    logRef.current = log;
  }, [log]);

  const [imageSetIssues, setImageSetIssues] = useState<
    Partial<Record<number, ImageSetIssue>>
  >({});

  // The submit handler stops here and waits for the user to answer.
  const {
    ask: confirmRun,
    decide: decideRun,
    subject: runConfirmation,
  } = usePendingConfirmation<RunConfirmation>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: inputSetIssueResetKey is a change-detection trigger (a stringified snapshot of the inputs that should reset validation issues), not a value read inside the effect body, so it can't be "added" by inlining its computation here.
  useEffect(() => {
    setImageSetIssues((currentIssues) =>
      Object.keys(currentIssues).length > 0 ? {} : currentIssues
    );
  }, [inputSetIssueResetKey]);

  return (
    <PipelineConfigProvider form={form}>
      <form
        className="flex h-full w-full divide-x overflow-auto"
        onSubmit={form.handleSubmit(
          async (data) => {
            console.log("configForm submitted", data);

            const startedAt = new Date().toISOString();
            // The log still holds the previous run's transcript at this point,
            // since clearLog only runs once the checks have passed.
            const logAtSubmit = logRef.current.length;
            const toolSettings = { outputPath: settings.outputPath };

            // Every attempt is recorded, including ones turned away before the
            // backend ran: those are the ones worth looking back at when an
            // evening's work produced nothing. Storage failures are swallowed
            // so history can never break a run. One record per set, and
            // `startedAt` is the batch's, so a night's work groups together on
            // the Runs page while the position keeps the ids distinct.
            const recordAttempt = (
              failure: string | null,
              outputPaths: string[],
              files: string[],
              setName: string,
              position: number,
              logFrom: number
            ) => {
              // Sliced for the same reason the outputs are: the transcript runs
              // for the whole batch, and a record that carried all of it would
              // let an earlier set's error classify this one as a warning.
              const runLog = logRef.current.slice(logFrom);
              return appendRun({
                finishedAt: new Date().toISOString(),
                id: `${startedAt}-${position}`,
                inputs: buildPipelineParams(
                  data,
                  toolSettings,
                  files,
                  setName
                ) as unknown as Record<string, unknown>,
                log: runLog,
                outcome: classifyOutcome(runLog, failure),
                outputs: outputPaths,
                presetName: null,
                reason: failure,
                startedAt,
              }).catch(() => undefined);
            };

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
                  icon: <AlertTriangle className="size-4 text-destructive" />,
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
                        toast.promise(revealFile(tracePath), {
                          error: "Failed to reveal in folder",
                          loading: "Revealing in folder...",
                          success: "Revealed in folder",
                        }),
                    }
                  : undefined,
                icon: <AlertTriangle className="size-4 text-destructive" />,
              });
            };

            // Undefined until an image is selected, in which case there are no
            // dimensions to check the mask against yet.
            //
            const maskSize = (await maskPreviewMetadata)?.size ?? null;
            // Runs once, against the global configuration, because that is
            // what every set is run with. Deliberately not per set: the mask
            // is checked against the selected preview image only, and
            // validating each set's own dimensions is separate work.
            // Includes the output folder, checked before the work rather than
            // after it. A missing folder used to surface as a raw filesystem
            // error once every stage had already run, throwing away the whole
            // pipeline and saying nothing about which folder was wrong.
            const problem = await describeRunProblem(
              data,
              maskSize,
              settings.outputPath
            );
            if (problem) {
              toast.error(problem);
              await recordAttempt(problem, [], [], "", 1, logAtSubmit);
              return;
            }

            const sets = data.inputSets;
            if (sets.length === 0) {
              await recordAttempt(
                "No image set selected.",
                [],
                [],
                "",
                1,
                logAtSubmit
              );
              return;
            }

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
                1,
                logAtSubmit
              );
              return;
            }

            setImageSetIssues({});
            setProgressVisible(true);
            // A new run starts a fresh transcript. Called once, not per set:
            // it also resets the output paths the records are built from, and
            // the console shows the whole batch.
            clearLog();
            // clearLog empties the outputs ref synchronously but the log ref
            // only catches up on the next commit, and the first set's baseline
            // is read in this same tick. Reset it here so the slice starts at
            // zero rather than at the previous run's length.
            logRef.current = [];
            setConsoleOpen(true);
            stopRequestedRef.current = false;
            setStopRequested(false);
            setBatchInFlight(true);

            try {
              const summary = await runBatch({
                onBeginSet: ({ position, set, total }: SetPosition) =>
                  beginSet(position, total, set.name),
                runSet: async ({ position, set }: SetPosition) => {
                  // The outputs and the transcript both accumulate across the
                  // whole run, so a set's own are the ones appended while it
                  // was running.
                  const outputsBefore = getOutputs().length;
                  const logBefore = logRef.current.length;
                  const params = buildPipelineParams(
                    data,
                    toolSettings,
                    set.files,
                    set.name
                  );
                  try {
                    await runWasmPipeline({
                      params,
                      shouldStop: () => stopRequestedRef.current,
                    });
                    await recordAttempt(
                      null,
                      getOutputs().slice(outputsBefore),
                      set.files,
                      set.name,
                      position,
                      logBefore
                    );
                  } catch (error) {
                    // Normally empty: the backend announces an output only
                    // after copying it, so a set that failed has none. Sliced
                    // anyway rather than hardcoded, so a stage that does
                    // produce a file before failing is still attributed to
                    // this set.
                    await recordAttempt(
                      String(error),
                      getOutputs().slice(outputsBefore),
                      set.files,
                      set.name,
                      position,
                      logBefore
                    );
                    await reportSetFailure(error, position, params);
                    // Rethrown so the loop counts this set as failed. It does
                    // not stop the queue.
                    throw error;
                  }
                },
                sets,
                shouldStop: () => stopRequestedRef.current,
              });

              const message = describeBatchSummary(summary);
              if (message) {
                if (summary.failed > 0 || summary.skipped > 0) {
                  toast.warning(message);
                } else {
                  toast.success(message);
                }
              }
            } finally {
              // In a finally so that anything escaping runBatch cannot strand
              // the progress UI with Dismiss disabled and no way back.
              setBatchInFlight(false);
            }
          },
          (errors) => {
            console.log("form errors", errors);
          }
        )}
      >
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="70%">
            <ImageMatrixInput
              className="flex-1 overflow-hidden"
              control={control}
              disabled={batchInFlight}
              issuesByIndex={imageSetIssues}
              name="inputSets"
              rules={{
                validate: (v) => {
                  if (!Array.isArray(v) || v.length === 0) {
                    return "At least one image set is required";
                  }

                  const i = v.findIndex((set) => set.files.length < 2);
                  if (i !== -1) {
                    return `"${v[i]?.name}" needs at least 2 images`;
                  }

                  return true;
                },
              }}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel>
            <div className="flex h-full min-h-0 flex-col bg-accent">
              <PresetBar
                form={form}
                maskImagePath={selectedImage}
                onApplyLensMask={(mask, drawnAgainst) => {
                  // Setting the motion values notifies the listener above
                  // synchronously, so the size the preset recorded is stored
                  // after them rather than being cleared by them.
                  centerX.set(mask.x);
                  centerY.set(mask.y);
                  radius.set(mask.radius);
                  setMaskSourceSize(drawnAgainst);
                }}
              />
              <Accordion
                className="min-h-0 flex-1 overflow-y-auto"
                collapsible
                type="single"
                // defaultValue="item-1"
              >
                <AccordionItem className="px-4" value="item-hdr-gen">
                  <FieldContainerAccordionTrigger
                    fields={[
                      "cameraResponseLocation",
                      "lensMask.radius",
                      "lensMask.x",
                      "lensMask.y",
                      "outputSettings.filterIrrelevantSrcImages",
                    ]}
                  >
                    HDR Generation
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-6 text-balance"
                    forceMount
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-2">
                          <Controller
                            control={control}
                            name="outputSettings.filterIrrelevantSrcImages"
                            render={({ field }) => (
                              <Checkbox
                                checked={field.value ?? false}
                                onBlur={field.onBlur}
                                onCheckedChange={(checked) =>
                                  field.onChange(Boolean(checked))
                                }
                                ref={field.ref}
                              />
                            )}
                          />
                          <Label>Keep only useful exposures</Label>
                          <InfoIcon className="size-4" />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        Some LDR images do not provide value to the HDR image
                        generation process. Checking this box will filter out
                        those images before generating the HDR image. This
                        increases accuracy but also adds a minor increase in the
                        time it takes to finish the generation process. Keeps
                        the range from the darkest frame with no black pixels
                        through the lightest frame with no white pixels
                        (tutorial §2.4.2).
                      </TooltipContent>
                    </Tooltip>
                    <div className="flex flex-col gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <FieldLabel className="items-center">
                            <SwitchCamera /> Camera response
                            <InfoIcon className="size-4" />
                          </FieldLabel>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          A camera response function is the rule that tells your
                          camera how to turn the brightness of a scene into
                          digital pixel numbers. (Important for preprocessed
                          image formats like JPEG)
                        </TooltipContent>
                      </Tooltip>
                      <FileInput
                        control={control}
                        explicitOptional
                        filters={[
                          {
                            extensions: ["rsp"],
                            name: "Camera response files",
                          },
                        ]}
                        name="cameraResponseLocation"
                        placeholder="Select or paste a .rsp file…"
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem className="px-4" value="item-crop-resize">
                  <FieldContainerAccordionTrigger
                    fields={[
                      "cameraResponseLocation",
                      "lensMask.radius",
                      "lensMask.x",
                      "lensMask.y",
                      "outputSettings.targetRes",
                      "outputSettings.filterIrrelevantSrcImages",
                    ]}
                  >
                    Cropping and Resizing
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-6 text-balance"
                    forceMount
                  >
                    <Field>
                      <FieldLabel>
                        <ImageUpscale /> Target width/height
                      </FieldLabel>
                      <Input
                        defaultValue={1000}
                        placeholder="Value in pixels"
                        type="number"
                        {...register("outputSettings.targetRes", {
                          min: {
                            message: "Target resolution must be greater than 0",
                            value: 1,
                          },
                          valueAsNumber: true,
                        })}
                      />
                      <FieldError
                        errors={[
                          form.formState.errors.outputSettings?.targetRes,
                        ]}
                      />
                    </Field>
                    <div className="flex flex-col gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <FieldLabel className="items-center">
                            <Eclipse /> Lens mask
                            <InfoIcon className="size-4" />
                          </FieldLabel>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          A circular mask applied to remove the parts of the
                          image that are obstructed by the lens.
                        </TooltipContent>
                      </Tooltip>
                      <LensMaskInput
                        centerX={centerX}
                        centerY={centerY}
                        maskPreviewImage={selectedImage}
                        maskSourceSize={maskSourceSize}
                        radius={radius}
                        register={register}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem className="px-4" value="item-correction-fisheye">
                  <FieldContainerAccordionTrigger
                    fields={["correctionFiles.fisheye"]}
                  >
                    Fisheye correction
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-4 text-balance"
                    forceMount
                  >
                    <FileInput
                      control={control}
                      explicitOptional
                      filters={[{ extensions: ["cal"], name: "Radiance CAL" }]}
                      name="correctionFiles.fisheye"
                      placeholder="Select or paste a .cal file…"
                    />
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem
                  className="px-4"
                  value="item-correction-vignetting"
                >
                  <FieldContainerAccordionTrigger
                    fields={["correctionFiles.vignetting"]}
                  >
                    Vignetting correction
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-4 text-balance"
                    forceMount
                  >
                    <FileInput
                      control={control}
                      explicitOptional
                      filters={[{ extensions: ["cal"], name: "Radiance CAL" }]}
                      name="correctionFiles.vignetting"
                      placeholder="Select or paste a .cal file…"
                    />
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem
                  className="px-4"
                  value="item-correction-neutral-density"
                >
                  <FieldContainerAccordionTrigger
                    fields={["correctionFiles.neutralDensity"]}
                  >
                    Neutral density correction
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-4 text-balance"
                    forceMount
                  >
                    <FileInput
                      control={control}
                      explicitOptional
                      filters={[{ extensions: ["cal"], name: "Radiance CAL" }]}
                      name="correctionFiles.neutralDensity"
                      placeholder="Select or paste a .cal file…"
                    />
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem
                  className="px-4"
                  value="item-correction-calibration-factor"
                >
                  <FieldContainerAccordionTrigger
                    fields={["correctionFiles.calibrationFactor"]}
                  >
                    Calibration factor correction
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-4 text-balance"
                    forceMount
                  >
                    <FileInput
                      control={control}
                      explicitOptional
                      filters={[{ extensions: ["cal"], name: "Radiance CAL" }]}
                      name="correctionFiles.calibrationFactor"
                      placeholder="Select or paste a .cal file…"
                    />
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem className="px-4" value="item-post">
                  <FieldContainerAccordionTrigger
                    fields={[
                      "outputSettings.targetRes",
                      "fisheyeView.projection",
                      "fisheyeView.verticalViewDegrees",
                      "fisheyeView.horizontalViewDegrees",
                    ]}
                  >
                    Output Header Editing
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-4 text-balance"
                    forceMount
                  >
                    <Field>
                      <FieldLabel>
                        <Aperture /> Projection type
                      </FieldLabel>
                      <FieldContent>
                        <Controller
                          control={control}
                          name="fisheyeView.projection"
                          render={({ field }) => (
                            <Select
                              onValueChange={field.onChange}
                              value={field.value}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Projection type" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="vta">
                                  Equidistant (-vta)
                                </SelectItem>
                                <SelectItem value="vth">
                                  Orthographic (-vth)
                                </SelectItem>
                                <SelectItem value="vtv">
                                  Non-fisheye (-vtv)
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </FieldContent>
                      <FieldDescription>
                        Written to the picture header as the view type. A
                        non-fisheye view skips the validity check, because
                        evalglare requires an angular fisheye view.
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel>
                        <Rotate3D /> Fisheye view angles
                      </FieldLabel>
                      <FieldContent className="flex-row gap-1">
                        <Input
                          icon={"°"}
                          placeholder="Vertical view angle"
                          type="number"
                          {...register("fisheyeView.verticalViewDegrees", {
                            min: {
                              message:
                                "Vertical view angle must be greater than 0",
                              value: 1,
                            },
                            required: "Vertical view angle is required",
                            valueAsNumber: true,
                          })}
                          aria-invalid={
                            form.formState.errors.fisheyeView
                              ?.verticalViewDegrees
                              ? "true"
                              : undefined
                          }
                          defaultValue={180}
                        />
                        <Input
                          icon={"°"}
                          // TODO: refactor this to be from the top, not the bottom.
                          // thats just more intuitive/standardized.
                          placeholder="Horizontal view angle"
                          type="number"
                          {...register("fisheyeView.horizontalViewDegrees", {
                            min: {
                              message:
                                "Horizontal view angle must be greater than 0",
                              value: 1,
                            },
                            required: "Horizontal view angle is required",
                            valueAsNumber: true,
                          })}
                          aria-invalid={
                            form.formState.errors.fisheyeView
                              ?.horizontalViewDegrees
                              ? "true"
                              : undefined
                          }
                          defaultValue={180}
                        />
                      </FieldContent>
                      <FieldError
                        errors={[
                          form.formState.errors.fisheyeView
                            ?.verticalViewDegrees,
                          form.formState.errors.fisheyeView
                            ?.horizontalViewDegrees,
                        ]}
                      />
                    </Field>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem className="px-4" value="item-validity">
                  <FieldContainerAccordionTrigger
                    fields={["validityCheck.measuredVerticalIlluminanceLux"]}
                  >
                    Validity Check
                  </FieldContainerAccordionTrigger>
                  <AccordionContent
                    className="flex flex-col gap-4 text-balance"
                    forceMount
                  >
                    <Field>
                      <FieldLabel>
                        <Sun /> Measured vertical illuminance
                      </FieldLabel>
                      <FieldContent>
                        <Input
                          aria-invalid={
                            form.formState.errors.validityCheck
                              ?.measuredVerticalIlluminanceLux
                              ? "true"
                              : undefined
                          }
                          icon={"lx"}
                          placeholder="Optional"
                          type="number"
                          {...register(
                            "validityCheck.measuredVerticalIlluminanceLux",
                            {
                              min: {
                                message:
                                  "Measured illuminance must be greater than 0",
                                value: 1,
                              },
                              setValueAs: (value) =>
                                value === "" || value === null
                                  ? null
                                  : Number(value),
                            }
                          )}
                        />
                      </FieldContent>
                      <FieldDescription>
                        Compared against the illuminance evalglare derives from
                        the finished image. Under 10% error is expected; over
                        25% the tutorial recommends rejecting the image. With a
                        non-fisheye projection the value is recorded in the
                        header but not compared, because evalglare requires an
                        angular fisheye view.
                      </FieldDescription>
                      <FieldError
                        errors={[
                          form.formState.errors.validityCheck
                            ?.measuredVerticalIlluminanceLux,
                        ]}
                      />
                    </Field>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
              <div className="right-0 bottom-0 left-0 mt-auto w-full border-t bg-background p-4 drop-shadow-lg">
                {progressVisible ? (
                  <PipelineStatus
                    onFinishAcknowledgment={() => setProgressVisible(false)}
                    onShowConsole={() => setConsoleOpen(true)}
                    onStop={(setTotal ?? 1) > 1 ? requestStop : null}
                    running={batchInFlight}
                    stopRequested={stopRequested}
                  />
                ) : (
                  <Button className="w-full bg-osu-beaver-orange" type="submit">
                    Generate HDR Image
                  </Button>
                )}
                {consoleOpen || progressVisible ? (
                  <RunConsole
                    onOpenChange={setConsoleOpen}
                    open={consoleOpen}
                  />
                ) : null}
                <RunConfirmDialog
                  confirmation={runConfirmation}
                  onDecision={decideRun}
                />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </form>
    </PipelineConfigProvider>
  );
}
