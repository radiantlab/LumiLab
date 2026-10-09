/**
 * The issue-form rules from #298, as a check: an issue labeled with a form's
 * category carries every `### ` section that form renders, a value under each
 * required one, and the labels the form applies. The forms in
 * `.github/ISSUE_TEMPLATE/` are the only list of sections; nothing here names
 * one.
 *
 * One implementation, two callers. The Claude Code `gh` hook runs it on the
 * text of a `gh issue create` before the issue exists, and the `issue-body`
 * workflow runs it on every opened issue, which covers `gh` without the hook
 * and the API.
 *
 * Usage:
 *   node scripts/check-issue-body.mjs --stdin --labels <a,b>
 *       the body on stdin; prints each problem and exits 3 when there are any
 *   node scripts/check-issue-body.mjs --missing-labels --labels <a,b>
 *       prints the labels the selected form applies that the issue lacks
 *
 * "Problems found" exits 3, not 1, because 1 is also what node exits with on
 * a crash, and the workflow must not answer a broken form with `needs-info`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const DEFAULT_FORMS = fileURLToPath(
  new URL("../.github/ISSUE_TEMPLATE/", import.meta.url)
);

/**
 * The triage state labels in docs/agents/triage-labels.md. A form's other
 * labels are its category, and the category is what selects the form.
 */
const STATE_LABELS = new Set([
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
]);

const HEADING = /^### (.+)$/m;
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\S\n]*$/gm;
const PROBLEMS_FOUND = 3;

function loadForms(formsDir) {
  return readdirSync(formsDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => ({
      file,
      form: parse(readFileSync(join(formsDir, file), "utf8")),
    }))
    .filter(({ form }) => Array.isArray(form?.body));
}

/**
 * The `### Heading` sections of a body, as heading to trimmed content. A
 * heading inside a code fence is quoted text, not a section.
 */
function sections(body) {
  const found = new Map();
  const parts = body.replace(FENCE, "").split(HEADING);
  for (let i = 1; i < parts.length; i += 2) {
    found.set(parts[i].trim(), parts[i + 1].trim());
  }
  return found;
}

/**
 * GitHub writes `_No response_` under a form field the reporter left blank.
 */
function isEmpty(content) {
  return content === "" || content === "_No response_";
}

/**
 * Label names as GitHub compares them: without regard to case.
 */
function normalize(labels) {
  return labels.map((label) => label.toLowerCase());
}

/**
 * Whether `labels` carry the category of `form`, which is what puts an issue
 * under that form's rules.
 */
function appliesTo(form, labels) {
  return normalize(form.labels ?? []).some(
    (label) => !STATE_LABELS.has(label) && labels.includes(label)
  );
}

function labelsLacking(form, labels) {
  return normalize(form.labels).filter((label) => !labels.includes(label));
}

function checkAgainstForm(file, form, labels, present) {
  const problems = labelsLacking(form, labels).map(
    (label) => `missing the "${label}" label ${file} applies`
  );
  for (const field of form.body) {
    const label = field.attributes?.label;
    if (!label) {
      continue;
    }
    if (!present.has(label)) {
      problems.push(`missing the "### ${label}" section from ${file}`);
    } else if (
      field.validations?.required === true &&
      isEmpty(present.get(label))
    ) {
      problems.push(`"### ${label}" is required by ${file} and is empty`);
    }
  }
  return problems;
}

/**
 * Every way `body` and `labels` fall short of the issue form their category
 * label selects, as strings a reporter can act on. An issue without a form's
 * category, such as a `task` or a wayfinder ticket, is not checked.
 */
export function checkIssueBody(body, labels, formsDir = DEFAULT_FORMS) {
  const present = sections(body);
  const issueLabels = normalize(labels);
  return loadForms(formsDir)
    .filter(({ form }) => appliesTo(form, issueLabels))
    .flatMap(({ file, form }) =>
      checkAgainstForm(file, form, issueLabels, present)
    );
}

/**
 * The labels the forms selected by `labels` apply and the issue lacks. A
 * collaborator who filed a `bug` from `gh` without `needs-triage` gets it
 * added by the workflow rather than a request for it.
 */
export function missingLabels(labels, formsDir = DEFAULT_FORMS) {
  const issueLabels = normalize(labels);
  const missing = loadForms(formsDir)
    .filter(({ form }) => appliesTo(form, issueLabels))
    .flatMap(({ form }) => labelsLacking(form, issueLabels));
  return [...new Set(missing)];
}

function main(argv) {
  const [mode, flag, list = ""] = argv;
  const labels =
    flag === "--labels"
      ? list
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean)
      : [];

  if (mode === "--missing-labels") {
    process.stdout.write(missingLabels(labels).join("\n"));
    return;
  }
  if (mode !== "--stdin") {
    process.stderr.write(
      "usage: check-issue-body.mjs (--stdin | --missing-labels) --labels <a,b>\n"
    );
    process.exit(2);
  }

  const problems = checkIssueBody(readFileSync(0, "utf8"), labels);
  if (problems.length > 0) {
    process.stdout.write(`${problems.join("\n")}\n`);
    process.exit(PROBLEMS_FOUND);
  }
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  main(process.argv.slice(2));
}
