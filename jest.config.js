const nextJest = require("next/jest");

/** @type {import('jest').Config} */
const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

// Add any custom config to be passed to Jest
const config = {
  coverageProvider: "babel",
  // Mirrors the "@/*" -> "./src/*" alias in tsconfig.json so tests can mock
  // modules by the same specifier the source imports them with.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testEnvironment: "jsdom",
  // The two end-to-end suites drive real browsers and have their own runners.
  // Without this, Jest collects the Playwright specs and fails on
  // `@playwright/test` refusing to be imported outside a Playwright process.
  testPathIgnorePatterns: [
    "<rootDir>/node_modules/",
    "<rootDir>/e2e-tests/",
    "<rootDir>/e2e-web/",
    // The hdrgen benchmark's tests, the rule scripts' and the Claude Code
    // hooks' run under `node --test` (`npm run test:scripts`), not Jest. Jest
    // does collect `.mjs`, so without this it pulls them into the jsdom
    // environment where `node:test` has no meaning.
    "<rootDir>/scripts/",
    "<rootDir>/.claude/",
    "<rootDir>/out/",
  ],
};

// next/jest builds its own `transformIgnorePatterns` from the ESM-only
// packages it finds in package.json and discards whatever the caller passes.
// It spots `d3` (a direct dependency) but not the `d3-*` packages d3 itself
// pulls in, so importing any d3 entry point still blows up on `export`. These
// are spliced into next's own allow-list rather than added as extra patterns:
// a path is ignored when *any* pattern matches, so a new pattern would not
// undo an existing match.
const EXTRA_ESM_PACKAGES = [
  "d3-[^/]+",
  "internmap",
  "delaunator",
  "robust-predicates",
].join("|");

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = async () => {
  const nextConfig = await createJestConfig(config)();
  return {
    ...nextConfig,
    transformIgnorePatterns: (nextConfig.transformIgnorePatterns ?? []).map(
      (pattern) =>
        pattern.includes("/node_modules/")
          ? pattern.replace("(?!(", `(?!(${EXTRA_ESM_PACKAGES}|`)
          : pattern
    ),
  };
};
