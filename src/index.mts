#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  void argv;
  process.stdout.write(`dispatch ${getVersion()}\n`);
  return 0;
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
  process.exit(main());
}
