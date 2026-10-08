/**
 * SessionStart: the facts every session used to have to be told, printed into
 * context. Branch and whether it is main, uncommitted changes, the Node in use
 * against `.nvmrc`, and whether the Rust in `rust-toolchain.toml` is installed.
 * No network, and nothing that installs: `rustc --version` inside this repo
 * would make rustup download the pinned toolchain, so it is not called.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cleanEnv, currentBranch, readInput, repoRoot } from "./lib.mjs";

const TIMEOUT = 5000;
const CHANNEL = /^\s*channel\s*=\s*"([^"]+)"/m;

/** The output, or "" for anything that went wrong, timeouts included. */
function run(file, args, dir) {
  try {
    return execFileSync(file, args, {
      cwd: dir,
      encoding: "utf8",
      env: cleanEnv,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TIMEOUT,
    }).trim();
  } catch {
    return "";
  }
}

/** A file's contents, or "" when this checkout does not have it. */
function read(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

const input = readInput();
const cwd = input.cwd ?? process.cwd();
const root = repoRoot(cwd);
const lines = [];

const branch = currentBranch(cwd) || "(detached)";
lines.push(
  branch === "main"
    ? "Branch: main. Do not commit here: fetch, then branch from origin/main first (AGENTS.md)."
    : `Branch: ${branch}.`
);

const dirty = run("git", ["status", "--porcelain"], cwd)
  .split("\n")
  .filter(Boolean).length;
lines.push(
  dirty === 0
    ? "Working tree: clean."
    : `Working tree: ${dirty} uncommitted path(s). Stage by name; they may be someone else's work in progress.`
);

const wanted = read(`${root}/.nvmrc`).replace(/^v/, "");
const node = process.version.replace(/^v/, "");
lines.push(
  wanted && !`${node}.`.startsWith(`${wanted}.`)
    ? `Node: ${node} on PATH, .nvmrc wants ${wanted}. Switch before running the tests.`
    : `Node: ${node}.`
);

// Listing installed toolchains reads rustup's own directory and installs
// nothing, unlike any command that resolves the active one.
const pinned = CHANNEL.exec(read(`${root}/rust-toolchain.toml`))?.[1];
if (pinned) {
  const installed = run("rustup", ["toolchain", "list"], root)
    .split("\n")
    .some((line) => line.startsWith(`${pinned}-`));
  lines.push(
    installed
      ? `Rust: ${pinned}, as rust-toolchain.toml pins.`
      : `Rust: rust-toolchain.toml pins ${pinned}, not installed yet; the first cargo command downloads it.`
  );
}

lines.push(
  "Gates: lefthook.yml at commit and push, the hooks under .claude/hooks in this session. CONTRIBUTING.md has the table."
);

process.stdout.write(`${lines.join("\n")}\n`);
