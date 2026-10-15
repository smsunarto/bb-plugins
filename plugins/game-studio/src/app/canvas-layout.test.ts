import { describe, expect, it } from "bun:test";
import { newNodePosition, revealNode } from "./canvas-layout.ts";

describe("canvas placement", () => {
  it("adds in the current part of a panned board and offsets repeated additions", () => {
    expect(newNodePosition({ x: 1200, y: -300 }, [])).toEqual({ x: 1060, y: -390 });
    expect(
      newNodePosition({ x: 1200, y: -300 }, [
        { position: { x: 1060, y: -390 } },
        { position: { x: 1092, y: -358 } },
      ]),
    ).toEqual({ x: 1124, y: -326 });
  });
});

describe("canvas camera", () => {
  it("does not move or zoom a card that is already visible", () => {
    expect(
      revealNode(
        { x: 40, y: 100, zoom: 0.5 },
        { width: 800, height: 600 },
        {
          x: 0,
          y: 0,
          width: 280,
          height: 180,
        },
      ),
    ).toEqual({ x: 40, y: 100, zoom: 0.5 });
  });

  it("pans just enough to reveal a card when the inspector narrows the canvas", () => {
    expect(
      revealNode(
        { x: 40, y: 100, zoom: 0.5 },
        { width: 320, height: 600 },
        {
          x: 500,
          y: 0,
          width: 280,
          height: 180,
        },
      ),
    ).toEqual({ x: -90, y: 100, zoom: 0.5 });
  });

  it("keeps a card above the dock in a short mobile stage", () => {
    expect(
      revealNode(
        { x: 20, y: 250, zoom: 1 },
        { width: 390, height: 400 },
        {
          x: 0,
          y: 0,
          width: 280,
          height: 180,
        },
      ),
    ).toEqual({ x: 20, y: 132, zoom: 1 });
  });

  it("keeps the header reachable when a card is larger than the available stage", () => {
    expect(
      revealNode(
        { x: -800, y: -600, zoom: 2 },
        { width: 320, height: 300 },
        {
          x: 50,
          y: 70,
          width: 280,
          height: 400,
        },
      ),
    ).toEqual({ x: -80, y: -80, zoom: 2 });
  });
});
