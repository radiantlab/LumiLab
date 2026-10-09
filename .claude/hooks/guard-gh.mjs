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
 * which the web UI enforces and `gh issue create` skips. The hook reads the
 * body shapes docs/agents/issue-tracker.md prescribes (an inline `--body`, a
 * heredoc, `--body-file <path>`) and lets through what it cannot read: for a
 * session in this repo the `issue-body` workflow checks the opened issue
 * anyway, so a miss costs a comment later and a false refusal blocks work.
 *
 * Exit 2 blocks; stderr is the reason the model reads.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { deny, loadRuleScripts, readInput, repoRoot } from "./lib.mjs";

// `-R owner/repo` may come before the subcommand.
const PUBLISHES =
  /\bgh\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)?(?:(?:pr|issue)\s+(?:create|edit|comment|review|close|merge)|release\s+(?:create|edit))\b/;
const API_WITH_BODY = /\bgh\s+api\b[\s\S]*\bbody\b/;
const TITLED = /\bgh\s+pr\s+(?:create|edit|merge)\b/;
const TITLE_FLAG =
  /(?:^|\s)(?:-t|--title|--subject)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;

const ISSUE_CREATE =
  /\bgh\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)?issue\s+(?:create|new)\b/;
const HEREDOC =
  /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2(?=[^\S\n]*$)/gm;
const HEREDOC_MARK = /__HEREDOC_(\d+)__/;
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
const SUBSTITUTION = /\$\(|`/;
const ENV_VAR = /\$\{?(\w+)\}?/g;
const HOME_DIR = /^~(?=\/)/;

function flagValue(match) {
  return match[1] ?? match[2] ?? match[3];
}

/**
 * The command with each heredoc body swapped for a marker, so flags are read
 * from shell text and never from a body, plus the bodies by marker number.
 */
function splitHeredocs(text) {
  const bodies = [];
  const shell = text.replace(HEREDOC, (_match, _quote, _tag, rest, body) => {
    bodies.push(body);
    return `__HEREDOC_${bodies.length - 1}__${rest}`;
  });
  return { bodies, shell: shell.replace(CONTINUATION, " ") };
}

function issueLabels(flags) {
  return [...flags.matchAll(LABEL_FLAG)].flatMap((match) =>
    flagValue(match)
      .split(",")
      .map((label) => label.trim())
  );
}

/**
 * The `-F` file as a path, or null when only the shell could say which file
 * it is: a command substitution, or a variable the command sets itself.
 */
function bodyFilePath(value, base) {
  if (SUBSTITUTION.test(value)) {
    return null;
  }
  let unknown = false;
  const expanded = value
    .replace(ENV_VAR, (_, name) => {
      unknown ||= process.env[name] === undefined;
      return process.env[name] ?? "";
    })
    .replace(HOME_DIR, process.env.HOME ?? "~");
  return unknown ? null : resolve(base, expanded);
}

function readRegularFile(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * The body a `gh issue create` would publish: the `-F` file, else the first
 * heredoc after the invocation, else the shell text itself, whose `### `
 * lines are an inline body's headings. Null when the hook cannot read it.
 */
function issueBody(flags, bodies, base) {
  const file = BODY_FILE_FLAG.exec(flags);
  if (file && flagValue(file) !== "-") {
    const path = bodyFilePath(flagValue(file), base);
    return path === null ? null : readRegularFile(path);
  }
  const heredoc = HEREDOC_MARK.exec(flags);
  return heredoc ? bodies[Number(heredoc[1])] : flags;
}

/**
 * What a `gh issue create` in `text` falls short of its form by, or nothing
 * when the command creates no issue the hook can read.
 */
function formProblems(text, base, check) {
  const { bodies, shell } = splitHeredocs(text);
  const invocation = ISSUE_CREATE.exec(shell);
  if (!(check && invocation)) {
    return [];
  }
  const flags = shell.slice(invocation.index);
  if (NO_BODY.test(flags)) {
    return [];
  }
  const body = issueBody(flags, bodies, base);
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
