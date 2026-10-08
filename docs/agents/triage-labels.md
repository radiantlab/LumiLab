# Triage labels

The engineering skills speak in five canonical triage roles. This repo uses the same
strings, so the mapping is the identity. A triaged issue carries one state label
from this table and one category label. `wontfix` predates this file; the other
four were added for these skills, and `gh issue edit --add-label` fails on a label
the repo does not have.

| Role (skills)     | Label here        | Meaning                                                             |
| ----------------- | ----------------- | ------------------------------------------------------------------- |
| `needs-triage`    | `needs-triage`    | Awaiting evaluation. Where an untriaged issue lands first.          |
| `needs-info`      | `needs-info`      | Waiting on the reporter. Returns to `needs-triage` when they reply. |
| `ready-for-agent` | `ready-for-agent` | Fully specified. An AFK agent can take it.                          |
| `ready-for-human` | `ready-for-human` | Specified, but needs judgment, a lab capture, or manual testing.    |
| `wontfix`         | `wontfix`         | Will not be actioned. Closed with the reason.                       |

Category labels are the repo's existing ones: `bug`, `feature`, `task`, `epic`,
`research`, `design`, `performance`, `documentation`, `housekeeping`. Area labels
(`frontend`, `backend`, `rust`) are optional.

