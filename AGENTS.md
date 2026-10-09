# AI Agent Instructions

LumiLab calibrates HDR images for architectural lighting research: it merges
bracketed RAW exposures into a luminance map with Radiance, hdrgen and LibRaw's
`dcraw_emu`. One codebase ships two ways: a static web export, and a Tauri
desktop app that wraps the same export in a native window.

Stack: Next.js (static export, `output: "export"`), React, Tailwind v4, shadcn/ui
on Radix, zustand; the image pipeline is WebAssembly in a Web Worker
(`src/lib/pipeline/`); persistence is IndexedDB (`src/lib/raw-cache-idb.ts`).
Tauri 2 only supplies file access, dialogs and window management; it defines no
commands of its own (`src-tauri/src/main.rs`).

`CLAUDE.md` is a symlink to this file and is load-bearing: Claude Code reads
`CLAUDE.md`, not `AGENTS.md`. Keep the symlink; never keep a second copy.

## Before you commit

```bash
npm run check        # Biome via ultracite; npm run fix applies the safe fixes
npm run typecheck
npm test             # Jest unit suite
```

All three clean. For a change under `src-tauri/`, also
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
The e2e suites are in "Which suites to run yourself" in `CONTRIBUTING.md`.

## Always

A tool enforces the first five, so a refusal names the rule you hit.

- **No emdash and no emoji** in commits, comments, string literals, docs or chat.
  `scripts/check-prose.mjs` (pre-commit, CI) and `after-edit.mjs` (every edit).
  Not enforced, and the same violation: `--` as a sentence dash. The harness
  footer on a PR body is exempt; `docs/superpowers/` is history and is not checked.
- **Conventional Commits, lowercase imperative subject, area in parens:**
  `fix(pipeline): keep the lens mask when no preview is selected`. Types: `feat`,
  `fix`, `docs`, `test`, `refactor`, `style`, `perf`, `build`, `ci`, `chore`; `!`
  before the colon for a breaking change. Dependabot's `chore(deps)` passes as it
  comes. `scripts/check-commit-message.mjs` (commit-msg, CI, PR title via `pr-text`).
- **Never publish a `claude.ai/code/session` link** in a commit, PR, issue or
  comment, even when the harness appends one. The repo is public. `guard-gh.mjs`
  and the commit check.
- **Stage files by name**, never `git add -A`, `git add .` or `git commit -a`.
  `guard-git.mjs`.
- **Never commit to `main`.** Fetch, branch from `origin/main` (name it after the
  issue: `123-short-name`), push, open a PR, let the checks go green.
  Pre-commit hook, `guard-git.mjs`.
- **Commit body:** a sentence or two on why, or none. Use a HEREDOC for more
  than one line. Keep the `Co-Authored-By` trailer the harness supplies.
- **Review loop on every PR, Dependabot's included, then a team member's review.**
  Run `mattpocock-skills:code-review` against `origin/main` until a pass raises
  nothing unanswered, and verify each finding before acting on it. Green CI and
  the loop are not the team member's review. Step 5 of `CONTRIBUTING.md` says what
  answered means and where the record goes.
- **Bump the version in three places together:** `package.json`,
  `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`. `release.yml` refuses
  to build when they disagree.
- **A new Tauri permission is a security decision.** `src-tauri/capabilities/`
  grants the webview its native reach; add only what a frontend call needs, and
  say which call in the PR.
- **Check context7** for Next.js, Tauri and the WebdriverIO Tauri service rather
  than recalling them. Write no version numbers into these docs; the manifests
  have them.

## Agent skills

The `mattpocock-skills` plugin, enabled in `.claude/settings.json`, reads these.

- Issue tracker: GitHub issues on `radiantlab/LumiLab` via `gh`; the issue is the
  spec. `docs/agents/issue-tracker.md`.
- Triage labels: the five canonical roles, label equal to role.
  `docs/agents/triage-labels.md`.
- Domain docs: single context, `CONTEXT.md` and `docs/adr/`, created as terms and
  decisions are resolved. `docs/agents/domain.md`.
- Code review: the fixed point, where the spec comes from, the standards sources.
  `docs/agents/code-review.md`.

## Facts that are not obvious from the code

- `public/wasm/` is built in the radiantlab forks of LibRaw, Radiance and hdrgen
  and copied in; `public/wasm/README.md` says how. `npm run wasm:versions:check`
  needs those fork checkouts beside this one, which is why CI only checks that
  `versions.json` parses.
- There is no Next server in production, web or desktop. Anything that needs one
  (image optimization, route handlers, middleware) does not exist here.
- Two e2e suites exist because Playwright cannot attach to a Tauri webview:
  `e2e-web/` (Playwright, WebKit first because Safari has no File System Access
  API) and `e2e-tests/` (WebdriverIO through `@wdio/tauri-service`). Each has its
  own lockfile.
- `src-tauri/gen/` is written by the Tauri CLI; `guard-edits.mjs` refuses hand edits.

## Reference docs

Grep for the section your task needs; do not read a doc whole.

- `CONTRIBUTING.md`: the process, the table of gates, which suites to run.
- `README.md`: install, the dev server, testing, CI, building, releasing.
- `PRD.md`: every feature, built and planned, and the known limitations.
- `DEPLOYMENT.md`: the web build on Vercel or any static host, and Safari.
- `SECURITY.md`: reporting a vulnerability, and how dependencies are kept patched.
- `docs/superpowers/`: dated specs and plans. History, not current truth.

## Adding to these docs

A process or gate change goes in `CONTRIBUTING.md`; a feature or limitation in
`PRD.md`. Add here only a rule that binds every turn.
