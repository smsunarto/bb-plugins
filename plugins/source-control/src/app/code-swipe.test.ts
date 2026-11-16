// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codeOverflows, guardCodeSwipe, NO_SIDEBAR_SWIPE, overflowsX } from "./code-swipe.ts";

/** A wrapper around a diff whose shadow root holds one code scroller of the given widths. */
function diff(scrollWidth: number, clientWidth = 368) {
  const wrapper = document.createElement("div");
  const host = document.createElement("diffs-container");
  const code = document.createElement("code");
  code.setAttribute("data-code", "");
  host.attachShadow({ mode: "open" }).append(code);
  wrapper.append(host);
  const widths = { scrollWidth, clientWidth };
  Object.defineProperty(code, "scrollWidth", { get: () => widths.scrollWidth });
  Object.defineProperty(code, "clientWidth", { get: () => widths.clientWidth });
  document.body.append(wrapper);
  return { wrapper, widths };
}

let observed: Element[] = [];
let resized: (targets: Element[]) => void = () => {};
beforeEach(() => {
  observed = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: { target: Element }[]) => void) {
        resized = (targets) => callback(targets.map((target) => ({ target })));
      }
      observe(target: Element) {
        observed.push(target);
      }
      unobserve(target: Element) {
        observed = observed.filter((each) => each !== target);
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test("code overflows only when it is wider than its box by more than bb's pixel of slack", () => {
  expect(overflowsX({ scrollWidth: 1027, clientWidth: 368 })).toBe(true);
  expect(overflowsX({ scrollWidth: 369, clientWidth: 368 })).toBe(false);
  expect(overflowsX({ scrollWidth: 368, clientWidth: 368 })).toBe(false);
});

test("a diff's code is found inside its shadow root", () => {
  expect(codeOverflows(diff(1027).wrapper)).toBe(true);
  expect(codeOverflows(diff(300).wrapper)).toBe(false);
  expect(codeOverflows(document.createElement("div"))).toBe(false);
});

test("a diff whose code scrolls sideways keeps bb's sidebar swipe off it, and gives it back once the code fits", () => {
  const { wrapper, widths } = diff(1027);
  const cleanup = guardCodeSwipe(wrapper);
  expect(observed).toContain(wrapper);
  resized([wrapper]);
  expect(wrapper.hasAttribute(NO_SIDEBAR_SWIPE)).toBe(true);
  // Wider panel or wrapped lines: the code fits, so a swipe on it opens the sidebar again.
  widths.clientWidth = 1100;
  resized([wrapper]);
  expect(wrapper.hasAttribute(NO_SIDEBAR_SWIPE)).toBe(false);
  widths.clientWidth = 368;
  resized([wrapper]);
  cleanup?.();
  expect(observed).not.toContain(wrapper);
  expect(wrapper.hasAttribute(NO_SIDEBAR_SWIPE)).toBe(false);
});

test("code that fits never blocks the sidebar swipe", () => {
  const { wrapper } = diff(320);
  guardCodeSwipe(wrapper);
  resized([wrapper]);
  expect(wrapper.hasAttribute(NO_SIDEBAR_SWIPE)).toBe(false);
});
