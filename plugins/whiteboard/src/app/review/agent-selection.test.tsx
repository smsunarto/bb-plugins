// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { AgentSelectionProvider, useAgentSelection } from "./agent-selection.tsx";
import * as clipboard from "../bridge/agent-handoff.ts";
import { ReviewSessionProvider } from "./host/review-session.tsx";
import { testReviewSession } from "./review-session-test-utils.tsx";

it("copies only on click or Shift+Cmd+C, reports failures, and clears on revision changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const handoff = { quote: "selected", sessionId: "test-review", version: 1, title: "Prose" };
  const copyContext = vi.fn(async () => ({ text: "Review: /review.mdx\n\nselected", handoff }));
  const session = testReviewSession({}, {}, { copyContext });
  const notify = vi.fn<NonNullable<typeof session.bridge.notify>>();
  session.bridge.notify = notify;

  const write = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
  const container = document.createElement("div");
  container.className = "review-canvas-root";
  const host = document.createElement("div");
  document.body.append(host);
  host.attachShadow({ mode: "open" }).append(container);
  const root = createRoot(container);

  function Pick() {
    const select = useAgentSelection();

    return (
      <article className="review-document" data-selection-scroller>
        <button
          onClick={(event) =>
            select({
              title: "Prose",
              anchor: { x: 100, y: 120 },
              anchorElement: event.currentTarget,
              target: { kind: "text", quote: "selected" },
            })
          }
        >
          Select
        </button>
      </article>
    );
  }

  const render = (revision: string) =>
    root.render(
      <ReviewSessionProvider session={session}>
        <AgentSelectionProvider revision={revision}>
          <Pick />
        </AgentSelectionProvider>
      </ReviewSessionProvider>,
    );

  const shortcut = () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "C",
        metaKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );

  try {
    await act(async () => render("one"));
    await act(async () => container.querySelector("button")!.click());
    expect(copyContext).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Add to chat"]')).not.toBeNull();

    const popover = () => container.querySelector<HTMLButtonElement>('[aria-label="Add to chat"]')!;

    expect(popover().style.top).toBe("82px");
    await act(async () => {
      const scroller = container.querySelector<HTMLElement>("[data-selection-scroller]")!;

      scroller.scrollTop = 40;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(popover().parentElement).toBe(container.querySelector("[data-selection-scroller]"));
    expect(popover().style.top).toBe("82px");
    await act(async () => {
      const scroller = container.querySelector<HTMLElement>("[data-selection-scroller]")!;

      scroller.scrollTop = 140;
      scroller.dispatchEvent(new Event("scroll"));
    });
    // Its article-relative position stays constant: scrolling is browser-owned.
    expect(popover().style.position).toBe("absolute");
    expect(popover().style.top).toBe("82px");
    expect(copyContext).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Add to chat"]')!.click(),
    );
    expect(write).toHaveBeenLastCalledWith(
      "Review: /review.mdx\n\nselected",
      handoff,
      expect.objectContaining({ className: "review-document" }),
    );
    // The selection as the server reads it, without the popover's DOM anchors.
    expect(copyContext.mock.calls[0]).toEqual([
      {
        sessionId: "test-review",
        version: undefined,
        selection: {
          title: "Prose",
          target: { kind: "text", quote: "selected" },
          revision: "one",
        },
      },
    ]);
    expect(notify).toHaveBeenLastCalledWith({
      kind: "success",
      text: expect.stringContaining("Added to chat."),
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      shortcut();
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Add to chat"]')).toBeNull();
    write.mockResolvedValue(false);
    await act(async () => {
      shortcut();
    });
    expect(notify).toHaveBeenLastCalledWith({
      kind: "error",
      text: expect.stringContaining("Could not add the selection to chat."),
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => render("two"));
    expect(container.querySelector('[aria-label="Add to chat"]')).toBeNull();
    await act(async () => {
      shortcut();
    });
    expect(write).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
