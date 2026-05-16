import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const bundle = resolve(root, "dist/dispatch.cjs");
const bundleMap = resolve(root, "dist/dispatch.cjs.map");

describe("dist/dispatch.cjs bundle", () => {
  // The bundle MUST exist when tests run. `npm test` produces it via
  // `npm run bundle`; CI does the same. If the build breaks, this fails
  // loudly instead of silently skipping.
  it("exists (run `npm run bundle` first)", () => {
    assert.ok(
      existsSync(bundle),
      `${bundle} missing — run \`npm run bundle\` before \`npm test\``,
    );
  });

  it("emits a sibling source map", () => {
    assert.ok(existsSync(bundleMap), `${bundleMap} missing`);
  });

  it("has a banner declaring version, build timestamp, and license", () => {
    const head = readFileSync(bundle, "utf8")
      .split("\n")
      .slice(0, 6)
      .join("\n");
    assert.match(head, /@ianwremmel\/dispatch v/);
    assert.match(head, /built \d{4}-\d{2}-\d{2}T/);
    assert.match(head, /SPDX-License-Identifier:/);
  });

  it("runs as a self-contained CJS file and exits 0", () => {
    const out = execFileSync(process.execPath, [bundle], {
      encoding: "utf8",
    });
    assert.match(out, /^dispatch \d+\.\d+\.\d+/);
  });

  it("has stable head structure", () => {
    const head = readFileSync(bundle, "utf8").split("\n").slice(0, 5);
    assert.equal(head[0], "#!/usr/bin/env node");
    assert.match(head[1] ?? "", /^\/\/ @ianwremmel\/dispatch v/);
    assert.match(head[2] ?? "", /^\/\/ built /);
    assert.ok(statSync(bundle).size > 0);
  });
});
