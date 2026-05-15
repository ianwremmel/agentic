import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getVersion, main } from "./index.mts";

describe("dispatch entrypoint", () => {
  it("exposes a version string", () => {
    assert.match(getVersion(), /^\d+\.\d+\.\d+/);
  });

  it("prints `dispatch <version>` and exits 0", () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = main([]);
      assert.equal(code, 0);
      assert.equal(writes.join(""), `dispatch ${getVersion()}\n`);
    } finally {
      process.stdout.write = original;
    }
  });
});
