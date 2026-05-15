import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  emitPrStatusXml,
  rollupChecks,
  type PrStatusInput,
} from "./pr-status.mts";

function baseInput(over: Partial<PrStatusInput> = {}): PrStatusInput {
  return {
    pr: {
      repo: "ianwremmel/agentic",
      number: 42,
      head: "feature-x",
      mergeConflicts: false,
    },
    checks: [],
    reviews: [],
    comments: [],
    threads: [],
    annotations: [],
    ackedAnnotationIds: new Set(),
    agentId: "dispatch",
    ...over,
  };
}

describe("emitPrStatusXml — shape", () => {
  it("emits the root element with required attributes", () => {
    const xml = emitPrStatusXml(baseInput());
    assert.match(
      xml,
      /^<pr-status repo="ianwremmel\/agentic" pr="42" head="feature-x">/,
    );
    assert.ok(xml.endsWith("</pr-status>\n"));
  });

  it("contains every required child element in order", () => {
    const xml = emitPrStatusXml(baseInput());
    const order = [
      "<checks",
      "<merge-conflicts",
      "<reviews>",
      "<comments>",
      "<threads>",
      "<annotations>",
    ];
    let last = -1;
    for (const tag of order) {
      const i = xml.indexOf(tag);
      assert.ok(i > last, `${tag} out of order`);
      last = i;
    }
  });

  it("emits no BOM and uses LF line endings", () => {
    const xml = emitPrStatusXml(baseInput());
    assert.notEqual(xml.charCodeAt(0), 0xfeff);
    assert.ok(!xml.includes("\r"));
  });
});

describe("emitPrStatusXml — checks rollup", () => {
  it("passing when all checks succeeded", () => {
    const xml = emitPrStatusXml(
      baseInput({
        checks: [
          { name: "lint", conclusion: "success", url: "https://x/1" },
          { name: "test", conclusion: "success", url: "https://x/2" },
        ],
      }),
    );
    assert.match(xml, /<checks state="passing">/);
  });

  it("pending when a non-stuck check is in progress", () => {
    const xml = emitPrStatusXml(
      baseInput({
        checks: [
          { name: "lint", conclusion: "success", url: "https://x/1" },
          {
            name: "test",
            conclusion: "neutral",
            url: "https://x/2",
            inProgress: true,
            failed: true,
          },
        ],
      }),
    );
    assert.match(xml, /<checks state="pending">/);
  });

  it("failing when a non-informational check failed and nothing is live", () => {
    const xml = emitPrStatusXml(
      baseInput({
        checks: [
          {
            name: "lint",
            conclusion: "failure",
            url: "https://x/1",
            failed: true,
          },
        ],
      }),
    );
    assert.match(xml, /<checks state="failing">/);
  });

  it("ignores informational failures for the failing rollup", () => {
    const state = rollupChecks([
      {
        name: "lint",
        conclusion: "failure",
        url: "https://x/1",
        failed: true,
        informational: true,
      },
    ]);
    assert.equal(state, "passing");
  });

  it("ignores stuck checks for the pending rollup", () => {
    const state = rollupChecks([
      {
        name: "long",
        conclusion: "neutral",
        url: "https://x/1",
        inProgress: true,
        stuck: true,
        failed: true,
      },
    ]);
    assert.equal(state, "failing");
  });
});

describe("emitPrStatusXml — comment actionability", () => {
  it("actionable when the newest comment was by a different author", () => {
    const xml = emitPrStatusXml(
      baseInput({
        comments: [
          {
            id: "c1",
            cachePath: "/tmp/c1.md",
            lastAuthorAgentId: "other-bot",
            lastSignalTerminal: true,
          },
        ],
      }),
    );
    assert.match(xml, /<comment id="c1" actionable="true"/);
  });

  it("non-actionable when newest is by self AND terminal", () => {
    const xml = emitPrStatusXml(
      baseInput({
        comments: [
          {
            id: "c1",
            cachePath: "/tmp/c1.md",
            lastAuthorAgentId: "dispatch",
            lastSignalTerminal: true,
            summary: "Done in commit abc.",
          },
        ],
      }),
    );
    assert.match(xml, /<comment id="c1" actionable="false"/);
    assert.match(xml, /<summary>Done in commit abc\.<\/summary>/);
  });

  it("still actionable when newest is by self but signal is not terminal", () => {
    const xml = emitPrStatusXml(
      baseInput({
        comments: [
          {
            id: "c1",
            cachePath: "/tmp/c1.md",
            lastAuthorAgentId: "dispatch",
            lastSignalTerminal: false,
          },
        ],
      }),
    );
    assert.match(xml, /<comment id="c1" actionable="true"/);
  });

  it("requires summary for non-actionable comments", () => {
    assert.throws(
      () =>
        emitPrStatusXml(
          baseInput({
            comments: [
              {
                id: "c1",
                cachePath: "/tmp/c1.md",
                lastAuthorAgentId: "dispatch",
                lastSignalTerminal: true,
              },
            ],
          }),
        ),
      /requires a non-empty summary/,
    );
  });
});

describe("emitPrStatusXml — thread actionability", () => {
  it("non-actionable when platform-resolved", () => {
    const xml = emitPrStatusXml(
      baseInput({
        threads: [
          {
            id: "t1",
            cachePath: "/tmp/t1.md",
            resolved: true,
            summary: "Resolved upstream.",
          },
        ],
      }),
    );
    assert.match(xml, /<thread id="t1" actionable="false"/);
  });
});

describe("emitPrStatusXml — annotation actionability", () => {
  it("non-actionable iff the id is in ackedAnnotationIds", () => {
    const xml = emitPrStatusXml(
      baseInput({
        annotations: [
          { id: "a1", cachePath: "/tmp/a1.md" },
          { id: "a2", cachePath: "/tmp/a2.md", summary: "Acked." },
        ],
        ackedAnnotationIds: new Set(["a2"]),
      }),
    );
    assert.match(xml, /<annotation id="a1" actionable="true"/);
    assert.match(xml, /<annotation id="a2" actionable="false"/);
  });
});

describe("emitPrStatusXml — reviews", () => {
  it("emits every review (no dedup) with mode and state", () => {
    const xml = emitPrStatusXml(
      baseInput({
        reviews: [
          { author: "alice", mode: "human", state: "approved" },
          { author: "alice", mode: "human", state: "commented" },
          { author: "copilot-bot", mode: "bot", state: "changes_requested" },
        ],
      }),
    );
    const reviews = xml.match(/<review [^/]+\/>/g) ?? [];
    assert.equal(reviews.length, 3);
    assert.match(reviews[0], /author="alice".*state="approved"/);
    assert.match(reviews[2], /mode="bot"/);
  });
});

describe("emitPrStatusXml — determinism + XML escaping", () => {
  it("produces byte-identical output for the same input", () => {
    const a = emitPrStatusXml(
      baseInput({
        checks: [{ name: "lint", conclusion: "success", url: "https://x/1" }],
        reviews: [{ author: "alice", mode: "human", state: "approved" }],
      }),
    );
    const b = emitPrStatusXml(
      baseInput({
        checks: [{ name: "lint", conclusion: "success", url: "https://x/1" }],
        reviews: [{ author: "alice", mode: "human", state: "approved" }],
      }),
    );
    assert.equal(a, b);
  });

  it("escapes attribute special characters", () => {
    const xml = emitPrStatusXml(
      baseInput({
        pr: {
          repo: 'ian/<x>"&y',
          number: 1,
          head: "br&anch",
          mergeConflicts: false,
        },
      }),
    );
    assert.match(xml, /repo="ian\/&lt;x&gt;&quot;&amp;y"/);
    assert.match(xml, /head="br&amp;anch"/);
  });

  it("escapes text in <summary>", () => {
    const xml = emitPrStatusXml(
      baseInput({
        comments: [
          {
            id: "c1",
            cachePath: "/tmp/c1.md",
            lastAuthorAgentId: "dispatch",
            lastSignalTerminal: true,
            summary: "fixed <foo> & <bar>",
          },
        ],
      }),
    );
    assert.match(
      xml,
      /<summary>fixed &lt;foo&gt; &amp; &lt;bar&gt;<\/summary>/,
    );
  });
});

describe("emitPrStatusXml — error handling", () => {
  it("requires a non-empty agentId", () => {
    assert.throws(
      () => emitPrStatusXml(baseInput({ agentId: "" })),
      /agentId is required/,
    );
  });

  it("rejects non-positive PR numbers", () => {
    assert.throws(
      () =>
        emitPrStatusXml(
          baseInput({
            pr: { repo: "x/y", number: 0, head: "h", mergeConflicts: false },
          }),
        ),
      /positive integer/,
    );
  });
});
