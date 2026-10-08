# Code review

`mattpocock-skills:code-review` runs on every pull request, as `AGENTS.md` says,
before a team member is asked to review. Local deltas from the skill's default
brief:

- **The fixed point is `origin/main`.** Fetch first, so the diff is the branch's
  own commits.
- **The spec is the issue** in the PR's `Closes #N`, or the number the branch name
  starts with (`123-short-name`). Fetch it with `gh issue view <n> --comments`.
  With neither, the skill's own fallback applies: ask the user where the spec is.
- **The Standards axis reads these sources and no others:** `AGENTS.md`, and
  `CONTEXT.md` and the ADRs under `docs/adr/` that touch the diff once they exist.
  `README.md`, `DEPLOYMENT.md`, `PRD.md` and `CONTRIBUTING.md` describe the project,
  not how its code is written, so they are not standards sources. Biome, the prose
  check and the commit-message check already enforce their rules; skip those.
