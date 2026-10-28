// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceView } from "./code";

// BB's viewer, numbered as it mounts, so a new viewer is told from the old one.
const viewers = vi.hoisted(() => ({ mounted: 0 }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_SourceCode: function SourceCode({ content }: { content: string }) {
    const [mount] = useState(() => ++viewers.mounted);
    return <pre data-mount={mount}>{content}</pre>;
  },
}));

// jsdom has no layout: an element has a box unless an ancestor is `hidden`, and
// every observed box reports when a test hides or shows it, as display:none does.
const callbacks = new Set<() => void>();
class BoxObserver {
  constructor(private readonly callback: () => void) {}
  observe(element: Element) {
    callbacks.add(this.callback);
    if (element.getClientRects().length > 0) this.callback();
  }
  disconnect() {
    callbacks.delete(this.callback);
  }
}

let container: HTMLDivElement;
let root: Root;
let height = 120;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", BoxObserver);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.closest("[hidden]") === null ? [new DOMRect(0, 0, 400, height)] : []) as unknown as DOMRectList;
  });
  height = 120;
  viewers.mounted = 0;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  callbacks.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The panel holding the viewer, hidden like an inactive tab; returns the viewer's mount number. */
function panel(hidden: boolean): number {
  act(() =>
    root.render(
      <div hidden={hidden}>
        <SourceView content="const a = 1;" path="snippet.ts" />
      </div>,
    ),
  );
  act(() => callbacks.forEach((callback) => callback()));
  const viewer = container.querySelector("pre");
  expect(viewer?.textContent).toBe("const a = 1;");
  return Number(viewer?.dataset.mount);
}

describe("SourceView", () => {
  it("makes a new viewer each time it is hidden, and keeps it when shown again", () => {
    expect(panel(false)).toBe(1);
    expect(panel(true)).toBe(2);
    expect(panel(false)).toBe(2);
    expect(panel(true)).toBe(3);
    expect(panel(false)).toBe(3);
  });

  it("keeps the viewer it mounted hidden until it has been shown", () => {
    expect(panel(true)).toBe(1);
    expect(panel(false)).toBe(1);
    expect(panel(true)).toBe(2);
  });

  it("keeps its viewer while shown, whatever its size", () => {
    expect(panel(false)).toBe(1);
    height = 480;
    expect(panel(false)).toBe(1);
  });
});
