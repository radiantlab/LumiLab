# Domain docs

How the engineering skills consume this repo's domain documentation when exploring
the codebase. Single context: one `CONTEXT.md` at the repo root and `docs/adr/` for
decisions.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary. Each term with the words to
  avoid; no implementation detail.
- **`docs/adr/`**: one file per decision that is hard to reverse, surprising
  without context, and the result of a real trade-off. Numbered `NNNN-slug.md`.
  Read the ones that touch the area you are about to work in.

Neither exists yet. Where one is absent, proceed silently: `/domain-modeling`
(reached through `/grill-with-docs` and `/improve-codebase-architecture`) creates
them the first time a term or decision is resolved.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a test name, a refactor
proposal), use the term the glossary defines, not a synonym it avoids. If the
concept you need is not in the glossary, either you are inventing language the
project does not use (reconsider) or there is a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts a recorded decision, say so rather than silently
overriding it:

> Contradicts ADR-0003 (...), but worth reopening because...
