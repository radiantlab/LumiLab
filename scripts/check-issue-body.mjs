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
 *   node scripts/check-issue-body.mjs --labels <a,b> --stdin
 *       the body on stdin; prints each problem, exits 1 when there are any
 *   node scripts/check-issue-body.mjs --labels <a,b> --missing-labels
 *       prints the labels the selected form applies that the issue lacks
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
 * The `### Heading` sections of a body, as heading to trimmed content.
 */
function sections(body) {
  const found = new Map();
  const parts = body.split(HEADING);
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
 * Whether `labels` carry the category of `form`, which is what puts an issue
 * under that form's rules.
 */
function appliesTo(form, labels) {
  return (form.labels ?? []).some(
    (label) => !STATE_LABELS.has(label) && labels.includes(label)
  );
}

function checkAgainstForm(file, form, labels, present) {
  const problems = form.labels
    .filter((label) => !labels.includes(label))
    .map((label) => `missing the "${label}" label ${file} applies`);
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
  return loadForms(formsDir)
    .filter(({ form }) => appliesTo(form, labels))
    .flatMap(({ file, form }) => checkAgainstForm(file, form, labels, present));
}

/**
 * The labels the forms selected by `labels` apply and the issue lacks. A
 * reporter without triage rights cannot set labels from `gh` or the API, so
 * the workflow adds these itself rather than asking for them.
 */
export function missingLabels(labels, formsDir = DEFAULT_FORMS) {
  const missing = loadForms(formsDir)
    .filter(({ form }) => appliesTo(form, labels))
    .flatMap(({ form }) => form.labels)
    .filter((label) => !labels.includes(label));
  return [...new Set(missing)];
}

function main(argv) {
  const labelsAt = argv.indexOf("--labels");
  const labels =
    labelsAt === -1
      ? []
      : argv[labelsAt + 1]
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean);

  if (argv.includes("--missing-labels")) {
    process.stdout.write(missingLabels(labels).join("\n"));
    return;
  }

  const problems = checkIssueBody(readFileSync(0, "utf8"), labels);
  if (problems.length > 0) {
    process.stdout.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  main(process.argv.slice(2));
}
