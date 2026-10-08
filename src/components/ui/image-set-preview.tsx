import { PlusIcon } from "@heroicons/react/24/solid";
import { Trash2 } from "lucide-react";
import path from "path";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";
import { fileInfo } from "@/lib/host/file-info";
import { GenericImage } from "./(image)/generic-image";
import { Button } from "./button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { SkeletonSuspended } from "./skeleton-suspended";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export interface ImageSet {
  files: string[];
  name: string;
}

export function ImageSetPreview({
  name,
  files,
  disabled,
  onRemove,
  onAdd,
  onRemoveIndex,
  onClick,
}: ImageSet & {
  /**
   * Makes the set read-only. Everything that changes which files are in the
   * set stops responding, while names, counts and thumbnails still render.
   */
  disabled?: boolean;
  onRemove: () => void;
  onAdd: () => void;
  onRemoveIndex: (index: number) => void;
  onClick: (image: string) => void;
}) {
  const fileStats = useMemo(
    () => Promise.all(files.map((f) => fileInfo(f))),
    [files]
  );

  const fileTypes = useMemo(
    () => Array.from(new Set(files.map((f) => path.extname(f).slice(1)))),
    [files]
  );

  return (
    <div
      className="flex min-h-56 flex-col bg-accent"
      data-testid="image-set-preview"
    >
      <div className="flex w-full">
        <div className="grid flex-1 grid-flow-col divide-x border-b pl-2">
          <div className="flex items-center font-bold text-2xl">{name}</div>
          {useMemo(
            () =>
              Object.entries({
                Files: files.length,
                [fileTypes.length > 1 ? "File Types" : "File Type"]:
                  fileTypes.join(", "),
                "Average File Size": fileStats.then((stats) =>
                  prettyBytes(
                    stats.reduce((acc, fileStat) => acc + fileStat.size, 0) /
                      stats.length
                  )
                ),
              } satisfies Record<
                string,
                string | number | Promise<string | number>
              >).map(([key, value]) => (
                <div
                  className="flex items-center gap-1 px-2 text-muted-foreground text-sm"
                  key={key}
                >
                  {key}:
                  <SkeletonSuspended sizePlaceholder={"placeholder"}>
                    {value}
                  </SkeletonSuspended>
                </div>
              )),
            [fileStats, fileTypes, files.length]
          )}
        </div>
        <Button
          aria-label={`Remove image set ${name}`}
          className="grid h-full w-16 place-items-center rounded-none border-t-0 border-r-0 border-b border-l text-destructive transition-colors hover:cursor-pointer hover:text-foreground"
          disabled={disabled}
          onClick={onRemove}
          variant="outline"
        >
          <Trash2 />
        </Button>
        <Button
          aria-label={`Add images to ${name}`}
          className="grid h-full w-16 place-items-center rounded-none border-t-0 border-r-0 border-b border-l text-muted-foreground transition-colors hover:cursor-pointer hover:text-foreground"
          disabled={disabled}
          onClick={onAdd}
          variant="ghost"
        >
          <PlusIcon />
        </Button>
      </div>
      <div
        className="flex grow gap-4 overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: "none" }}
      >
        {files.map((file, index) => (
          <Tooltip key={file}>
            <TooltipTrigger>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  {/* biome-ignore lint/a11y/useSemanticElements: a real <button> can't be used here: this is already nested inside the <button> that Radix's TooltipTrigger renders by default, and a button-in-button is invalid HTML. */}
                  <div
                    className="generic-image-container size-48 shrink-0 bg-accent"
                    onClick={() => onClick(file)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onClick(file);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <GenericImage fsSrc={file} />
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    disabled={disabled}
                    onClick={() => onRemoveIndex(index)}
                  >
                    Remove image
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </TooltipTrigger>
            <TooltipContent>
              <p>{file}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
