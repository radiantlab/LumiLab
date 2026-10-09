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
 * A bug or feature issue also has to match its form in .github/ISSUE_TEMPLATE/,
 * which the web UI enforces and `gh issue create` skips.
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

// An invocation, at the start of a command or after a shell separator, so a
// commit message that mentions `gh issue create` is not one. Its flags are
// the rest of that line; a heredoc body starts on the next.
const ISSUE_CREATE =
  /(?:^|[;&|(`])\s*gh\s+issue\s+(?:create|new)\b(?<flags>[^\n]*)/m;
const CONTINUATION = /\\\n/g;
// No body in the command to check: `--web` opens the form itself.
const NO_BODY = /(?:^|\s)(?:-w|--web|-e|--editor|--recover)(?:\s|=|$)/;
const FLAG_VALUE = String.raw`(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))`;
const LABEL_FLAG = new RegExp(
  String.raw`(?:^|\s)(?:-l|--label)${FLAG_VALUE}`,
  "g"
);
const BODY_FILE_FLAG = new RegExp(
  String.raw`(?:^|\s)(?:-F|--body-file)${FLAG_VALUE}`
);
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*$/m;
const ENV_VAR = /\$\{?(\w+)\}?/g;
const HOME_DIR = /^~(?=\/)/;

function flagValue(match) {
  return match[1] ?? match[2] ?? match[3];
}

function issueLabels(flags) {
  return [...flags.matchAll(LABEL_FLAG)].flatMap((match) =>
    flagValue(match)
      .split(",")
      .map((label) => label.trim())
  );
}

/**
 * The body a `gh issue create` would publish, without parsing shell: a `-F`
 * file read from the session's cwd, else the first heredoc after the
 * invocation, else the command text, whose `### ` lines are the headings
 * either way. Null for a body file the hook cannot read, such as one a later
 * part of the command writes; the `issue-body` workflow checks that issue.
 */
function issueBody(flags, rest, base) {
  const file = BODY_FILE_FLAG.exec(flags);
  if (file && flagValue(file) !== "-") {
    const path = resolve(
      base,
      flagValue(file)
        .replace(ENV_VAR, (_, name) => process.env[name] ?? "")
        .replace(HOME_DIR, process.env.HOME ?? "~")
    );
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  return HEREDOC.exec(rest)?.[3] ?? rest;
}

/**
 * What a `gh issue create` in `text` falls short of its form by, or nothing
 * when the command creates no issue the hook can check.
 */
function formProblems(text, base, check) {
  const joined = text.replace(CONTINUATION, " ");
  const invocation = ISSUE_CREATE.exec(joined);
  if (!(check && invocation)) {
    return [];
  }
  const { flags } = invocation.groups;
  if (NO_BODY.test(flags)) {
    return [];
  }
  const body = issueBody(flags, joined.slice(invocation.index), base);
  return body === null ? [] : check(body, issueLabels(flags));
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

for (const problem of formProblems(command, cwd, checkIssueBody)) {
  problems.push(`issue form (docs/agents/issue-tracker.md): ${problem}`);
}

if (problems.length > 0) {
  deny(
    `This gh command would publish text that breaks a rule (AGENTS.md):\n${problems.map((p) => `- ${p}`).join("\n")}`
  );
}
