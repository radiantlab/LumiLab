/**
 * Shared plumbing for the Claude Code hooks in this directory.
 *
 * A hook is a process that reads one JSON object on stdin and answers with an
 * exit code: 0 lets the tool call through, 2 blocks it and hands stderr to the
 * model as the reason. The `cwd` field, not `CLAUDE_PROJECT_DIR`, is where the
 * session is: inside a worktree the project dir still points at the main
 * checkout, and a session may start in a subdirectory, so the repository root
 * is resolved from `cwd` rather than assumed to be it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * `process.env` without the `GIT_*` keys a git hook exports. A hook that runs
 * git on the session's `cwd` with `GIT_DIR` still set gets an answer about
 * the wrong repository.
 */
export const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
);

export function readInput() {
  return JSON.parse(readFileSync(0, "utf8"));
}

/**
 * Block the tool call with a reason the model will read.
 */
export function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: cleanEnv,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function currentBranch(cwd) {
  return git(cwd, ["branch", "--show-current"]);
}

/**
 * The checkout that contains `cwd`, or `cwd` itself outside a repository.
 */
export function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
}

/**
 * A path as the repo scripts expect it: relative to the checkout root.
 */
export function repoRelative(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

/**
 * The repo's own rule scripts, loaded from the session's checkout so a
 * worktree checks against the code it carries. A session outside this repo
 * has no scripts and nothing to enforce, so the hook lets the call through.
 */
export async function loadRuleScripts(root) {
  if (!existsSync(`${root}/scripts/check-prose.mjs`)) {
    process.exit(0);
  }
  const [prose, commit] = await Promise.all([
    import(`${root}/scripts/check-prose.mjs`),
    import(`${root}/scripts/check-commit-message.mjs`),
  ]);
  return { ...prose, ...commit, ...(await loadIssueBodyCheck(root)) };
}

/**
 * The issue-form check, or nothing when this checkout cannot run it: a branch
 * from before the script, or a fresh worktree with no `node_modules` for its
 * `yaml` import. The `issue-body` workflow checks the issue either way.
 */
async function loadIssueBodyCheck(root) {
  if (!existsSync(`${root}/scripts/check-issue-body.mjs`)) {
    return {};
  }
  try {
    return await import(`${root}/scripts/check-issue-body.mjs`);
  } catch {
    return {};
  }
}
