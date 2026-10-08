# Triage labels

The engineering skills speak in five canonical triage roles. Four map to a label of
the same name; `wontfix` maps to GitHub's own close reason instead of a label. A
triaged issue carries one state label from this table and one category label.

| Role (skills)     | Here                                         | Meaning                                                             |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `needs-triage`    | label `needs-triage`                         | Awaiting evaluation. Where an untriaged issue lands first.          |
| `needs-info`      | label `needs-info`                           | Waiting on the reporter. Returns to `needs-triage` when they reply. |
| `ready-for-agent` | label `ready-for-agent`                      | Fully specified. An AFK agent can take it.                          |
| `ready-for-human` | label `ready-for-human`                      | Specified, but needs judgment, a lab capture, or manual testing.    |
| `wontfix`         | `gh issue close <n> --reason "not planned"`  | Will not be actioned. The closing comment gives the reason.         |

When a skill says to apply `wontfix`, close the issue as not planned and remove its
state label.

Category labels are the repo's existing ones: `bug`, `feature`, `task`, `epic`,
`research`, `design`, `performance`, `documentation`, `housekeeping`. Area labels
(`frontend`, `backend`, `rust`) are optional.
