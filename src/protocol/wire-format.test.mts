import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { parseMarker, wrapComment, wrapReaction } from "./wire-format.mts";

const SPARKLE = "\u2728";

describe("wrapComment — Mode A", () => {
  it("prepends the machine marker as a single first line", () => {
    const post = wrapComment({
      agentId: "dispatch",
      mode: "A",
      body: "looks good",
    });
    assert.equal(post, "<!-- agent-reply:dispatch -->\nlooks good");
  });

  it("does not apply the sparkle wrapper", () => {
    const post = wrapComment({ agentId: "dispatch", mode: "A", body: "hi" });
    assert.ok(!post.includes(SPARKLE));
  });

  it("preserves multi-line bodies verbatim", () => {
    const body = "line one\n\nline three";
    const post = wrapComment({ agentId: "x", mode: "A", body });
    assert.equal(post, `<!-- agent-reply:x -->\n${body}`);
  });

  it("accepts a missing agent id and emits the bare marker", () => {
    const post = wrapComment({ mode: "A", body: "anon" });
    assert.equal(post, "<!-- agent-reply -->\nanon");
  });
});

describe("wrapComment — Mode B", () => {
  it("wraps the body in a sparkle block after the marker", () => {
    const post = wrapComment({
      agentId: "dispatch",
      mode: "B",
      body: "the implementation looks correct.",
    });
    assert.equal(
      post,
      "<!-- agent-reply:dispatch -->\n" +
        `${SPARKLE}\n` +
        "\n" +
        "the implementation looks correct.\n" +
        "\n" +
        SPARKLE,
    );
  });

  it("passes sparkle characters in the body through unchanged", () => {
    const body = `pretty ${SPARKLE} indeed`;
    const post = wrapComment({ agentId: "x", mode: "B", body });
    assert.ok(post.includes(body));
  });

  it("uses exactly one blank line on each side of the body", () => {
    const post = wrapComment({
      agentId: "x",
      mode: "B",
      body: "b",
    });
    const lines = post.split("\n");
    assert.equal(lines[0], "<!-- agent-reply:x -->");
    assert.equal(lines[1], SPARKLE);
    assert.equal(lines[2], "");
    assert.equal(lines[3], "b");
    assert.equal(lines[4], "");
    assert.equal(lines[5], SPARKLE);
    assert.equal(lines.length, 6);
  });
});

describe("wrapComment — agent-ID escaping", () => {
  it("accepts the ABNF characters", () => {
    for (const id of ["a", "Z9", "agent-id_1.0", "Copilot"]) {
      assert.doesNotThrow(() =>
        wrapComment({ agentId: id, mode: "A", body: "" }),
      );
    }
  });

  it("rejects ids with whitespace", () => {
    assert.throws(
      () => wrapComment({ agentId: "ag ent", mode: "A", body: "" }),
      /invalid agent id/,
    );
  });

  it("rejects ids that try to break out of the marker", () => {
    assert.throws(
      () => wrapComment({ agentId: "x -->\n<script>", mode: "A", body: "" }),
      /invalid agent id/,
    );
  });

  it("rejects the empty string (would degrade to the bare marker)", () => {
    assert.throws(
      () => wrapComment({ agentId: "", mode: "A", body: "" }),
      /invalid agent id/,
    );
  });
});

describe("wrapReaction", () => {
  it("returns the body unchanged (no marker, no wrapper)", () => {
    assert.equal(wrapReaction("+1"), "+1");
    assert.equal(wrapReaction("eyes"), "eyes");
  });
});

describe("parseMarker", () => {
  it("recovers id and Mode A from a wrapComment round-trip", () => {
    const post = wrapComment({
      agentId: "dispatch",
      mode: "A",
      body: "hi\nthere",
    });
    assert.deepEqual(parseMarker(post), {
      agentId: "dispatch",
      mode: "A",
      body: "hi\nthere",
    });
  });

  it("recovers id and Mode B from a wrapComment round-trip", () => {
    const body = "hello\n\nworld";
    const post = wrapComment({ agentId: "dispatch", mode: "B", body });
    assert.deepEqual(parseMarker(post), {
      agentId: "dispatch",
      mode: "B",
      body,
    });
  });

  it("recovers a bare marker as agentId: undefined", () => {
    const post = "<!-- agent-reply -->\nx";
    assert.deepEqual(parseMarker(post), {
      agentId: undefined,
      mode: "A",
      body: "x",
    });
  });

  it("returns undefined when the first line is not a marker", () => {
    assert.equal(parseMarker("hi\n<!-- agent-reply:x -->"), undefined);
    assert.equal(parseMarker(""), undefined);
    assert.equal(parseMarker(" <!-- agent-reply -->"), undefined);
  });

  it("ignores stray trailing sparkles that are not a proper wrapper", () => {
    const post = `<!-- agent-reply:x -->\nhello\n${SPARKLE}`;
    assert.deepEqual(parseMarker(post), {
      agentId: "x",
      mode: "A",
      body: `hello\n${SPARKLE}`,
    });
  });

  it("requires the blank lines around the sparkle wrapper", () => {
    const malformed = `<!-- agent-reply:x -->\n${SPARKLE}\nbody\n${SPARKLE}`;
    assert.equal(parseMarker(malformed)?.mode, "A");
  });
});

describe("uniqueness", () => {
  it("emits the machine marker exactly once as the first line", () => {
    for (const mode of ["A", "B"] as const) {
      const post = wrapComment({
        agentId: "dispatch",
        mode,
        body: "plain body",
      });
      const lines = post.split("\n");
      const markerLines = lines.filter((l) =>
        /^<!-- agent-reply(?::[A-Za-z0-9._-]+)? -->$/.test(l),
      );
      assert.equal(markerLines.length, 1);
      assert.equal(markerLines[0], lines[0]);
    }
  });
});
