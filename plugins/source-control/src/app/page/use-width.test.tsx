// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useRef, useState, type RefObject } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useWidth } from "./hooks.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("useWidth follows the element when it is replaced, and lets go of the old one", () => {
  const watching = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly elements: Element[] = [];
      observe(element: Element) {
        this.elements.push(element);
        watching.add(element);
      }
      unobserve() {}
      disconnect() {
        for (const element of this.elements) watching.delete(element);
      }
    },
  );
  function Box() {
    const ref = useRef<HTMLElement>(null);
    const [which, setWhich] = useState("first");
    useWidth(ref, true);
    return which === "first" ? (
      <button
        type="button"
        ref={ref as RefObject<HTMLButtonElement>}
        id="first"
        onClick={() => setWhich("second")}
      >
        Swap
      </button>
    ) : (
      <section ref={ref} id="second" />
    );
  }
  render(
    <StrictMode>
      <Box />
    </StrictMode>,
  );
  expect([...watching].map((element) => element.id)).toEqual(["first"]);
  act(() => document.getElementById("first")!.click());
  expect([...watching].map((element) => element.id)).toEqual(["second"]);
  cleanup();
  expect(watching.size).toBe(0);
});
