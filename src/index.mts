#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getVersion(): string {
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
