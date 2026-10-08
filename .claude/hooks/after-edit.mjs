/**
 * PostToolUse on Edit and Write: Biome and the prose rule on the one file
 * just written, reported on the edit that caused the problem rather than at
 * commit time.
 *
 * PostToolUse cannot block, but stderr on exit 2 is shown to the model, which
 * is the point: the same finding lefthook would make at pre-commit, a few
 * minutes earlier and one file at a time. Biome decides for itself which
 * files it covers (`files.includes` in biome.jsonc); `--no-errors-on-unmatched`
 * keeps an excluded path from reading as a failure. Biome is the binary
 * ultracite drives, so this is the same check `npm run check` makes.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadRuleScripts, readInput, repoRelative, repoRoot } from "./lib.mjs";

const BIOME_EXTENSIONS = /\.(?:[cm]?jsx?|tsx?|jsonc?|css)$/;

const input = readInput();
const root = repoRoot(input.cwd ?? process.cwd());
const path = repoRelative(root, input.tool_input?.file_path ?? "");

if (!path || path.startsWith("../") || !existsSync(`${root}/${path}`)) {
  process.exit(0);
}

let failed = false;
const { isCheckedPath } = await loadRuleScripts(root);

if (isCheckedPath(path)) {
  const prose = spawnSync(process.execPath, ["scripts/check-prose.mjs", path], {
    cwd: root,
    encoding: "utf8",
  });
  if (prose.status !== 0) {
    failed = true;
    process.stderr.write(prose.stderr);
  }
}

const biome = `${root}/node_modules/.bin/biome`;
if (BIOME_EXTENSIONS.test(path) && existsSync(biome)) {
  const result = spawnSync(biome, ["check", "--no-errors-on-unmatched", path], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(
      `Biome reports on ${path} (run \`npm run fix\` for the safe fixes):\n${result.stdout}${result.stderr}`
    );
  }
}

process.exit(failed ? 2 : 0);
