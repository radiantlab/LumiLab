import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./guard-gh.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The feature form's sections, as an agent writes them in a heredoc.
const FEATURE_BODY = readFileSync(
  join(ROOT, "scripts/__fixtures__/issue-bodies/feature.md"),
  "utf8"
).trim();

function runHook(command, cwd = ROOT) {
  const result = spawnSync("node", [HOOK], {
    encoding: "utf8",
    input: JSON.stringify({ cwd, tool_input: { command } }),
  });
  return { status: result.status, stderr: result.stderr };
}

function heredocCreate(labels, body) {
  return `gh issue create --title "Export runs" ${labels} --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;
}

test("a feature issue with every section and label passes", () => {
  const { status } = runHook(
    heredocCreate("--label feature --label needs-triage", FEATURE_BODY)
  );
  assert.equal(status, 0);
});

test("a feature issue missing a section is refused and the section named", () => {
  const body = FEATURE_BODY.replace(
    "### Problem\n\nRuns cannot be exported.\n\n",
    ""
  );
  const { status, stderr } = runHook(
    heredocCreate("--label feature,needs-triage", body)
  );
  assert.equal(status, 2);
  assert.ok(
    stderr.includes('missing the "### Problem" section from feature.yml')
  );
});

test("a missing needs-triage label is refused", () => {
  const { status, stderr } = runHook(heredocCreate("-l feature", FEATURE_BODY));
  assert.equal(status, 2);
  assert.ok(
    stderr.includes('missing the "needs-triage" label feature.yml applies')
  );
});

test("a body file is read relative to the session's cwd", () => {
  const scripts = join(ROOT, "scripts");
  const create = (file) =>
    `gh issue create -t "Export runs" -l feature -l needs-triage -F __fixtures__/issue-bodies/${file}`;
  assert.equal(runHook(create("feature.md"), scripts).status, 0);
  assert.equal(runHook(create("free-text.md"), scripts).status, 2);
});

test("an issue without a form's category is not checked", () => {
  const { status } = runHook(heredocCreate("--label task", "Free text."));
  assert.equal(status, 0);
});

test("--web is the form itself and is not checked", () => {
  const { status } = runHook("gh issue create --web --label feature");
  assert.equal(status, 0);
});
