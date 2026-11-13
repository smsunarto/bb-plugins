// @vitest-environment jsdom
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useColumn } from "./files-view.tsx";

let resized: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resized = null;
});

/** A column whose picked card sits `top` px below the column's top, minus its scroll. */
function setup() {
  const box = document.createElement("div");
  const card = document.createElement("section");
  box.append(card);
  let top = 0;
  box.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  card.getBoundingClientRect = () => ({ top: top - box.scrollTop }) as DOMRect;
  const { result } = renderHook(() => useColumn({ current: box }, () => {}));
  result.current.watch("a.ts", card, () => {});
  return { box, column: result.current, moveCard: (to: number) => (top = to) };
}

test("a picked card stays put while the cards above it draw and grow", () => {
  const { box, column, moveCard } = setup();
  moveCard(5000);
  box.scrollTop = 5000;
  column.pin("a.ts", box);
  expect(box.style.overflowAnchor).toBe("none");

  // A card above draws 600px taller than its placeholder.
  moveCard(5600);
  resized!();
  expect(box.scrollTop).toBe(5600);
});

test("the reader's own scroll lets the column go", () => {
  const { box, column, moveCard } = setup();
  moveCard(5000);
  box.scrollTop = 5000;
  column.pin("a.ts", box);

  fireEvent.wheel(box);
  expect(box.style.overflowAnchor).toBe("");
  moveCard(5600);
  resized!();
  expect(box.scrollTop).toBe(5000);
});

test("a pick near the end reaches the top once the cards below it draw", () => {
  const { box, column, moveCard } = setup();
  moveCard(5000);
  // The column ended 1000px too soon to put the card at its top.
  box.scrollTop = 4000;
  column.pin("a.ts", box);

  resized!();
  expect(box.scrollTop).toBe(5000);
});

test("a scroll just after the jump is undone while the column settles", () => {
  const { box, column, moveCard } = setup();
  moveCard(5000);
  box.scrollTop = 5000;
  column.pin("a.ts", box);

  // A re-render briefly shortened the column and clamped its scroll.
  box.scrollTop = 2300;
  fireEvent.scroll(box);
  expect(box.scrollTop).toBe(5000);
});

test("after the jump settles, a scroll the pin did not make is the reader's", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const { box, column, moveCard } = setup();
  moveCard(5000);
  box.scrollTop = 5000;
  column.pin("a.ts", box);

  // A scrollbar drag a second later: no wheel, key, or pointer event on the column.
  now.mockReturnValue(2000);
  box.scrollTop = 7000;
  fireEvent.scroll(box);
  expect(box.scrollTop).toBe(7000);
  expect(box.style.overflowAnchor).toBe("");
});
