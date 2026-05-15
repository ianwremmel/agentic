// esbuild bundler for the dispatch CLI.
//
// Produces dist/dispatch.cjs — a single self-contained CommonJS bundle that
// Node SEA (#18) will inject into a downloaded node binary. Source maps are
// emitted to dist/dispatch.cjs.map and stack traces resolve through them at
// runtime via the source-map-support shim baked into the banner.
//
// esbuild is scoped to **SEA artifact production only**. Tests, lint, and
// `node` dev runs all consume `.mts` sources directly via Node's native
// TypeScript support; this script exists purely because Node 22 SEA's
// `main` config key requires a single CommonJS file.
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
const buildTimestamp = new Date().toISOString();

mkdirSync(resolve(root, "dist"), { recursive: true });

const banner = [
  `// @ianwremmel/dispatch v${version}`,
  `// built ${buildTimestamp}`,
  `// SPDX-License-Identifier: ${pkg.license ?? "UNLICENSED"}`,
  `"use strict";`,
  // Source-map-support is deliberately not installed here.
  //
  // The single-executable-application (SEA) runtime restricts `require()` in
  // the main script to built-in modules. Installing source-map-support
  // (whether bundled or not) triggers internal `require()` calls that emit a
  // confusing runtime warning. We can revisit once Node SEA gains support
  // for bundled module loading. Stack traces still resolve to bundled source
  // positions when invoked under plain `node dist/dispatch.cjs`.
].join("\n");

await build({
  entryPoints: [resolve(root, "src/index.mts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: resolve(root, "dist/dispatch.cjs"),
  sourcemap: true,
  sourcesContent: false,
  external: [],
  banner: { js: banner },
  define: {
    "process.env.DISPATCH_VERSION": JSON.stringify(version),
    "process.env.DISPATCH_BUILD_TIMESTAMP": JSON.stringify(buildTimestamp),
  },
  legalComments: "none",
  logLevel: "info",
  // esbuild warns informationally when `import.meta` appears in CJS output;
  // it polyfills it correctly via __filename/pathToFileURL, and the bundled
  // CLI is exercised end-to-end by src/bundle.test.mts.
  logOverride: { "empty-import-meta": "silent" },
});
