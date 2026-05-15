import { describe, expect, it, vi } from "vitest";
import { getVersion, main } from "./index.js";

describe("dispatch entrypoint", () => {
  it("exposes a version string", () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints `dispatch <version>` and exits 0", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      const code = main([]);
      expect(code).toBe(0);
      expect(writes.join("")).toBe(`dispatch ${getVersion()}\n`);
    } finally {
      spy.mockRestore();
    }
  });
});
