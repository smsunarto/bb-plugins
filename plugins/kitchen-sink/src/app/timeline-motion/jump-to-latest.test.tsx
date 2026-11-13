import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { jumpToLatestEvent } from "./jump-to-latest.ts";
import { PROBE_ATTRIBUTE } from "./thread-activity.ts";

import { ThreadActivityProbe } from "./thread-activity-probe.tsx";

let document: Document;

beforeEach(() => {
  document = new JSDOM("<!doctype html><body></body>").window.document;
});
afterEach(() => document.defaultView?.close());

/** A timeline scroller whose position the test can read back. */
function timeline(start: number) {
  const root = document.createElement("div");
  root.dataset.threadWindow = "test";
  root.innerHTML = '<div class="thread-scrollbar"><div>Rows</div></div>';
  const element = root.firstElementChild as HTMLElement;
  const position = { top: start };
  Object.defineProperties(element, {
    scrollHeight: { get: () => 1200 },
    scrollTop: {
      get: () => position.top,
      set: (value: number) => {
        position.top = value;
      },
    },
  });
  return { root, position };
}

function marker(parent: Element, threadId: string) {
  const span = document.createElement("span");
  span.hidden = true;
  span.setAttribute(PROBE_ATTRIBUTE, threadId);
  parent.append(span);
}

/**
 * A thread pane as bb lays it out: the header (where the marker lives) and
 * the thread window are siblings under the pane wrapper.
 */
function pane(threadId: string, start = 0) {
  const wrapper = document.createElement("div");
  const header = document.createElement("header");
  marker(header, threadId);
  const shown = timeline(start);
  wrapper.append(header, shown.root);
  document.body.append(wrapper);
  return shown;
}

describe("jump to latest event", () => {
  test("clicks bb's latest-event button in the pane that shows the thread", () => {
    const { root } = pane("thr_a");
    const other = pane("thr_b", 50);
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Scroll to latest event");
    const clicked = mock(() => {});
    button.addEventListener("click", clicked);
    root.append(button);
    expect(jumpToLatestEvent(document, "thr_a")).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(other.position.top).toBe(50);
  });

  test("sends the timeline to its bottom when the button is not showing", () => {
    const shown = pane("thr_a", 100);
    const other = pane("thr_b", 50);
    expect(jumpToLatestEvent(document, "thr_a")).toBe(true);
    expect(shown.position.top).toBe(1200);
    expect(other.position.top).toBe(50);
    expect(jumpToLatestEvent(document, "thr_missing")).toBe(false);
  });

  test("does nothing when the marker sits in a container of several panes", () => {
    const wrapper = document.createElement("div");
    marker(wrapper, "thr_a");
    const first = timeline(100);
    const second = timeline(100);
    wrapper.append(first.root, second.root);
    document.body.append(wrapper);
    expect(jumpToLatestEvent(document, "thr_a")).toBe(false);
    expect(first.position.top).toBe(100);
    expect(second.position.top).toBe(100);
  });

  test("the thread-header slot renders a hidden marker naming its thread", () => {
    document.body.innerHTML = renderToStaticMarkup(<ThreadActivityProbe threadId="thr_a" />);
    const span = document.querySelector(`[${PROBE_ATTRIBUTE}="thr_a"]`);
    expect(span?.hasAttribute("hidden")).toBe(true);
  });
});
