/** @type {import('next').NextConfig} */
const pkg = require("./package.json");

/**
 * Inlined at build time. The browser build has no Tauri app API to ask for a
 * name or version, and reading package.json at runtime is not possible from a
 * static export, so these are baked in where they cannot drift from what
 * shipped. See src/lib/host/env.ts.
 */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_NAME: "LumiLab",
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  output: "export",
  // These dependencies ship ESM-only builds, so they need Next's (and next/jest's) transpilation step.
  transpilePackages: [
    "pretty-bytes",
    "react-error-boundary",
    "react-resizable-panels",
    "nuqs",
    "three",
    "zod",
    "d3",
    "@tauri-apps/api",
    "@tauri-apps/plugin-dialog",
    "@tauri-apps/plugin-fs",
    "@tauri-apps/plugin-opener",
    "@tauri-apps/plugin-os",
  ],
  turbopack: {
    // stub fs and path for client-side
    // for tiff.js compatibility
    resolveAlias: {
      fs: "./src/lib/empty-module.ts",
      path: "path-browserify",
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      // stub fs and path for client-side
      // for tiff.js compatibility
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: require.resolve("path-browserify"),
      };
    }
    return config;
  },
};

module.exports = nextConfig;
