import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusGlyph, hasStatusGlyph } from "../components/inbox/status-glyph.tsx";

describe("queued message glyphs", () => {
  it("speak for the row instead of the age label", () => {
    assert.equal(hasStatusGlyph("queued-failed"), true);
    assert.equal(hasStatusGlyph("queued-waiting"), true);
  });

  it("draw a failed send like a failed turn, and a waiting send as a clock", () => {
    const failed = renderToStaticMarkup(
      createElement(StatusGlyph, {
        indicator: "queued-failed",
        label: "Queued message failed to send",
      }),
    );
    assert.match(failed, /aria-label="Queued message failed to send"/);
    assert.match(failed, /text-destructive/);

    const waiting = renderToStaticMarkup(
      createElement(StatusGlyph, { indicator: "queued-waiting", label: "Message queued" }),
    );
    assert.match(waiting, /aria-label="Message queued"/);
    assert.doesNotMatch(waiting, /text-destructive/);
    assert.notEqual(waiting, failed);
  });
});
