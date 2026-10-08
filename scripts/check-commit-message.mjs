/**
 * The commit-message rules from AGENTS.md, as a check: a Conventional
 * Commits subject with a lowercase imperative, no emdash or emoji anywhere,
 * and never a `claude.ai/code/session` link.
 *
 * One implementation, three callers. lefthook runs it at `commit-msg`, CI runs
 * it over every commit a pull request adds (`--range`) and over the PR title
 * and body, which a squash merge turns into the `main` subject and body, and
 * the Claude Code `git` hook runs it on the text of a `git commit` before the
 * commit exists.
 *
 * The session-link rule is the hard one: the repo is public, so a link that
 * lands on `main` costs a history rewrite against a protected branch. It is
 * checked here first, before anything else can pass.
 *
 * Usage:
 *   node scripts/check-commit-message.mjs <file>          the COMMIT_EDITMSG path
 *   node scripts/check-commit-message.mjs --text <str>    a message as a string
 *   node scripts/check-commit-message.mjs --stdin         a message on stdin
 *   node scripts/check-commit-message.mjs --range <a..b>  every commit in a range
 *
 * Only the file form strips git's `#` comment lines and the scissors block,
 * because only COMMIT_EDITMSG carries them. A pull request body arrives on
 * stdin and its `## Heading` lines are prose to check, not comments to drop.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findProseViolations, gitLines } from "./check-prose.mjs";

const TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "refactor",
  "style",
  "perf",
  "build",
  "ci",
  "chore",
];

/**
 * `type(scope)!: subject`, scope optional. "Lowercase imperative" is checked
 * as "does not start with a capital letter", in any script, so a subject may
 * lead with a digit, a quote or an identifier in backticks.
 */
const SUBJECT = new RegExp(
  `^(?:${TYPES.join("|")})(?:\\([a-z0-9-]+\\))?!?: (?!\\p{Lu})\\S`,
  "u"
);

/**
 * Subjects written by git, GitHub and Dependabot, which the rule does not
 * reach. Dependabot capitalizes "Bump" and offers no setting to change it;
 * AGENTS.md accepts its `chore(deps)` and `build(deps)` commits as they come.
 */
const EXEMPT_SUBJECT =
  /^(?:Merge |Revert |fixup! |squash! |(?:chore|build)\(deps(?:-dev)?\): Bump )/;

const SESSION_LINK = "claude.ai/code/session";
const SCISSORS = /^# -{8,} >8 -{8,}$/m;

/**
 * A COMMIT_EDITMSG without git's comment lines and without anything after the
 * scissors line `git commit --verbose` adds.
 */
function stripCommentary(message) {
  const scissors = SCISSORS.exec(message);
  const body = scissors ? message.slice(0, scissors.index) : message;
  return body
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
}

/**
 * Every problem with `message`, as strings a committer can act on. Empty
 * means the message passes.
 */
export function checkCommitMessage(message) {
  const problems = [];

  if (message.includes(SESSION_LINK)) {
    problems.push(
      `contains a ${SESSION_LINK} link; drop it, keep the Co-Authored-By trailer`
    );
  }

  const subject =
    message.split("\n").find((line) => line.trim().length > 0) ?? "";
  if (subject.length === 0) {
    problems.push("the message is empty");
  } else if (!(EXEMPT_SUBJECT.test(subject) || SUBJECT.test(subject))) {
    problems.push(
      `subject "${subject}" is not "type(scope): lowercase imperative" with type one of ${TYPES.join(", ")}`
    );
  }

  for (const { line, kind, snippet } of findProseViolations(message)) {
    problems.push(`line ${line} has an ${kind}: ${snippet}`);
  }

  return problems;
}

const RULE =
  "Commit rule: type(scope): lowercase imperative subject, no emdash, no emoji, no session link. See AGENTS.md.\n";

function report(label, problems) {
  for (const problem of problems) {
    process.stderr.write(`${label}: ${problem}\n`);
  }
}

function fail() {
  process.stderr.write(RULE);
  process.exit(1);
}

function main(argv) {
  const [mode, ...rest] = argv;

  if (mode === "--range") {
    // Merge commits are walked too: their subject is exempt, their body is
    // where a stray session trailer would sit.
    let failed = false;
    for (const sha of gitLines(["log", "--format=%H", rest[0]])) {
      const message = execFileSync("git", ["log", "-1", "--format=%B", sha], {
        encoding: "utf8",
      });
      const problems = checkCommitMessage(message);
      if (problems.length > 0) {
        failed = true;
        report(sha.slice(0, 7), problems);
      }
    }
    if (failed) {
      fail();
    }
    return;
  }

  let message;
  if (mode === "--text") {
    message = rest.join(" ");
  } else if (mode === "--stdin") {
    message = readFileSync(0, "utf8");
  } else {
    message = stripCommentary(readFileSync(mode, "utf8"));
  }

  const problems = checkCommitMessage(message);
  if (problems.length > 0) {
    report("commit message", problems);
    fail();
  }
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  main(process.argv.slice(2));
}
