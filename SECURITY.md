# Security

## Reporting a vulnerability

Report it privately through **Security > Report a vulnerability** on this
repository, not in a public issue. Say what an attacker can do, on which build
(web or desktop, which platform), and how to reproduce it. Expect an answer
within a week during the academic term.

## Where the risk is

- **The desktop app** is the real attack surface. Its webview reaches the file
  system through Tauri, under the grants in `src-tauri/capabilities/`. A script
  injected into the webview gets whatever those grants allow, so a new
  permission is reviewed as a security change.
- **The web build** is a static export with no server, so server-side
  advisories in Next.js do not reach it at runtime; they are still patched,
  because they reach the build.
- **The e2e harnesses** (`e2e-tests/`, `e2e-web/`) run only in CI and on
  contributors' machines, against the app's own build.

## Keeping dependencies patched

- Dependabot security updates are on for every lockfile: `/`, `e2e-tests/`,
  `e2e-web/` and `src-tauri/`. Routine updates are grouped weekly
  (`.github/dependabot.yml`).
- CodeQL default setup scans Actions, JavaScript and TypeScript, Python and Rust.
- Secret scanning and push protection are on.
- Every GitHub Action is pinned to a commit. The release workflow signs macOS
  builds with secrets that belong on the `release` environment, deployable only
  from `main`.

An alert with no fix upstream is dismissed with the reason in the alert, not
left open: today that is `glib` (pinned through Tauri's GTK 3 stack) and
`extract-zip` (no patched release; only the WebdriverIO harness uses it).
