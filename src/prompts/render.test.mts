import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { render, RenderError } from "./render.mts";

describe("render — substitution", () => {
  it("substitutes top-level paths", () => {
    assert.equal(render("hello {{name}}", { name: "world" }), "hello world");
  });

  it("substitutes nested dotted paths", () => {
    const r = render("by {{event.author.login}}", {
      event: { author: { login: "alice" } },
    });
    assert.equal(r, "by alice");
  });

  it("indexes into arrays with numeric segments", () => {
    const r = render("first: {{event.reviewers.0.login}}", {
      event: { reviewers: [{ login: "bob" }, { login: "carol" }] },
    });
    assert.equal(r, "first: bob");
  });

  it("stringifies numbers and booleans", () => {
    assert.equal(render("n={{n}} b={{b}}", { n: 7, b: false }), "n=7 b=false");
  });

  it("JSON-stringifies object values", () => {
    assert.equal(
      render("p={{payload}}", { payload: { x: 1, y: 2 } }),
      'p={"x":1,"y":2}',
    );
  });

  it("renders multiline templates without disturbing newlines", () => {
    const r = render("a={{a}}\nb={{b}}\n", { a: "1", b: "2" });
    assert.equal(r, "a=1\nb=2\n");
  });

  it("trims whitespace inside the braces", () => {
    assert.equal(render("{{   name   }}", { name: "ok" }), "ok");
  });
});

describe("render — escapes and edge cases", () => {
  it(
    String.raw`emits literal "{{x}}" when the opener is backslash-escaped`,
    () => {
      assert.equal(
        render(String.raw`use \{{name}} to interpolate`, {}),
        "use {{name}} to interpolate",
      );
    },
  );

  it("does NOT HTML-escape values", () => {
    assert.equal(render("body={{x}}", { x: "<a&b>" }), "body=<a&b>");
  });

  it("supports placeholders at both ends of the template", () => {
    assert.equal(render("{{a}}-mid-{{b}}", { a: "X", b: "Y" }), "X-mid-Y");
  });
});

describe("render — error cases", () => {
  it("throws on unknown top-level paths", () => {
    assert.throws(() => render("{{missing}}", {}), RenderError);
  });

  it("throws on unknown nested paths", () => {
    assert.throws(
      () => render("{{event.author.login}}", { event: {} }),
      /unknown placeholder/,
    );
  });

  it("throws on empty placeholders", () => {
    assert.throws(() => render("hi {{   }}", {}), /empty placeholder/);
  });

  it("throws on unterminated placeholders", () => {
    assert.throws(() => render("hi {{name", { name: "x" }), /unterminated/);
  });

  it("treats undefined leaf as missing (throws)", () => {
    assert.throws(
      () => render("{{a.b}}", { a: { b: undefined } }),
      /unknown placeholder/,
    );
  });

  it("treats null leaf as missing (throws)", () => {
    assert.throws(
      () => render("{{a.b}}", { a: { b: null } }),
      /unknown placeholder/,
    );
  });
});
