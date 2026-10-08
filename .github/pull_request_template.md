Closes #

<!-- What changed and why, from the reader's side. Two to five bullets. -->

-

## Ran locally

<!-- Keep the lines that ran, delete the rest. `typecheck` and `test` also run
     at pre-push; the suites are yours to choose per CONTRIBUTING.md. -->

- `npm run check`, `npm run typecheck`, `npm test`
- `npm run test:e2e:web` (a browser-visible path touched)
- `npm run test:e2e:desktop` (`src/lib/host/`, `src-tauri/`, or a host-specific path touched)
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` (Rust touched)

## Review loop

<!-- AGENTS.md: mattpocock-skills:code-review against origin/main until a pass
     raises nothing unanswered. State the pass count; a declined finding gets
     one line with the reason. -->

- Passes:
- Declined:

## Tauri permissions

<!-- Only when src-tauri/capabilities/ changed: each permission added, and the
     frontend call that needs it. Otherwise delete this section. -->

-

## Screenshots

<!-- A UI change: the page before and after. Otherwise delete this section. -->
