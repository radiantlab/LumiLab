# Triage labels

The engineering skills speak in five canonical triage roles. Four map to a label of
the same name; `wontfix` maps to GitHub's own close reason instead of a label. An
open triaged issue carries one state label from this table and one category label.

| Role (skills)     | Here                                         | Meaning                                                             |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `needs-triage`    | label `needs-triage`                         | Awaiting evaluation. Where an untriaged issue lands first.          |
| `needs-info`      | label `needs-info`                           | Waiting on the reporter. Returns to `needs-triage` when they reply. |
| `ready-for-agent` | label `ready-for-agent`                      | Fully specified. An AFK agent can take it.                          |
| `ready-for-human` | label `ready-for-human`                      | Specified, but needs judgment, a lab capture, or manual testing.    |
| `wontfix`         | `gh issue close <n> --reason "not planned"`  | Will not be actioned. The closing comment gives the reason.         |

When a skill says to apply `wontfix`, close the issue as not planned and remove its
state label.

Category labels: `bug`, `feature`, `task`, `research`, `performance`,
`documentation`, `housekeeping`. A refactor is a `task`.

Area labels are optional, and an issue that spans areas carries each: `frontend`
(pages and components), `pipeline` (the WebAssembly image pipeline and its
worker), `rust` (`src-tauri/`).

Priority labels are optional and an issue carries at most one: `p0-now` (blocks
users or the current milestone), `p1-next` (taken up once the p0 work is done),
`p2-later` (wanted, not scheduled). An issue without one ranks after `p2-later`.
A maintainer sets the priority; a skill does not infer one.
