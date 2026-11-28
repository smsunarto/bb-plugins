// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnippetShown } from "../../core/data";
import { UiRuntimeContext, type UiRuntime } from "../runtime";
import { Snippet, SourceView, useDrawnHeight } from "./code";

// BB's viewer, numbered as it mounts, so a new viewer is told from the old one.
const viewers = vi.hoisted(() => ({ mounted: 0 }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  experimental_SourceCode: function SourceCode({ content }: { content: string }) {
    const [mount] = useState(() => ++viewers.mounted);
    return <pre data-mount={mount}>{content}</pre>;
  },
}));

const runtime: UiRuntime = {
  setValue() {},
  run: async () => {},
  openFile: null,
  loadImage: null,
  holdHeight: () => () => {},
  readText: null,
  loadAudio: null,
    loadVideo: null,
  loadAsset: null,
  superseded: false,
  threadId: null,
  blockKey: null,
};

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

describe("Snippet", () => {
  /** A Snippet of src/app.ts lines 3–5 as the evaluator hands it over, with `shown` in one of its states. */
  function snippet(shown: SnippetShown) {
    act(() =>
      root.render(
        <UiRuntimeContext value={runtime}>
          <Snippet props={{ path: "src/app.ts", from: 3, to: 5, shown, language: "typescript" }} />
        </UiRuntimeContext>,
      ),
    );
    return {
      caption: container.querySelector(".font-mono")?.textContent,
      code: container.querySelector("pre")?.textContent ?? null,
      status: container.querySelector('[role="status"]')?.getAttribute("aria-label") ?? null,
      copy: container.querySelector('button[aria-label="Copy code"]') !== null,
    };
  }

  it("shows the lines it got, captioned with the range on screen, and offers to copy them", () => {
    expect(snippet({ status: "ready", code: "const a = 1;\nconst b = 2;" })).toEqual({
      caption: "src/app.tsL3–4",
      code: "const a = 1;\nconst b = 2;",
      status: null,
      copy: true,
    });
  });

  it("holds a loading placeholder for the range asked for while the file is read", () => {
    expect(snippet({ status: "loading" })).toEqual({
      caption: "src/app.tsL3–5",
      code: null,
      status: "Loading src/app.ts L3–5",
      copy: false,
    });
  });

  it("says why it cannot show the file, with nothing to copy", () => {
    expect(snippet({ status: "error", error: "file not found" })).toMatchObject({ caption: "src/app.tsL3–5", code: null, copy: false });
    expect(container.textContent).toContain("Couldn't show src/app.ts L3–5: file not found");
  });
});

describe("a diagram's held height", () => {
  /** A box held by useDrawnHeight while BB's placeholder shows. */
  function Drawing({ source }: { source: string }) {
    const box = useRef<HTMLDivElement>(null);
    useDrawnHeight(box, false, source);
    return (
      <div ref={box} data-testid="drawing">
        <p>Rendering diagram...</p>
      </div>
    );
  }

  let frames: Map<number, FrameRequestCallback>;
  let reads: ReturnType<typeof vi.fn<() => number>>;
  beforeEach(() => {
    frames = new Map();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++next, callback);
      return next;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    reads = vi.fn<() => number>(() => 200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(reads);
  });

  /** BB's drawing replacing the placeholder, and its mutation records delivered. */
  async function draw(): Promise<HTMLElement> {
    const box = container.querySelector<HTMLElement>('[data-testid="drawing"]')!;
    await act(async () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("aria-roledescription", "flowchart-v2");
      box.replaceChildren(svg);
    });
    return box;
  }

  function stored(): [string, number][] {
    return JSON.parse(localStorage.getItem("bb.genui.drawnHeights") ?? "[]") as [string, number][];
  }

  it("releases the box when it draws and measures it a frame later, never inside the mutation callback", async () => {
    act(() => root.render(<Drawing source="graph TD; A-->B" />));
    reads.mockClear();
    const box = await draw();
    expect(box.style.minHeight).toBe("");
    expect(reads).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    // A later mutation in the same frame asks for no second measurement.
    await act(async () => box.append(document.createElement("span")));
    expect(frames.size).toBe(1);
    act(() => [...frames.values()].forEach((callback) => callback(0)));
    expect(reads).toHaveBeenCalledTimes(1);
    expect(stored()).toContainEqual([expect.stringMatching(/^l:0:/), 200]);
  });

  it("cancels the pending measurement when it unmounts", async () => {
    act(() => root.render(<Drawing source="graph TD; C-->D" />));
    await draw();
    expect(frames.size).toBe(1);
    reads.mockClear();
    act(() => root.render(<></>));
    expect(frames.size).toBe(0);
    expect(reads).not.toHaveBeenCalled();
  });
});
