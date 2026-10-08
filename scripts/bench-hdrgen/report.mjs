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
    const cell = cells.get(key) ?? {
      frames: record.frames,
      leg: record.leg,
      runs: [],
    };
    cell.runs.push(record);
    cells.set(key, cell);
  }

  return [...cells.values()].map(({ frames, leg, runs }) => {
    const finished = runs.filter(
      (run) => run.status === "ok" && run.runMs !== null
    );
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
        ? counted
            .map(([label, count]) => `${count}/${runs.length} ${label}`)
            .join(", ")
        : null,
    };
  });
}

const seconds = (ms) => (ms === null ? "-" : (ms / 1000).toFixed(1));

export function formatTable(rows) {
  const header = ["leg", "frames", "median", "min", "max", "note"];
  const body = rows.map((cell) => [
    cell.leg,
    String(cell.frames),
    seconds(cell.medianMs),
    seconds(cell.minMs),
    seconds(cell.maxMs),
    cell.note ?? "",
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...body.map((line) => line[column].length))
  );
  const row = (cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  return [
    row(header),
    row(widths.map((width) => "-".repeat(width))),
    ...body.map(row),
  ].join("\n");
}
