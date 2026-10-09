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
  /\bgh\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)?(?:(?:pr|issue)\s+(?:create|new|edit|comment|review|close|merge)|release\s+(?:create|edit))\b/;
const API_WITH_BODY = /\bgh\s+api\b[\s\S]*\bbody\b/;
const TITLED =
  /\bgh\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)?pr\s+(?:create|new|edit|merge)\b/;
const TITLE_FLAG =
  /(?:^|\s)(?:-t|--title|--subject)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;

const ISSUE_CREATE =
  /\bgh\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)?issue\s+(?:create|new)\b/g;
// The other flags of `gh issue create` that take a value, which is skipped
// so a title such as "--web" is not read as a flag.
const VALUE_FLAGS = new Set([
  "-t",
  "--title",
  "-a",
  "--assignee",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "-T",
  "--template",
  "-R",
  "--repo",
  "--type",
  "--parent",
  "--blocked-by",
  "--blocking",
  "--attach",
]);
const HEREDOC_OPEN = /<<(-?)\s*(['"]?)(\w+)\2([^\n]*)\n/g;
const LEADING_TABS = /^\t+/;
const HEREDOC_MARK = /__HEREDOC_(\d+)__/;
const CONTINUATION = /\\\n/g;
const BLANK = /\s/;
// Where the `gh` command ends and the next one, or a pipe, begins.
const COMMAND_END = new Set([";", "|", "&", "\n"]);
// Escapes a double-quoted string keeps as the escaped character.
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);
// No body in the command to check: `--web` opens the form itself.
const NO_BODY = new Set(["-w", "--web", "-e", "--editor", "--recover"]);
const LONG_WITH_VALUE = /^(--[^=]+)[=]([\s\S]*)$/;
const SHELL_ONLY = /[$`]/;
const SUBSTITUTION = /\$\(|`/;
const ENV_VAR = /\$\{?(\w+)\}?/g;
const HOME_DIR = /^~(?=\/)/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * The command with each heredoc body swapped for a marker, so flags are read
 * from shell text and never from a body, plus the bodies by marker number.
 */
function splitHeredocs(text) {
  const bodies = [];
  let shell = "";
  let at = 0;
  for (const open of text.matchAll(HEREDOC_OPEN)) {
    if (open.index < at) {
      continue;
    }
    const [opener, dash, , tag, rest] = open;
    const start = open.index + opener.length;
    const lines = text.slice(start).split("\n");
    // Bash ends a heredoc only at the tag alone on its line; `<<-` strips
    // leading tabs first, never spaces.
    let end = lines.findIndex(
      (line) => (dash ? line.replace(LEADING_TABS, "") : line) === tag
    );
    end = end === -1 ? lines.length : end;
    bodies.push(lines.slice(0, end).join("\n"));
    shell += `${text.slice(at, open.index)}__HEREDOC_${bodies.length - 1}__${rest}`;
    at = Math.min(
      text.length,
      start + lines.slice(0, end + 1).join("\n").length
    );
  }
  shell += text.slice(at);
  return { bodies, shell: shell.replace(CONTINUATION, " ") };
}

/**
 * One quoted span starting at `text[start]`, as the characters the shell
 * keeps and the index after its closing quote.
 */
function readQuoted(text, start) {
  const quote = text[start];
  let value = "";
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    const escaped =
      quote === '"' &&
      text[i] === "\\" &&
      DOUBLE_QUOTE_ESCAPES.has(text[i + 1]);
    value += escaped ? text[i + 1] : text[i];
    i += escaped ? 2 : 1;
  }
  return { end: i + 1, value };
}

/**
 * The first `gh issue create` in `shell` that is a command rather than text
 * inside a quoted string, such as an example in a comment body.
 */
function invocationIn(shell) {
  const quoted = [];
  let i = 0;
  while (i < shell.length) {
    if (shell[i] === '"' || shell[i] === "'") {
      const { end } = readQuoted(shell, i);
      quoted.push([i, end]);
      i = end;
    } else {
      i += shell[i] === "\\" ? 2 : 1;
    }
  }
  return (
    [...shell.matchAll(ISSUE_CREATE)].find(
      ({ index }) =>
        !quoted.some(([start, end]) => index > start && index < end)
    ) ?? null
  );
}

/**
 * The words of the `gh` command that starts `text`, quotes resolved as the
 * shell resolves them, up to the first unquoted `;`, `|`, `&` or newline.
 * `raw` keeps the quoted source, where a `$` means only the shell knows the
 * value.
 */
function words(text) {
  const found = [];
  let word = null;
  let i = 0;
  while (i < text.length && !COMMAND_END.has(text[i])) {
    const char = text[i];
    if (BLANK.test(char)) {
      word = null;
      i += 1;
      continue;
    }
    if (word === null) {
      word = { raw: "", value: "" };
      found.push(word);
    }
    const quoted = char === '"' || char === "'";
    const span = quoted ? readQuoted(text, i) : { end: i + 1, value: char };
    word.raw += text.slice(i, span.end);
    word.value += span.value;
    i = span.end;
  }
  return found;
}

/**
 * The flags of a `gh issue create`: every label, the `--body` word, the
 * `--body-file` word, and whether a flag means there is no body to check.
 */
function issueFlags(args) {
  const flags = { body: null, bodyFile: null, labels: [], noBody: false };
  const queue = [...args];
  while (queue.length > 0) {
    const arg = queue.shift();
    const [, longName, attached] = LONG_WITH_VALUE.exec(arg.value) ?? [];
    const name = longName ?? arg.value;
    const takeValue = () =>
      attached === undefined
        ? queue.shift()
        : { raw: attached, value: attached };
    if (NO_BODY.has(name)) {
      flags.noBody = true;
    } else if (name === "-l" || name === "--label") {
      flags.labels.push(...(takeValue()?.value ?? "").split(","));
    } else if (name === "-b" || name === "--body") {
      flags.body = takeValue() ?? null;
    } else if (name === "-F" || name === "--body-file") {
      flags.bodyFile = takeValue() ?? null;
    } else if (VALUE_FLAGS.has(name)) {
      takeValue();
    }
  }
  flags.labels = flags.labels.map((label) => label.trim()).filter(Boolean);
  return flags;
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
 * Whether the command redirects into `file`, so the copy on disk is stale by
 * the time `gh` reads it.
 */
function writesTo(shell, file) {
  const escaped = file.replace(REGEX_SPECIAL, "\\$&");
  return new RegExp(String.raw`>\s*["']?${escaped}["']?(?:\s|$)`).test(shell);
}

function heredocIn(text, bodies) {
  const marker = HEREDOC_MARK.exec(text);
  return marker ? bodies[Number(marker[1])] : null;
}

/**
 * The body a `gh issue create` would publish, from the shapes
 * docs/agents/issue-tracker.md prescribes: a `-F` file, a heredoc on stdin
 * for `-F -`, or a `--body` value, inline or a heredoc. Null when the hook
 * cannot read it.
 */
function issueBody(flags, rest, shell, bodies, base) {
  if (flags.bodyFile) {
    const { value } = flags.bodyFile;
    if (value === "-") {
      return heredocIn(rest, bodies);
    }
    const path = writesTo(shell, value) ? null : bodyFilePath(value, base);
    return path === null ? null : readRegularFile(path);
  }
  if (flags.body) {
    const { raw, value } = flags.body;
    const heredoc = heredocIn(raw, bodies);
    if (heredoc !== null) {
      return heredoc;
    }
    return SHELL_ONLY.test(raw) ? null : value;
  }
  return null;
}

/**
 * What a `gh issue create` in `text` falls short of its form by, or nothing
 * when the command creates no issue the hook can read.
 */
function formProblems(text, base, check) {
  const { bodies, shell } = splitHeredocs(text);
  const invocation = invocationIn(shell);
  if (!(check && invocation)) {
    return [];
  }
  const rest = shell.slice(invocation.index + invocation[0].length);
  const flags = issueFlags(words(rest));
  if (flags.noBody) {
    return [];
  }
  const body = issueBody(flags, rest, shell, bodies, base);
  return body === null ? [] : check(body, flags.labels);
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
