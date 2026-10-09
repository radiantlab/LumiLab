# Issue tracker: GitHub

Issues for this repo live as GitHub issues on `radiantlab/LumiLab`. Use the `gh`
CLI for all operations.

## What an issue is here

**The issue is the spec**, as `CONTRIBUTING.md` says: what is wrong or wanted, and
where. The pull request that closes it is the plan, and its branch carries the
number (`123-short-name`). `docs/superpowers/` holds older specs and plans, kept as
history.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`, with a heredoc
  for a multi-line body. `.claude/hooks/guard-gh.mjs` refuses a body with an
  emdash, an emoji or a `claude.ai/code/session` link.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq ...`
  with `--label` filters.
- **Comment**: `gh issue comment <number> --body "..."`.
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
  The vocabulary is in [`triage-labels.md`](./triage-labels.md).
- **Close**: `gh issue close <number> --comment "..."`. A pull request closes its
  issue with `Closes #N` in the body.

## Pull requests as a triage surface

**PRs as a request surface: no.** Pull requests come from the capstone team or
Dependabot and go through the review loop in step 5 of `CONTRIBUTING.md`, not
through triage.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either;
resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes /
  Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the
  sub-issues endpoint). Where sub-issues are not enabled, add the child to a task
  list in the map body and put `Part of #<map>` at the top of the child body.
  Labels: `wayfinder:<type>` (`research`, `prototype`, `grilling`, `task`). Once
  claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's native issue dependencies. Add an edge with
  `gh api --method POST repos/radiantlab/LumiLab/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`,
  where `<blocker-db-id>` is the blocker's numeric database id
  (`gh api repos/radiantlab/LumiLab/issues/<n> --jq .id`, not the `#number`). Where
  dependencies are not available, fall back to a `Blocked by: #<n>` line at the top
  of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: the map's open children with no open blocker and no assignee;
  first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`,
  then append a context pointer (gist plus link) to the map's Decisions-so-far.
