import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getVersion, main } from "./index.mts";

describe("dispatch entrypoint", () => {
  it("exposes a version string", () => {
    assert.match(getVersion(), /^\d+\.\d+\.\d+/);
  });

  it("returns SUCCESS (0) on no-args (prints top-level help)", async () => {
    const writes: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await main([]);
      assert.equal(code, 0);
      assert.match(writes.join(""), /Usage: dispatch <command>/);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });
});
