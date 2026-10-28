import { describe, expect, it } from "vitest";
import { darkened, shapeClassLines, sketchMermaid, sketchPalette } from "./sketch";

describe("darkened", () => {
  // Excalidraw's dark canvas is its white canvas through invert(93%) hue-rotate(180deg).
  it("matches Excalidraw's dark theme filter", () => {
    expect(darkened("#ffffff")).toBe("#121212");
    expect(darkened("#000000")).toBe("#ededed");
  });
});

describe("sketchMermaid", () => {
  it("adds the hand-drawn look in front of the diagram", () => {
    const out = sketchMermaid("flowchart LR\n  a --> b");
    expect(out.startsWith("---\nconfig:\n  look: handDrawn")).toBe(true);
    expect(out).toContain("---\nflowchart LR\n  a --> b");
  });

  it("leaves a diagram with its own front matter or init directive alone", () => {
    const own = "---\nconfig:\n  theme: forest\n---\nflowchart LR\n  a --> b";
    expect(sketchMermaid(own)).toBe(own);
    const init = "%%{init: {'theme': 'dark'}}%%\nsequenceDiagram\n  A->>B: hi";
    expect(sketchMermaid(init)).toBe(init);
  });

  it("styles other diagram types without flowchart classes", () => {
    const out = sketchMermaid("sequenceDiagram\n  A->>B: hi {x}");
    expect(out).toContain("look: handDrawn");
    expect(out).not.toContain("classDef");
  });

  it("draws in the dark palette under a dark theme", () => {
    const dark = sketchPalette(true);
    const out = sketchMermaid("flowchart LR\n  ok{Valid?} --> b", true);
    expect(out).toContain(`background: "${dark.canvas}"`);
    expect(out).toContain(`classDef sketchDecision fill:${dark.yellow}`);
    expect(out).not.toContain(sketchPalette(false).yellow);
  });
});

describe("shapeClassLines", () => {
  it("colours decisions, stores, terminals and events by shape", () => {
    const lines = shapeClassLines(
      [
        "flowchart TD",
        "  start((Start)) --> form[Form]",
        "  form --> ok{Valid?}",
        "  ok -->|yes| db[(Users)]",
        "  ok -->|no| hex{{Retry}}",
        "  hook>Webhook] --> form",
      ].join("\n"),
    );
    expect(lines).toEqual([
      "  classDef sketchDecision fill:#ffec99",
      "  class ok,hex sketchDecision",
      "  classDef sketchStore fill:#b2f2bb",
      "  class db sketchStore",
      "  classDef sketchTerminal fill:#ffc9c9",
      "  class start sketchTerminal",
      "  classDef sketchEvent fill:#d0bfff",
      "  class hook sketchEvent",
    ]);
  });

  it("does not take arrows or edge text for node shapes", () => {
    expect(shapeClassLines("graph LR\n  a --> b\n  b -->|go {now}| c\n  c -.-> d")).toEqual([]);
  });

  it("keeps the model's own colours", () => {
    expect(shapeClassLines("flowchart LR\n  ok{Valid?}\n  classDef hot fill:#f00")).toEqual([]);
    expect(shapeClassLines("flowchart LR\n  ok{Valid?}:::hot")).toEqual([]);
    expect(shapeClassLines("flowchart LR\n  ok{Valid?}\n  style ok fill:#f00")).toEqual([]);
  });
});
