import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIssueBody, missingLabels } from "./check-issue-body.mjs";

const FORMS = new URL("./__fixtures__/issue-forms/", import.meta.url).pathname;

// What GitHub renders for a submitted fixture bug form.
const SUBMITTED_BUG = `### Where it happens

Web, Safari, Desktop, macOS

### Version

5.0.1

### Current behavior

The merge stalls on the third bracket.

### Out of scope

_No response_`;

test("a body that renders like a submitted form passes", () => {
  assert.deepEqual(
    checkIssueBody(SUBMITTED_BUG, ["bug", "needs-triage"], FORMS),
    []
  );
});

test("a missing section is named", () => {
  const body = SUBMITTED_BUG.replace("### Version\n\n5.0.1\n\n", "");
  assert.deepEqual(checkIssueBody(body, ["bug", "needs-triage"], FORMS), [
    'missing the "### Version" section from bug.yml',
  ]);
});

test("a required section left empty or as _No response_ fails", () => {
  const body = SUBMITTED_BUG.replace("5.0.1", "_No response_").replace(
    "The merge stalls on the third bracket.",
    ""
  );
  assert.deepEqual(checkIssueBody(body, ["bug", "needs-triage"], FORMS), [
    '"### Version" is required by bug.yml and is empty',
    '"### Current behavior" is required by bug.yml and is empty',
  ]);
});

test("a label the form applies but the issue lacks is named", () => {
  assert.deepEqual(checkIssueBody(SUBMITTED_BUG, ["bug"], FORMS), [
    'missing the "needs-triage" label bug.yml applies',
  ]);
});

test("an issue without a form's category is not checked", () => {
  assert.deepEqual(checkIssueBody("Free text.", ["task"], FORMS), []);
});

test("renaming a field in the form changes the required section", () => {
  const renamed = new URL(
    "./__fixtures__/issue-forms-renamed/",
    import.meta.url
  ).pathname;
  assert.deepEqual(
    checkIssueBody(SUBMITTED_BUG, ["bug", "needs-triage"], renamed),
    ['missing the "### Observed behavior" section from bug.yml']
  );
  const updated = SUBMITTED_BUG.replace(
    "### Current behavior",
    "### Observed behavior"
  );
  assert.deepEqual(
    checkIssueBody(updated, ["bug", "needs-triage"], renamed),
    []
  );
});

test("missing labels are the ones the selected form applies", () => {
  assert.deepEqual(missingLabels(["bug"], FORMS), ["needs-triage"]);
  assert.deepEqual(missingLabels(["bug", "needs-triage"], FORMS), []);
  assert.deepEqual(missingLabels(["task"], FORMS), []);
});

test("the repository's own forms load and are checked", () => {
  const problems = checkIssueBody("Free text.", ["bug", "needs-triage"]);
  assert.ok(
    problems.includes('missing the "### Pipeline stage" section from bug.yml')
  );
});

test("a heading inside a code fence is not a section", () => {
  const body = SUBMITTED_BUG.replace(
    "### Out of scope\n\n_No response_",
    "```md\n### Out of scope\n```"
  );
  assert.deepEqual(checkIssueBody(body, ["bug", "needs-triage"], FORMS), [
    'missing the "### Out of scope" section from bug.yml',
  ]);
});

test("labels match without regard to case, as GitHub's do", () => {
  const body = SUBMITTED_BUG.replace("### Version\n\n5.0.1\n\n", "");
  assert.deepEqual(checkIssueBody(body, ["Bug", "Needs-Triage"], FORMS), [
    'missing the "### Version" section from bug.yml',
  ]);
  assert.deepEqual(missingLabels(["Bug"], FORMS), ["needs-triage"]);
});

test("fences follow CommonMark: info strings, closing length, tildes", () => {
  const fenced = (open, close) =>
    SUBMITTED_BUG.replace(
      "### Out of scope\n\n_No response_",
      `${open}\n### Out of scope\n${close}`
    );
  const outOfScope = ['missing the "### Out of scope" section from bug.yml'];
  const labels = ["bug", "needs-triage"];
  assert.deepEqual(
    checkIssueBody(fenced("```", "````"), labels, FORMS),
    outOfScope
  );
  assert.deepEqual(
    checkIssueBody(fenced("~~~", "~~~"), labels, FORMS),
    outOfScope
  );
  // A backtick in the info string means the line opens no fence.
  const inline = SUBMITTED_BUG.replace(
    "5.0.1",
    "5.0.1, after ```npm run dev``` fails"
  ).replace("_No response_", "```\nquoted\n```");
  assert.deepEqual(checkIssueBody(inline, labels, FORMS), []);
});

test("a required section answered with only a code block is not empty", () => {
  const body = SUBMITTED_BUG.replace(
    "The merge stalls on the third bracket.",
    "```\nTypeError: boom\n```"
  );
  assert.deepEqual(checkIssueBody(body, ["bug", "needs-triage"], FORMS), []);
});

test("fences are found in a body with CRLF line endings", () => {
  const body = SUBMITTED_BUG.replace(
    "### Out of scope\n\n_No response_",
    "```\n### Out of scope\n```"
  ).replaceAll("\n", "\r\n");
  assert.deepEqual(checkIssueBody(body, ["bug", "needs-triage"], FORMS), [
    'missing the "### Out of scope" section from bug.yml',
  ]);
});
