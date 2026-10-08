# Dev Tooling Upgrade: Ultracite/Biome + Tauri E2E Migration (Spec)

**Status:** validated by user 2026-07-23. Decisions: (1) use Ultracite's 2-space default, full reformat authorized; (2) feature flag name `e2e-driver` confirmed; (3) do this work on a branch (`feat/ultracite-and-e2e-migration`), not directly on `main`; (4) separate commits per part: build fixes + PRD already committed and pushed straight to `main` (explicitly authorized, outside this branch's scope); (5) new e2e CI job runs non-blocking/informational until proven stable.

**Amendment 2026-07-24 (mid-implementation, resolved with user):** Task 5 discovered that `tauri-plugin-wdio-webdriver` forces a `tauri` 2.9.1 → 2.11.5 bump for the *entire* project, not just the `e2e-driver` feature (Cargo.lock has no per-feature scoping, and the straightforward 2.10.x bump didn't even compile due to an upstream version-skew bug). User chose to accept this bump as part of the branch. See the plan's Task 5 deviation note for full detail. This means the "e2e migration is isolated from the production build path" assumption in the original Global Constraints no longer holds. Flag this prominently in the final whole-branch review and in anything communicated back to the user as "done," since the Tauri version bump is compile-verified only, not runtime-verified (no display in this sandbox).

## Background

Starting point for this work:

- `main` has no working lint setup (`npm run lint` prompts to configure ESLint interactively; there's no config file and `eslint` isn't even a dependency).
- `e2e-tests/` (added in PR #223, merged) drives the real desktop app via a hand-rolled `tauri-driver` + WebdriverIO setup. It only supports Windows and Linux, because raw `tauri-driver` has no WKWebView driver for macOS.
- Current Tauri docs recommend `@wdio/tauri-service` for e2e testing (not Playwright, since Tauri renders through each platform's native webview rather than Chromium everywhere), and that service's `embedded` driver provider (via `tauri-plugin-wdio-webdriver`) adds native macOS support with no external driver.
- The user asked to adopt Biome via Ultracite for linting/formatting, and to migrate the e2e setup to match current Tauri guidance. This spec covers both.

## Goals

1. Working, zero-config lint/format tooling (Ultracite + Biome) that catches real issues without derailing the repo with an unrelated mass reformat.
2. E2E testing that matches current Tauri guidance and adds macOS coverage, without expanding scope beyond what the existing spec file actually needs.
3. Land both without breaking the currently-green push-to-`main` CI build, given parts of this can't be fully verified in this sandbox (no display, can't spawn a real WebDriver session).

## Non-goals

- Not touching PR #207 (vendored binaries, still open) or its formatting.
- Not adopting `tauri-plugin-wdio` (the execute/mock/log-forwarding plugin), confirmed by reading all of `e2e-tests/test/specs/app.e2e.ts`: it only calls plain WebdriverIO globals (`browser.execute`, `browser.waitUntil`, `browser.url`, `browser.refresh`, `browser.pause`, `browser.getUrl`), never `browser.tauri.execute()` / `browser.tauri.mock()`. Adding that plugin would require `withGlobalTauri`, a new `wdio:default` capability, and a frontend plugin import into a Next.js static export: real complexity with no current caller.
- Not running the migrated e2e suite end-to-end in this session; this sandbox has no display and can't spawn tauri-driver/a WebDriver session. Verification here is limited to "compiles, config matches current docs, feature-gating is confirmed empirically via `cargo build`." Actually running the suite happens in CI or on the user's machine.

## Part 1: Ultracite / Biome

- Run `ultracite init` non-interactively: `--pm npm --linter biome --frameworks react next --quiet` (with `CI=true` to force quiet mode per the skill's own guidance).
- **Decision (confirmed):** use Ultracite's default 2-space indent, no override. This means `ultracite fix` will reformat the existing tab-indented codebase to 2-space, producing a large whitespace-churn diff across most files in one commit. That's expected and authorized; it should still be its own commit, separate from any non-formatting lint fixes, so the history distinguishes "reformat" from "behavior-affecting fix."
- Run `ultracite check` (read-only) first and report the violation count/categories before running `ultracite fix`, so the fix diff size is known before it's applied.
- Run `ultracite fix`, then re-run `npm run build`, `npm test`, and `cargo test`/`cargo check` to confirm nothing broke.
- Any violations `fix` can't auto-resolve get fixed by hand or, if genuinely out of scope, called out explicitly rather than silently suppressed.

## Part 2: E2E migration to `@wdio/tauri-service`

### Frontend / WDIO config
- Add `@wdio/tauri-service` to `e2e-tests/package.json` devDependencies.
- Rewrite `e2e-tests/wdio.conf.js`:
  - Replace the manual `spawnSync`/`spawn` calls that build the app and launch `tauri-driver` with the service's `services: [['@wdio/tauri-service', { driverProvider: 'embedded' }]]` entry (embedded is also the default; being explicit documents the choice).
  - Keep `capabilities: [{ browserName: 'tauri', 'tauri:options': { application: <path to debug binary> } }]`.
  - Keep the existing `onPrepare` app-build step (still needed; the service doesn't build the app for you) and keep building `--debug --no-bundle` as today (debug/release is orthogonal to Cargo features; no reason to switch and pay the slower release-build cost). Just add `--features e2e-driver` to that build command so the embedded driver plugin is actually compiled in for this build.
  - Drop the macOS warning console message in `onPrepare`, since macOS becomes supported.
  - Preserve the existing watch-mode (`E2E_WATCH`) and signal-cleanup behavior as closely as the new service allows.

### Rust / Cargo
- Add `tauri-plugin-wdio-webdriver` as an **optional** dependency gated by a new Cargo feature (name: `e2e-driver`), *not* `[target.'cfg(debug_assertions)'.dependencies]`; that pattern is a known-broken Cargo idiom (`debug_assertions` doesn't vary at dependency-resolution time; see `rust-lang/cargo#7634`). Sketch:

  ```toml
  [dependencies]
  tauri-plugin-wdio-webdriver = { version = "1", optional = true }

  [features]
  e2e-driver = ["dep:tauri-plugin-wdio-webdriver"]
  ```

- In `src-tauri/src/main.rs`, register the plugin only when the feature is enabled:

  ```rust
  let builder = tauri::Builder::default();

  #[cfg(feature = "e2e-driver")]
  let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

  builder
      .plugin(tauri_plugin_opener::init())
      // ...existing plugins...
  ```

- **Empirically verify, don't just reason about it:** run `cargo build --release` (feature off) and `cargo build --release --features e2e-driver` (feature on) locally and confirm both succeed before this touches `main`. This directly protects the currently-green push-to-`main` CI build, which exercises the default (feature-off) path.
- The e2e build step in `wdio.conf.js` passes the feature through via Tauri CLI's `-f`/`--features` flag (verified against the installed `@tauri-apps/cli` 2.6.2: `npm run tauri build -- --debug --no-bundle --features e2e-driver`).
- No capability/permission file changes: `tauri-plugin-wdio-webdriver` is an in-process HTTP server with no IPC command surface, so nothing needs to go in `src-tauri/capabilities/migrated.json`.

### CI
- Update `.github/workflows/test-on-pr-and-push.yml` (or a new workflow) to run the e2e suite on Windows and Ubuntu (installing `webkit2gtk-driver` there isn't needed anymore since the embedded provider doesn't require it, but Linux still needs the usual WebKitGTK runtime libs already installed for the build). macOS e2e can be added too now that it's supported, budget permitting (flagging as optional/stretch rather than assumed).
- This is new CI surface, not just a config edit; happy to scope it as a separate task in the plan, including whether it blocks merges or runs informationally at first.

## Process decisions (resolved 2026-07-23)

1. **Biome indent**: use the 2-space default; full-repo reformat authorized, as its own commit.
2. **Feature flag name**: `e2e-driver`, confirmed.
3. **Branch**: `feat/ultracite-and-e2e-migration`, not direct-to-`main`.
4. **Commit structure**: the earlier build fixes + PRD were committed separately and already pushed straight to `main` (explicitly authorized). On this branch: Ultracite/Biome setup and the e2e migration are separate commits from each other, each further split as needed (e.g. "add ultracite config" vs. "reformat via ultracite fix").
5. **CI scope**: the new e2e job runs non-blocking/informational until proven stable; it does not gate merges yet.

Next step: task-by-task implementation plan (via `superpowers:writing-plans`), saved alongside this spec in `docs/superpowers/plans/`.
