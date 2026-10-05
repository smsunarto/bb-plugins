// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, registerHandoffSink } from "./agent-handoff.ts";

/** What copy-context answers beside its clipboard text. */
const handoff = (quote: string) => ({ quote, sessionId: "s1", version: 3, title: "Plan" });

afterEach(() => {
  document.body.replaceChildren();
});

/** A paragraph, inside a mount's `.review-canvas-root` unless `root` is false. */
function paragraph(root = true) {
  const text = document.createElement("p");
  text.textContent = "The session store keeps every version.";
  if (!root) {
    document.body.append(text);
    return { text };
  }
  const canvas = document.createElement("div");
  canvas.className = "review-canvas-root";
  canvas.append(text);
  document.body.append(canvas);
  return { canvas, text };
}

describe("agent handoff", () => {
  it("hands a selection made inside a mount to that mount's sink", async () => {
    const { canvas, text } = paragraph();
    const sink = vi.fn();
    registerHandoffSink(canvas!, sink);

    expect(await copyText("agent context", handoff("quote text"), text)).toBe(true);
    expect(sink.mock.calls).toEqual([[handoff("quote text")]]);
  });

  it("fails when the selection was made outside every mount", async () => {
    const { canvas } = paragraph();
    const sink = vi.fn();
    registerHandoffSink(canvas!, sink);

    expect(await copyText("agent context", handoff("quote text"), paragraph(false).text)).toBe(
      false,
    );
    expect(await copyText("agent context", handoff("quote text"), undefined)).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("fails when the route answered no usable handoff", async () => {
    const { canvas, text } = paragraph();
    const sink = vi.fn();
    registerHandoffSink(canvas!, sink);

    expect(await copyText("agent context", { quote: "" }, text)).toBe(false);
    expect(await copyText("agent context", undefined, text)).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("reaches the pane the selection was made in after focus moved to another pane", async () => {
    const first = paragraph();
    const second = paragraph();
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    registerHandoffSink(first.canvas!, firstSink);
    registerHandoffSink(second.canvas!, secondSink);
    const button = document.createElement("button");
    second.canvas!.append(button);
    button.focus();
    const range = document.createRange();
    range.selectNodeContents(second.text);
    document.getSelection()!.addRange(range);

    await copyText("context", handoff("from the first pane"), first.text);

    expect(firstSink.mock.calls).toEqual([[handoff("from the first pane")]]);
    expect(secondSink).not.toHaveBeenCalled();
  });

  it("fails once the mount unregisters", async () => {
    const { canvas, text } = paragraph();
    const sink = vi.fn();
    const unregister = registerHandoffSink(canvas!, sink);

    expect(await copyText("agent context", handoff("quote text"), text)).toBe(true);
    unregister();
    expect(await copyText("after unmount", handoff("quote text"), text)).toBe(false);

    expect(sink.mock.calls).toEqual([[handoff("quote text")]]);
  });
});
