/**
 * PreToolUse on Bash: the text a `gh` command would publish gets the checks a
 * commit message gets, before it reaches the remote.
 *
 * This is the one place the session-link rule can be enforced for issue and
 * comment text: it lands on a public repo, and lefthook never sees `gh` text.
 * A PR title is also the squash-merge subject, so `pr create`, `pr edit` and
 * `pr merge --subject` get the Conventional Commits check; `pr-text` checks
 * the same title and body again in CI.
 *
 * Exit 2 blocks; stderr is the reason the model reads.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deny, loadRuleScripts, readInput, repoRoot } from "./lib.mjs";

const PUBLISHES =
  /\bgh\s+(?:(?:pr|issue)\s+(?:create|edit|comment|review|close|merge)|release\s+(?:create|edit))\b/;
const API_WITH_BODY = /\bgh\s+api\b[\s\S]*\bbody\b/;
const TITLED = /\bgh\s+pr\s+(?:create|edit|merge)\b/;
const TITLE_FLAG =
  /(?:^|\s)(?:-t|--title|--subject)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;

const ISSUE_CREATE = /\bgh\s+issue\s+(?:create|new)\b/;
// No body in the command to check: `--web` opens the form itself.
const NO_BODY = /(?:^|\s)(?:-w|--web|-e|--editor|--recover)(?:\s|=|$)/;
const LABEL_FLAG =
  /(?:^|\s)(?:-l|--label)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
const BODY_FILE_FLAG =
  /(?:^|\s)(?:-F|--body-file)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*$/m;

function issueLabels(text) {
  return [...text.matchAll(LABEL_FLAG)].flatMap((match) =>
    (match[1] ?? match[2] ?? match[3]).split(",").map((label) => label.trim())
  );
}

/**
 * The body a `gh issue create` would publish, without parsing shell: a
 * `-F` file read from the session's cwd, else the first heredoc, else the
 * command text, whose `### ` lines are the headings either way.
 */
function issueBody(text, from) {
  const file = BODY_FILE_FLAG.exec(text);
  const path = file ? (file[1] ?? file[2] ?? file[3]) : null;
  if (path && path !== "-") {
    const absolute = resolve(from, path);
    if (existsSync(absolute)) {
      return readFileSync(absolute, "utf8");
    }
  }
  return HEREDOC.exec(text)?.[3] ?? text;
}

const input = readInput();
const command = input.tool_input?.command ?? "";
const cwd = input.cwd ?? process.cwd();

if (!(PUBLISHES.test(command) || API_WITH_BODY.test(command))) {
  process.exit(0);
}

const { checkCommitMessage, checkIssueBody, findProseViolations } =
  await loadRuleScripts(repoRoot(cwd));
const problems = [];

if (command.includes("claude.ai/code/session")) {
  problems.push(
    "contains a claude.ai/code/session link; never publish one (AGENTS.md)"
  );
}

for (const { line, kind, snippet } of findProseViolations(command)) {
  problems.push(`line ${line} has an ${kind}: ${snippet}`);
}

const title = TITLED.test(command) ? TITLE_FLAG.exec(command) : null;
if (title) {
  for (const problem of checkCommitMessage(title[1] ?? title[2])) {
    if (problem.startsWith("subject")) {
      problems.push(`PR title is the squash-merge subject: ${problem}`);
    }
  }
}

if (problems.length > 0) {
  deny(
    `This gh command would publish text that breaks a rule (AGENTS.md):\n${problems.map((p) => `- ${p}`).join("\n")}`
  );
}

// A bug or feature issue matches its form in .github/ISSUE_TEMPLATE/, which
// the web UI enforces and `gh issue create` skips.
if (checkIssueBody && ISSUE_CREATE.test(command) && !NO_BODY.test(command)) {
  const formProblems = checkIssueBody(
    issueBody(command, cwd),
    issueLabels(command)
  );
  if (formProblems.length > 0) {
    deny(
      `This gh issue create does not match its issue form (docs/agents/issue-tracker.md):\n${formProblems.map((p) => `- ${p}`).join("\n")}`
    );
  }
}
