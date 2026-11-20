// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useReserveSpace } from "./review-bar.tsx";

let resize: ((height: number) => void) | null = null;
let observed: { element: Element; options: ResizeObserverOptions | undefined }[] = [];
let disconnected = 0;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = (height) =>
          callback(
            [
              {
                borderBoxSize: [{ blockSize: height, inlineSize: 300 }],
              } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
      }
      observe(element: Element, options?: ResizeObserverOptions) {
        observed.push({ element, options });
      }
      unobserve() {}
      disconnect() {
        disconnected += 1;
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resize = null;
  observed = [];
  disconnected = 0;
});

function Bar() {
  const float = useRef<HTMLDivElement>(null);
  useReserveSpace(float);
  return <div ref={float} data-testid="float" />;
}

function mount() {
  const page = render(
    <div data-testid="host">
      <Bar />
    </div>,
  );
  const host = page.getByTestId("host");
  return { page, space: () => host.style.getPropertyValue("--sc-review-bar-space") };
}

test("the bar reserves its border-box height on its host", () => {
  const { page, space } = mount();
  expect(observed).toEqual([
    { element: page.getByTestId("float"), options: { box: "border-box" } },
  ]);
  act(() => resize!(115.4));
  expect(space()).toBe("116px");
});

test("a bottom inset that grows the bar's padding grows the reserve", () => {
  const { space } = mount();
  act(() => resize!(116));
  // The pill rises by a 34px home-indicator inset: only the positioner's padding changed.
  act(() => resize!(150));
  expect(space()).toBe("150px");
});

test("unmounting the bar gives the room back", () => {
  const { page, space } = mount();
  act(() => resize!(116));
  page.unmount();
  expect(disconnected).toBe(1);
  expect(space()).toBe("");
});
