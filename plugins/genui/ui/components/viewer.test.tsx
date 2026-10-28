// @vitest-environment jsdom
// Full screen while BB shows threads side by side: the view covers the pane
// of the block that opened it, not the whole window across both threads.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FullScreen } from "./viewer";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_usePluginId: () => "genui",
  useSettings: () => ({ values: { animations: false }, isLoading: false }),
  experimental_Icon: () => <span aria-hidden="true" />,
}));

const PANE = { top: 0, left: 320, width: 560, height: 900 };

let root: Root;
let host: HTMLElement;

/** BB's split view: `count` panes in a row, the block mounted in the first. */
function split(count: number): HTMLElement {
  const panes = Array.from({ length: count }, (_, index) => {
    const pane = document.createElement("div");
    pane.setAttribute("data-split-pane-id", `pane-${index + 1}`);
    document.body.append(pane);
    return pane;
  });
  panes[0]!.getBoundingClientRect = () => DOMRect.fromRect({ x: PANE.left, y: PANE.top, width: PANE.width, height: PANE.height });
  const block = document.createElement("div");
  panes[0]!.append(block);
  return block;
}

function open(onClose = () => undefined) {
  root = createRoot(host);
  act(() =>
    root.render(
      <FullScreen label="Picture" tone="photo" onClose={onClose}>
        <div />
      </FullScreen>,
    ),
  );
  return document.querySelector<HTMLElement>("[data-genui-viewer]")!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("FullScreen in BB's split view", () => {
  it("covers the pane of the block that opened it, and a tap on the rest of the window closes it", () => {
    host = split(2);
    const onClose = vi.fn();
    const view = open(onClose);
    expect([view.style.top, view.style.left, view.style.width, view.style.height]).toEqual(["0px", "320px", "560px", "900px"]);
    const rest = view.previousElementSibling as HTMLElement;
    act(() => rest.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("fills the window when BB shows one pane", () => {
    host = split(1);
    const view = open();
    expect(view.style.left).toBe("");
    expect(view.previousElementSibling).toBeNull();
  });
});
