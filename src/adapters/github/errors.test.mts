import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  classifyHttpStatus,
  GitHubError,
  isGitHubError,
  parseRetryAfter,
} from "./errors.mts";

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

describe("classifyHttpStatus", () => {
  it("maps 404 to not-found", () => {
    assert.equal(classifyHttpStatus(404), "not-found");
  });
  it("maps 401 to auth", () => {
    assert.equal(classifyHttpStatus(401), "auth");
  });
  it("maps 403 without rate-limit signals to auth", () => {
    assert.equal(classifyHttpStatus(403, headers()), "auth");
  });
  it("maps 403 with x-ratelimit-remaining=0 to rate-limited", () => {
    assert.equal(
      classifyHttpStatus(403, headers({ "x-ratelimit-remaining": "0" })),
      "rate-limited",
    );
  });
  it("maps 403 with retry-after to rate-limited", () => {
    assert.equal(
      classifyHttpStatus(403, headers({ "retry-after": "10" })),
      "rate-limited",
    );
  });
  it("maps 429 to rate-limited", () => {
    assert.equal(classifyHttpStatus(429), "rate-limited");
  });
  it("maps 5xx to server-5xx", () => {
    assert.equal(classifyHttpStatus(500), "server-5xx");
    assert.equal(classifyHttpStatus(502), "server-5xx");
    assert.equal(classifyHttpStatus(599), "server-5xx");
  });
  it("maps generic 4xx to client-4xx", () => {
    assert.equal(classifyHttpStatus(422), "client-4xx");
    assert.equal(classifyHttpStatus(400), "client-4xx");
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    assert.equal(parseRetryAfter(headers({ "retry-after": "5" }), 0), 5_000);
  });
  it("parses HTTP-date", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    const future = "Tue, 01 Jan 2030 00:00:30 GMT";
    const ms = parseRetryAfter(headers({ "retry-after": future }), now);
    assert.equal(ms, 30_000);
  });
  it("falls back to x-ratelimit-reset", () => {
    const now = 1_000_000;
    const reset = String(Math.floor((now + 7_000) / 1000));
    assert.equal(
      parseRetryAfter(headers({ "x-ratelimit-reset": reset }), now),
      7_000,
    );
  });
  it("returns undefined when nothing useful is set", () => {
    assert.equal(parseRetryAfter(headers(), 0), undefined);
  });
});

describe("GitHubError", () => {
  it("captures kind/status/retryAfter and is detected by isGitHubError", () => {
    const e = new GitHubError("nope", {
      kind: "rate-limited",
      status: 429,
      retryAfter: 5_000,
    });
    assert.equal(e.kind, "rate-limited");
    assert.equal(e.status, 429);
    assert.equal(e.retryAfter, 5_000);
    assert.equal(isGitHubError(e), true);
    assert.equal(isGitHubError(new Error("regular")), false);
  });
});
