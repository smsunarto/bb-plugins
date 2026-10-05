import { beforeEach, expect, it, vi } from "vitest";

const bundled = vi.hoisted(() => ({ constructed: 0 }));

vi.mock("elkjs/lib/elk.bundled.js", () => ({
  default: class {
    constructor() {
      bundled.constructed++;
    }
    layout(graph: { id: string }) {
      return Promise.resolve({ ...graph, width: 210, height: 62 });
    }
  },
}));

beforeEach(() => {
  bundled.constructed = 0;
  vi.resetModules();
});

it("does not boot ELK until something is laid out", async () => {
  const { default: ELK } = await import("./elk.ts");

  const flow = new ELK();
  const map = new ELK();

  expect(flow).not.toBe(map);
  expect(bundled.constructed).toBe(0);
});

it("boots one shared ELK for every instance's layouts", async () => {
  const { default: ELK } = await import("./elk.ts");

  const first = await new ELK().layout({ id: "flow" });
  const second = await new ELK().layout({ id: "c4" });

  expect(bundled.constructed).toBe(1);
  expect(first).toEqual({ id: "flow", width: 210, height: 62 });
  expect(second).toEqual({ id: "c4", width: 210, height: 62 });
});

it("loading the vendored diagram layouts boots no ELK", async () => {
  // c4-layout-geometry.ts builds its ELK at module scope (polish-diagram.json
  // redirects its import here); flow-graph.tsx builds one per graph.
  await import("../vendor/review/app/src/software-map/c4-layout-geometry.ts");

  expect(bundled.constructed).toBe(0);
});
