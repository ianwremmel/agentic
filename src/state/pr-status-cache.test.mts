import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheForRoot,
  encodeRepoSlug,
  openPrStatusCache,
} from "./pr-status-cache.mts";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "pr-status-cache-"));
}

describe("encodeRepoSlug", () => {
  it("encodes a simple owner/repo with __ separator", () => {
    assert.equal(encodeRepoSlug("ianwremmel/agentic"), "ianwremmel__agentic");
  });

  it("percent-encodes unsafe characters", () => {
    assert.equal(encodeRepoSlug("o/r with space"), "o__r%20with%20space");
  });

  it("does not confuse `/` in the repo half with the separator", () => {
    assert.equal(encodeRepoSlug("o/r/x"), "o__r%2Fx");
  });

  it("encodes a single-segment input as one safe token", () => {
    assert.equal(encodeRepoSlug("repo+name"), "repo%2Bname");
  });
});

describe("PrStatusCache — write/read", () => {
  let root: string;
  beforeEach(() => {
    root = freshRoot();
  });

  it("creates the cache directory lazily on first write", () => {
    const cache = cacheForRoot(root);
    assert.equal(
      cache.read({ repo: "o/r", pr: 1, skill: "dispatch" }),
      undefined,
    );
    cache.write({ repo: "o/r", pr: 1, skill: "dispatch" }, "<pr-status/>\n");
    assert.equal(
      cache.read({ repo: "o/r", pr: 1, skill: "dispatch" }),
      "<pr-status/>\n",
    );
  });

  it("places the file under <root>/pr-status/<skill>/<repo>/<pr>/", () => {
    const cache = cacheForRoot(root);
    const target = { repo: "ian/agentic", pr: 42, skill: "dispatch" };
    cache.write(target, "<a/>");
    const expected = join(
      root,
      "pr-status",
      "dispatch",
      "ian__agentic",
      "42",
      "status.xml",
    );
    assert.equal(readFileSync(expected, "utf8"), "<a/>");
  });

  it("isolates skills from each other", () => {
    const cache = cacheForRoot(root);
    cache.write({ repo: "o/r", pr: 1, skill: "alpha" }, "alpha-xml");
    cache.write({ repo: "o/r", pr: 1, skill: "beta" }, "beta-xml");
    assert.equal(
      cache.read({ repo: "o/r", pr: 1, skill: "alpha" }),
      "alpha-xml",
    );
    assert.equal(cache.read({ repo: "o/r", pr: 1, skill: "beta" }), "beta-xml");
  });

  it("rejects non-positive PR numbers", () => {
    const cache = cacheForRoot(root);
    assert.throws(
      () => cache.write({ repo: "o/r", pr: 0, skill: "x" }, "<a/>"),
      /positive integer/,
    );
  });
});

describe("PrStatusCache — .ack markers", () => {
  let root: string;
  beforeEach(() => {
    root = freshRoot();
  });

  it("writeAck creates an empty marker; hasAck reports it", () => {
    const cache = cacheForRoot(root);
    const t = { repo: "o/r", pr: 1, skill: "s" };
    assert.equal(cache.hasAck(t, "ann1"), false);
    cache.writeAck(t, "ann1");
    assert.equal(cache.hasAck(t, "ann1"), true);
    const path = join(
      root,
      "pr-status",
      "s",
      "o__r",
      "1",
      "annotations",
      "ann1.ack",
    );
    assert.equal(readFileSync(path, "utf8"), "");
  });

  it("listAcks returns every annotation id with an .ack marker", () => {
    const cache = cacheForRoot(root);
    const t = { repo: "o/r", pr: 1, skill: "s" };
    cache.writeAck(t, "alpha");
    cache.writeAck(t, "beta");
    cache.writeAck(t, "gamma");
    assert.deepEqual([...cache.listAcks(t)].sort(), ["alpha", "beta", "gamma"]);
  });

  it("listAcks returns an empty set when nothing has been ack'd", () => {
    const cache = cacheForRoot(root);
    const t = { repo: "o/r", pr: 1, skill: "s" };
    assert.deepEqual([...cache.listAcks(t)], []);
  });

  it("round-trips annotation ids with unsafe characters", () => {
    const cache = cacheForRoot(root);
    const t = { repo: "o/r", pr: 1, skill: "s" };
    const id = "node_id with/space";
    cache.writeAck(t, id);
    assert.equal(cache.hasAck(t, id), true);
    assert.deepEqual([...cache.listAcks(t)], [id]);
  });
});

describe("PrStatusCache — lifecycle", () => {
  it("remove() deletes the PR directory", () => {
    const root = freshRoot();
    const cache = cacheForRoot(root);
    const t = { repo: "o/r", pr: 9, skill: "s" };
    cache.write(t, "<a/>");
    cache.writeAck(t, "a1");
    assert.ok(existsSync(cache.prDir(t)));
    cache.remove(t);
    assert.ok(!existsSync(cache.prDir(t)));
    assert.equal(cache.read(t), undefined);
  });

  it("remove() on a non-existent target is a no-op", () => {
    const root = freshRoot();
    const cache = cacheForRoot(root);
    assert.doesNotThrow(() => cache.remove({ repo: "o/r", pr: 9, skill: "s" }));
  });
});

describe("openPrStatusCache", () => {
  it("honors a root override", () => {
    const root = freshRoot();
    const cache = openPrStatusCache({ root });
    cache.write({ repo: "o/r", pr: 1, skill: "s" }, "<x/>");
    assert.equal(
      readFileSync(
        join(root, "pr-status", "s", "o__r", "1", "status.xml"),
        "utf8",
      ),
      "<x/>",
    );
  });
});
