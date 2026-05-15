#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./cli/run.mts";

export function getVersion(): string {
  // Injected by esbuild at bundle time (see scripts/bundle.mjs). When running
  // unbundled (Node's native TS support, tests, dev), fall back to reading
  // package.json from disk.
  const fromBundle = process.env.DISPATCH_VERSION;
  if (fromBundle && fromBundle.length > 0) return fromBundle;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return run({ argv, version: getVersion() });
}

const isDirectRun = (() => {
  // The bundler defines DISPATCH_VERSION at build time; presence of that
  // sentinel signals we are running inside the bundled CLI, where the entry
  // is always this module.
  if (process.env.DISPATCH_VERSION) return true;
  if (typeof process.argv[1] !== "string") return false;
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Last-ditch guard: run() should never throw, but if it does we
      // still need to surface something useful.
      process.stderr.write(
        `dispatch: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
