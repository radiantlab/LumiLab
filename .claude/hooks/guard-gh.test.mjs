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

const STALE = "scripts/__fixtures__/issue-bodies/free-text.md";

function runHook(command, cwd = ROOT, env = process.env) {
  const result = spawnSync("node", [HOOK], {
    encoding: "utf8",
    env,
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

test("a bug issue missing required sections is refused and they are named", () => {
  const { status, stderr } = runHook(
    heredocCreate("--label bug --label needs-triage", "Free text.")
  );
  assert.equal(status, 2);
  assert.ok(
    stderr.includes('missing the "### Pipeline stage" section from bug.yml')
  );
});

test("a command that mentions gh issue create without a category is not checked", () => {
  const { status } = runHook(
    'git commit -m "docs(agents): say when to run gh issue create"'
  );
  assert.equal(status, 0);
});

test("labels after a heredoc body still select the form", () => {
  const command = `gh issue create -t "Export runs" --body "$(cat <<'EOF'\nFree text.\nEOF\n)" --label feature --label needs-triage`;
  assert.equal(runHook(command).status, 2);
});

test("an invocation behind an assignment, a keyword or -R is checked", () => {
  const flags = '-l feature -l needs-triage --body "Free text."';
  for (const command of [
    `GH_REPO=a/b gh issue create ${flags}`,
    `if true; then gh issue create ${flags}; fi`,
    `gh -R radiantlab/LumiLab issue create ${flags}`,
  ]) {
    assert.equal(runHook(command).status, 2, command);
  }
});

test("an inline --body is read as the body", () => {
  const create = (body) =>
    `gh issue create -t "Export runs" --body "${body}" --label feature --label needs-triage`;
  assert.equal(runHook(create(FEATURE_BODY)).status, 0);
  const short = FEATURE_BODY.replace(
    "### Problem\n\nRuns cannot be exported.\n\n",
    ""
  );
  assert.equal(runHook(create(short)).status, 2);
});

test("a body only the shell can produce is left to the workflow", () => {
  const labels = "--label feature --label needs-triage";
  for (const command of [
    `cat f.md | gh issue create -t x -F - ${labels}`,
    `gh issue create -t x --body "$BODY" ${labels}`,
    `gh issue create -t x --body "$(cat f.md)" ${labels}`,
    // The file on disk is stale: this command rewrites it before gh runs.
    `cat > ${STALE} <<'EOF'\n${FEATURE_BODY}\nEOF\ngh issue create -t x -F ${STALE} ${labels}`,
  ]) {
    assert.equal(runHook(command).status, 0, command);
  }
});

test("flag-like words inside quoted values are not flags", () => {
  const ok = `gh issue create --title "Add a -b shortcut" --label feature --label needs-triage --body "$(cat <<'EOF'\n${FEATURE_BODY}\nEOF\n)"`;
  assert.equal(runHook(ok).status, 0);
  const task =
    'gh issue create --title "Filter docs" --label task --body "See gh issue list -l bug for now."';
  assert.equal(runHook(task).status, 0);
  const short = "--label feature --label needs-triage";
  for (const command of [
    `gh issue create --title "x" ${short} --body "Free text, run grep -e foo first."`,
    `gh issue create --title "Support -F in upload" ${short} --body "Free text."`,
  ]) {
    assert.equal(runHook(command).status, 2, command);
  }
});

test("gh issue new and a -R pr title are checked", () => {
  assert.equal(
    runHook('gh issue new -t x -l feature -l needs-triage --body "Free."')
      .status,
    2
  );
  assert.equal(
    runHook('gh -R a/b pr create --title "Bad Title" --body "x"').status,
    2
  );
});

test("a body line ending in a backslash stays in the body", () => {
  const body = FEATURE_BODY.replace(
    "Runs cannot be exported.",
    "Runs cannot be exported. \\"
  );
  const { status } = runHook(heredocCreate("-l feature -l needs-triage", body));
  assert.equal(status, 0);
});

test("a label flag inside the body does not select a form", () => {
  const { status } = runHook(
    heredocCreate("-l task", "Use gh with -l feature to file one.")
  );
  assert.equal(status, 0);
});

test("a flag inside the body does not skip the check", () => {
  const { status } = runHook(
    heredocCreate("-l feature -l needs-triage", "Run grep -e foo.")
  );
  assert.equal(status, 2);
});

test("a body file named through an environment variable is read", () => {
  const env = {
    ...process.env,
    BODIES: join(ROOT, "scripts/__fixtures__/issue-bodies"),
  };
  const create = (file) =>
    `gh issue create -t "Export runs" -l feature -l needs-triage -F "$BODIES/${file}"`;
  assert.equal(runHook(create("feature.md"), ROOT, env).status, 0);
  assert.equal(runHook(create("free-text.md"), ROOT, env).status, 2);
});

test("a body file the hook cannot read is left to the workflow", () => {
  const create = (file) =>
    `gh issue create -t "Export runs" -l feature -l needs-triage -F ${file}`;
  for (const command of [
    create("missing.md"),
    create("scripts"),
    `f=$(mktemp); ${create('"$f"')}`,
  ]) {
    assert.equal(runHook(command).status, 0, command);
  }
});
