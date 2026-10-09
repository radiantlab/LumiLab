# Contributing

Contributions are limited to the Architectural Lighting Design Capstone at Oregon
State University; `README.md` says how to get in touch. This file is the process
and the gates. `AGENTS.md` holds the rules every change follows, for people and
agents alike.

## The process

1. An issue first. It is the spec: say what is wrong or wanted, and where.
2. Fetch, then branch from `origin/main`, named after the issue: `123-short-name`.
3. Commit with a Conventional Commits subject (`AGENTS.md`). Stage files by name.
4. Push and open a pull request against `main`. The template asks what you ran.
5. **Run the review loop.** `mattpocock-skills:code-review` against `origin/main`,
   repeated until a pass raises nothing you have not answered. Answered means fixed
   or declined in writing, so a pass whose findings you all declined ends it. Later
   passes review the code earlier ones made you write. Record the pass count and
   each decline under `## Review loop` in the PR body; on a Dependabot PR, whose
   body the bot rewrites, in a PR comment. A harness that cannot run the plugin
   says so there and reviews the diff against `AGENTS.md` by hand.
6. A team member reviews it; the checks go green; squash-merge. The PR title
   becomes the commit subject on `main`, so it follows the same rule.
7. Delete the branch.

`npm install` installs the git hooks through `prepare` (lefthook). Without them
the same rules still fail in CI, just later.

## The gates

| Rule | Local (lefthook) | Claude Code hook | CI |
| --- | --- | --- | --- |
| Conventional subject; no emdash, emoji or session link in the message | `commit-msg` | `guard-git.mjs` reads the `-m` text first | `ci-web` walks the PR's commits; `pr-text` checks the title and body |
| No emdash or emoji in tracked prose and code | `pre-commit`, staged files | `after-edit.mjs` on the edited file | `ci-web`: `npm run check:prose` |
| No session link in PR or issue text | (never sees it) | `guard-gh.mjs` refuses the command | `pr-text`, for the PR title and body |
| Stage by name; never commit on `main` | `pre-commit` branch check | `guard-git.mjs` | the `main` ruleset, once configured |
| No force push at `main`, `reset --hard`, `clean -f`, `branch -D` | | `guard-git.mjs` | the `main` ruleset (force push) |
| Generated files are not hand-edited (`src-tauri/gen/`, `public/wasm/`) | | `guard-edits.mjs` | |
| Biome clean | `pre-commit`, staged files | `after-edit.mjs` | `ci-web`: `npm run check` |
| `cargo fmt` clean | `pre-commit`, when Rust is staged | | `ci-desktop`: Rust checks |
| Typecheck and unit suite green | `pre-push` | | `ci-web` |
| Clippy, the Tauri build on three platforms | | | `ci-desktop` |
| Both e2e suites green | you, when a covered path changes | | `ci-web` (WebKit, Chromium), `ci-desktop` (Linux, Windows) |

Skipping locally: `LEFTHOOK=0 git commit` or `--no-verify`. The Claude Code hooks
and CI still apply.

## Which suites to run yourself

- **Unit (`npm test`)**: always, and pre-push runs it anyway.
- **Web e2e (`npm run test:e2e:web`)**: a change to anything a browser user
  touches: upload, the pipeline page, downloads, the viewer.
- **Desktop e2e (`npm run test:e2e:desktop`)**: a change to `src/lib/host/`,
  `src-tauri/`, or any path that differs between the two hosts (dialogs, writing
  to the output folder, revealing a file).
- **Clippy**: any change under `src-tauri/`.

## Working with Claude Code

`.claude/settings.json` registers the hooks under `.claude/hooks/`, the middle
column above. A refusal is a hook naming the rule, with the reason as its
message; fix the command rather than working around it. The `SessionStart` hook
prints the branch, a dirty tree, the Node against `.nvmrc` and the Rust against
`rust-toolchain.toml`.

`.claude/settings.json` also enables the `mattpocock-skills` plugin from the
official marketplace; trust the project folder and Claude Code offers to install
it. `docs/agents/` is what its skills read about this repo: the issue tracker, the
triage labels, the domain docs and the code-review deltas.

## Dependencies

Dependabot opens one grouped pull request per ecosystem a week
(`.github/dependabot.yml`), holding back any release younger than seven days.
Security updates arrive as soon as an advisory does. Both get the same review as
any other pull request.
