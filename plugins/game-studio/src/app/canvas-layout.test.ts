import { describe, expect, it } from "bun:test";
import { arrangeNodes, newNodePosition, revealNode } from "./canvas-layout.ts";

describe("arrange canvas nodes", () => {
  it("handles empty boards and positions a single card", () => {
    expect(arrangeNodes([], [])).toEqual([]);
    expect(arrangeNodes([{ id: "one", position: { x: -100, y: 900 } }], [])).toEqual([
      { id: "one", position: { x: 40, y: 40 } },
    ]);
  });

  it("puts disconnected cards in a compact grid without changing the draft data", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({
      id,
      position: { x: 10, y: 10 },
      measured: { width: 280, height: 140 },
      data: { text: id },
    }));
    const arranged = arrangeNodes(nodes, []);
    expect(arranged.map((node) => node.position)).toEqual([
      { x: 40, y: 40 },
      { x: 360, y: 40 },
      { x: 40, y: 220 },
      { x: 360, y: 220 },
    ]);
    expect(nodes.map((node) => node.position)).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
    ]);
    expect(arranged.map((node) => node.data)).toEqual([
      { text: "a" },
      { text: "b" },
      { text: "c" },
      { text: "d" },
    ]);
  });

  it("orders connected cards left to right and keeps loose cards below the flow", () => {
    const nodes = ["output", "input", "loose", "middle"].map((id) => ({
      id,
      position: { x: 10, y: 10 },
      measured: { width: 280, height: 140 },
    }));
    const edges = [
      { source: "input", target: "middle" },
      { source: "middle", target: "output" },
    ];
    expect(arrangeNodes(nodes, edges).map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "output", position: { x: 760, y: 40 } },
      { id: "input", position: { x: 40, y: 40 } },
      { id: "loose", position: { x: 40, y: 260 } },
      { id: "middle", position: { x: 400, y: 40 } },
    ]);
  });

  it("spaces variable-size cards even when their connections form a cycle", () => {
    const nodes = [
      { id: "a", position: { x: 0, y: 0 }, measured: { width: 400, height: 500 } },
      { id: "b", position: { x: 0, y: 0 }, measured: { width: 280, height: 140 } },
      { id: "c", position: { x: 0, y: 0 }, measured: { width: 280, height: 280 } },
    ];
    const arranged = arrangeNodes(nodes, [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
    ]);
    expect(arranged.map((node) => node.id)).toEqual(["a", "b", "c"]);
    for (const [index, a] of arranged.entries())
      for (const b of arranged.slice(index + 1)) {
        expect(
          a.position.x + a.measured.width + 40 <= b.position.x ||
            b.position.x + b.measured.width + 40 <= a.position.x ||
            a.position.y + a.measured.height + 40 <= b.position.y ||
            b.position.y + b.measured.height + 40 <= a.position.y,
        ).toBe(true);
      }
  });
});

describe("canvas placement", () => {
  it("adds in the current part of a panned board", () => {
    expect(newNodePosition({ x: 1200, y: -300 }, [])).toEqual({ x: 1060, y: -450 });
  });

  it("aligns repeated additions beside existing cards with room between them", () => {
    expect(
      newNodePosition({ x: 1200, y: -300 }, [
        { position: { x: 1060, y: -450 } },
        { position: { x: 1380, y: -450 } },
      ]),
    ).toEqual({ x: 740, y: -450 });
  });

  it("avoids the whole measured card even when its corner is far away", () => {
    expect(
      newNodePosition({ x: 140, y: 150 }, [
        { position: { x: -500, y: -200 }, measured: { width: 1000, height: 800 } },
      ]),
    ).toEqual({ x: 540, y: -200 });
  });

  it("rejects a nearby slot blocked by another card", () => {
    expect(
      newNodePosition({ x: 140, y: 150 }, [
        { position: { x: 0, y: 0 } },
        { position: { x: 310, y: 20 } },
        { position: { x: -310, y: -20 } },
      ]),
    ).toEqual({ x: 310, y: 360 });
  });

  it("leaves an open view and manually positioned cards alone", () => {
    const nodes = [{ position: { x: 2000, y: 2000 } }];
    expect(newNodePosition({ x: -500, y: -500 }, nodes)).toEqual({ x: -640, y: -650 });
    expect(nodes).toEqual([{ position: { x: 2000, y: 2000 } }]);
  });
});

describe("canvas camera", () => {
  it("does not move or zoom a card that is already visible", () => {
    expect(
      revealNode(
        { x: 100, y: 140, zoom: 0.5 },
        { width: 800, height: 600 },
        {
          x: 0,
          y: 0,
          width: 280,
          height: 180,
        },
      ),
    ).toEqual({ x: 100, y: 140, zoom: 0.5 });
  });

  it("pans just enough to reveal a card when the inspector narrows the canvas", () => {
    expect(
      revealNode(
        { x: 40, y: 140, zoom: 0.5 },
        { width: 400, height: 600 },
        {
          x: 500,
          y: 0,
          width: 280,
          height: 180,
        },
      ),
    ).toEqual({ x: -86, y: 140, zoom: 0.5 });
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
    ).toEqual({ x: 96, y: 132, zoom: 1 });
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
    ).toEqual({ x: -4, y: -20, zoom: 2 });
  });
});
