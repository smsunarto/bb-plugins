import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toPreviewText } from "../lib/preview-text.ts";

describe("toPreviewText", () => {
  it("returns null for absent or blank output", () => {
    assert.equal(toPreviewText(null), null);
    assert.equal(toPreviewText(""), null);
    assert.equal(toPreviewText(" \n\t "), null);
  });

  it("turns common markdown into one line of prose", () => {
    assert.equal(
      toPreviewText(
        "# Heading\n\n> **Bold** and _italic_ with `code`\n\n- First\n1. [Linked label](https://example.com)",
      ),
      "Heading Bold and italic with code First Linked label",
    );
  });

  it("keeps image alt text and removes its destination", () => {
    assert.equal(toPreviewText("See ![build status](https://example.com/status.svg) now"), "See build status now");
  });

  it("collapses all whitespace", () => {
    assert.equal(toPreviewText("  one\n\n\t two   three  "), "one two three");
  });

  it("truncates at a word boundary without an ellipsis", () => {
    const result = toPreviewText("word ".repeat(60).trim());
    assert.ok(result !== null);
    assert.ok(result.length <= 200);
    assert.equal(result.endsWith("word"), true);
    assert.equal(result.includes("…"), false);
    assert.equal(result.endsWith("..."), false);
  });

  it("hard-caps one very long unbroken word", () => {
    const result = toPreviewText("x".repeat(100_000));
    assert.equal(result, "x".repeat(200));
  });

  it("does not throw on unbalanced markdown", () => {
    assert.doesNotThrow(() => toPreviewText("[unfinished **bold and `code"));
    assert.equal(toPreviewText("[unfinished **bold and `code"), "[unfinished bold and code");
  });

  it("fails closed for a non-string runtime value", () => {
    assert.equal(toPreviewText(42 as unknown as string), null);
  });
});
