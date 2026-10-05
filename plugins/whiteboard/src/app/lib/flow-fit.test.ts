import { describe, expect, it } from "vitest";
import { centerViewport, fitZoom, inlineFlowHeight, shouldPan } from "./flow-fit.ts";

describe("inlineFlowHeight", () => {
  it("grows a deep down flow to its drawing's height at 1:1", () => {
    expect(
      inlineFlowHeight({ layoutWidth: 697, layoutHeight: 1348, frameWidth: 770, minHeight: 560 }),
    ).toBe(1396);
  });

  it("keeps upstream's box for a flow that already fits", () => {
    expect(
      inlineFlowHeight({ layoutWidth: 234, layoutHeight: 418, frameWidth: 620, minHeight: 560 }),
    ).toBe(560);
  });

  it("caps at 1400px", () => {
    expect(
      inlineFlowHeight({ layoutWidth: 697, layoutHeight: 2000, frameWidth: 770, minHeight: 560 }),
    ).toBe(1400);
  });

  it("keeps the minimum when the width already shrinks a wide flow", () => {
    expect(
      inlineFlowHeight({ layoutWidth: 1400, layoutHeight: 400, frameWidth: 770, minHeight: 420 }),
    ).toBe(420);
  });
});

describe("shouldPan", () => {
  const viewport = { x: 0, y: 0, zoom: 1, width: 800, height: 600 };

  it("leaves a node that is fully on screen", () => {
    expect(shouldPan(viewport, { x: 100, y: 100, w: 210, h: 62 })).toBe(false);
  });

  it("pans to a node below the frame", () => {
    expect(shouldPan(viewport, { x: 100, y: 900, w: 210, h: 62 })).toBe(true);
  });
});

describe("expanded fit", () => {
  // The 17-node plan flow in an 808x877 stage.
  const layout = { width: 697, height: 1348 };
  const frame = { width: 808, height: 877 };

  it("fits the whole drawing at 0.61, below the 0.85 floor", () => {
    expect(fitZoom(layout, frame).toFixed(3)).toBe("0.615");
  });

  it("centers the drawing across and the focused node down at the floor", () => {
    const view = centerViewport(layout, frame, 0.85, { x: 0, y: 600, w: 210, h: 62 });
    expect(view.zoom).toBe(0.85);
    expect(view.x).toBeCloseTo(107.775);
    expect(view.y).toBeCloseTo(-97.85);
  });

  it("keeps the first node at the top instead of mid-stage", () => {
    const view = centerViewport(layout, frame, 0.85, { x: 243, y: 0, w: 210, h: 62 });
    expect(view.y).toBe(24);
  });

  it("keeps the last node at the bottom instead of mid-stage", () => {
    const view = centerViewport(layout, frame, 0.85, { x: 243, y: 1286, w: 210, h: 62 });
    expect(view.y).toBeCloseTo(-292.8);
  });

  it("centers the drawing on both axes at the fitted zoom", () => {
    const view = centerViewport(layout, frame, fitZoom(layout, frame), {
      x: 0,
      y: 1000,
      w: 210,
      h: 62,
    });
    expect(view.x).toBeCloseTo(189.678);
    expect(view.y).toBeCloseTo(24);
  });
});
