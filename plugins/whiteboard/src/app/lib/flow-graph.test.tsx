// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FlowDiagramBlock } from "../../shared/vendor/review/src/review-api/blocks/flow_diagram.ts";
import { ReviewDebugSettingsProvider } from "../vendor/review/app/src/debug-settings.tsx";
import { FlowGraph } from "../vendor/review/app/src/flow-graph.tsx";
import { ReviewSessionProvider } from "../vendor/review/app/src/host/review-session.tsx";
import { testReviewSession } from "../vendor/review/app/src/review-session-test-utils.tsx";

/** Each observed element's callback, so a test can resize the flow's frame. */
const resized = new Map<Element, () => void>();

/** jsdom has neither; React Flow and the fit observe the frame. */
beforeEach(() => {
  resized.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(element: Element) {
        resized.set(element, this.callback);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GATE = "New, not snoozed or rejected, subject unlocked, under budget?";

const block: FlowDiagramBlock = {
  type: "flow_diagram",
  title: "Ambient loop: one detector tick",
  direction: "down",
  nodes: [
    {
      type: "flow_node",
      key: "tick",
      label: "Detector tick (ops plugin schedule)",
      attachments: [],
    },
    { type: "flow_node", key: "gate", label: GATE, kind: "decision", attachments: [] },
    { type: "flow_node", key: "pr", label: "Open PR", attachments: [] },
  ],
  edges: [
    { type: "flow_edge", from: "tick", to: "gate" },
    { type: "flow_edge", from: "gate", to: "pr", label: "pass" },
  ],
};

function renderFlow(interactive: boolean, flow = block) {
  return render(
    <ReviewSessionProvider session={testReviewSession()}>
      <ReviewDebugSettingsProvider>
        <FlowGraph block={flow} interactive={interactive} height={560} onSelect={() => {}} />
      </ReviewDebugSettingsProvider>
    </ReviewSessionProvider>,
  );
}

it("shows a long node label in full", async () => {
  renderFlow(false);

  const label = await screen.findByText(GATE);

  expect(label.className).toBe("flow-node-label");
  expect(label.textContent).toBe(GATE);
  expect(screen.getByText("Detector tick (ops plugin schedule)").textContent).not.toContain("…");
});

it("draws edge labels in one layer above the edges", async () => {
  renderFlow(false);

  const label = await screen.findByText("pass");

  expect(label.closest("svg")?.getAttribute("class")).toBe("lens-flow-edge-labels");
});

it("offers zoom and fit controls when expanded", async () => {
  renderFlow(true);

  await screen.findByText(GATE);

  expect(screen.getByRole("button", { name: /zoom in/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /zoom out/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /fit view/i })).toBeTruthy();
});

it("has no controls inline", async () => {
  renderFlow(false);

  await screen.findByText(GATE);

  expect(screen.queryByRole("button", { name: /zoom in/i })).toBeNull();
});

/** ELK lays this 12-node chain out 234 x 1252, step-N at y = 12 + 106 * (N - 1). */
const keys = Array.from({ length: 12 }, (_, index) => `step-${index + 1}`);
const chain: FlowDiagramBlock = {
  type: "flow_diagram",
  title: "Chain",
  direction: "down",
  nodes: keys.map((key) => ({ type: "flow_node", key, label: key, attachments: [] })),
  edges: keys.slice(1).map((key, index) => ({ type: "flow_edge", from: keys[index]!, to: key })),
};

function frameRect(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width,
    height,
  } as DOMRect);
}

it("sizes an inline down flow to its drawing instead of shrinking it into 560px", async () => {
  frameRect(770, 560);
  const { container } = renderFlow(false, chain);
  const frame = container.querySelector<HTMLElement>(".lens-flow")!;

  expect(frame.textContent).toBe("Laying out flow…");
  expect(frame.style.height).toBe("560px");

  await waitFor(() => expect(frame.style.height).toBe("1300px"));
});

it("opens expanded at a readable zoom on the selected node and pans to a step off screen", async () => {
  // Reduced motion: every move lands at once.
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  frameRect(808, 877);
  const tour = (selectedKey: string) => (
    <ReviewSessionProvider session={testReviewSession()}>
      <ReviewDebugSettingsProvider>
        <FlowGraph
          block={chain}
          interactive
          height="100%"
          selectedKey={selectedKey}
          onSelect={() => {}}
        />
      </ReviewDebugSettingsProvider>
    </ReviewSessionProvider>
  );
  const { container, rerender } = render(tour("step-12"));
  /** The rendered viewport, rounded to 0.01px: x, y and zoom. */
  const viewport = () =>
    container
      .querySelector<HTMLElement>(".react-flow__viewport")!
      .style.transform.match(/-?[\d.]+/g)!
      .map((value) => Math.round(Number(value) * 100) / 100);

  // The whole chain would fit at 0.66. The floor holds 0.85, centered across.
  // Down, step-12 sits near the end, so the drawing's bottom edge stops at the padding.
  await waitFor(() => expect(viewport()).toEqual([304.55, -211.2, 0.85]));

  rerender(tour("step-11"));
  expect(viewport()).toEqual([304.55, -211.2, 0.85]);

  // Step-1 is off screen above; its pan stops with the top edge at the padding.
  rerender(tour("step-1"));
  expect(viewport()).toEqual([304.55, 24, 0.85]);
});

/** d3-zoom follows a press through `event.view`, which jsdom's MouseEvent rejects here. */
function mouse(type: string, target: Element | Window, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 100 });
  Object.defineProperty(event, "view", { value: window });
  fireEvent(target, event);
}

it("keeps refitting after a node click, and stops once the reader drags", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  frameRect(808, 877);
  const { container } = renderFlow(true);
  const frame = container.querySelector<HTMLElement>(".lens-flow")!;
  const viewport = () =>
    container
      .querySelector<HTMLElement>(".react-flow__viewport")!
      .style.transform.match(/-?[\d.]+/g)!
      .map((value) => Math.round(Number(value) * 100) / 100);
  const resizeTo = (width: number) => {
    frameRect(width, 877);
    act(() => resized.get(frame)!());
  };

  await waitFor(() => expect(viewport()).toEqual([287, 282.5, 1]));

  // A press on a node opens a d3-zoom gesture without moving anything.
  const gate = screen.getByText(GATE).closest(".react-flow__node")!;
  mouse("mousedown", gate, 100);
  mouse("mouseup", window, 100);
  resizeTo(500);

  expect(viewport()).toEqual([133, 282.5, 1]);

  mouse("mousedown", container.querySelector(".react-flow__pane")!, 100);
  mouse("mousemove", window, 140);
  mouse("mouseup", window, 140);
  resizeTo(808);

  expect(viewport()).toEqual([173, 282.5, 1]);
});
