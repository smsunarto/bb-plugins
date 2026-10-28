import { describe, expect, it } from "vitest";
import type { SceneObject } from "../../core/scene";
import { acesFilmic, beforeAcesFilmic, frameCamera, gridEdges, gridTriangles, rampColor, rotationRows, sameNumbers, sceneBounds, surfaceGrid } from "./sceneMath";

const material = { color: "chart1", roughness: 0.5, metal: 0, glow: 0, glass: false, ior: 1.5, dispersion: 0, texture: null };

describe("frameCamera", () => {
  const bounds = { min: [-1, 0, -1] as const, max: [1, 2, 1] as const };

  it("aims at the centre from four bounding radii out, at the orbit's angles", () => {
    const view = frameCamera(bounds, { yaw: 0, pitch: 0, zoom: 1 }, 600, 300);
    expect(view.target).toEqual([0, 1, 0]);
    expect(view.radius).toBeCloseTo(Math.sqrt(3));
    expect(view.eye[0]).toBeCloseTo(0);
    expect(view.eye[1]).toBeCloseTo(1);
    expect(view.eye[2]).toBeCloseTo(4 * Math.sqrt(3));
  });

  it("keeps the lens as the scene turns, so a spinning scene keeps its size", () => {
    const a = frameCamera(bounds, { yaw: 0, pitch: 0.4, zoom: 1 }, 600, 300);
    const b = frameCamera(bounds, { yaw: 2.1, pitch: 0.4, zoom: 1 }, 600, 300);
    expect(b.fov).toBeCloseTo(a.fov);
  });

  it("narrows the lens to zoom in", () => {
    const wide = frameCamera(bounds, { yaw: 0, pitch: 0.4, zoom: 1 }, 600, 300);
    const close = frameCamera(bounds, { yaw: 0, pitch: 0.4, zoom: 2 }, 600, 300);
    expect(Math.tan((close.fov * Math.PI) / 360)).toBeCloseTo(Math.tan((wide.fov * Math.PI) / 360) / 2);
  });

  it("fits the tall extent within the height (with Zeron's margin)", () => {
    const view = frameCamera(bounds, { yaw: 0, pitch: 0, zoom: 1 }, 2000, 300);
    // Seen level, the scene is 2 tall at 4r: the lens spans 2 / 0.86 there.
    const span = 2 * Math.tan((view.fov * Math.PI) / 360) * 4 * Math.sqrt(3);
    expect(span).toBeCloseTo(2 / 0.86);
  });

  it("frames a unit cube when nothing has extent", () => {
    expect(frameCamera(null, { yaw: 0, pitch: 0, zoom: 1 }, 300, 300).target).toEqual([0, 0, 0]);
  });
});

describe("rotationRows", () => {
  it("turns about x, then y, then z", () => {
    const rows = rotationRows([90, 90, 0]);
    // (0, 1, 0) about x by 90° is (0, 0, 1); about y by 90° that is (1, 0, 0).
    const turned = rows.map((row) => row[0] * 0 + row[1] * 1 + row[2] * 0);
    expect(turned[0]).toBeCloseTo(1);
    expect(turned[1]).toBeCloseTo(0);
    expect(turned[2]).toBeCloseTo(0);
  });
});

describe("sceneBounds", () => {
  it("covers a turned box's corners, a cylinder from its base and the grid", () => {
    const objects: SceneObject[] = [
      { shape: "box", at: [0, 0, 0], size: [2, 2, 2], rotate: [0, 45, 0], material },
      { shape: "cylinder", at: [5, 1, 0], radius: 0.5, height: 3, detail: 24, material },
      { shape: "grid", size: 2, step: 1, y: -1 },
    ];
    const bounds = sceneBounds(objects)!;
    expect(bounds.min[0]).toBeCloseTo(-Math.SQRT2);
    expect(bounds.min[1]).toBeCloseTo(-1);
    expect(bounds.max[0]).toBeCloseTo(5.5);
    expect(bounds.max[1]).toBeCloseTo(4);
    expect(bounds.max[2]).toBeCloseTo(Math.SQRT2);
  });

  it("leaves out models and environments, which have no extent until loaded", () => {
    expect(sceneBounds([{ shape: "environment", src: "a.hdr", intensity: 1, background: false }])).toBeNull();
  });
});

describe("surface grid", () => {
  it("lays rows along z and columns along x, cut to the shortest row", () => {
    const grid = surfaceGrid([0, 2], [10, 11], [
      [0, 1, 2],
      [3, 4],
    ]);
    expect([grid.rows, grid.cols]).toEqual([2, 2]);
    expect([...grid.positions]).toEqual([0, 0, 10, 2, 1, 10, 0, 3, 11, 2, 4, 11]);
    expect([...grid.heights]).toEqual([0, 0.25, 0.75, 1]);
  });

  it("makes two triangles per cell and edges without diagonals", () => {
    expect([...gridTriangles(2, 2)]).toEqual([0, 2, 1, 1, 2, 3]);
    expect(gridEdges(3, 3).length / 2).toBe(12);
  });
});

describe("rampColor", () => {
  it("runs between neighbouring colours", () => {
    const ramp = [[0, 0, 0], [1, 0, 0], [1, 1, 0]] as const;
    expect(rampColor(ramp, 0)).toEqual([0, 0, 0]);
    expect(rampColor(ramp, 0.25)).toEqual([0.5, 0, 0]);
    expect(rampColor(ramp, 1)).toEqual([1, 1, 0]);
    expect(rampColor([[0.2, 0.3, 0.4]], 0.7)).toEqual([0.2, 0.3, 0.4]);
  });
});

describe("sameNumbers", () => {
  it("compares nested lists by value", () => {
    expect(sameNumbers([[1, 2], [3]], [[1, 2], [3]])).toBe(true);
    expect(sameNumbers([[1, 2], [3]], [[1, 2], [4]])).toBe(false);
    expect(sameNumbers([1, 2], [1])).toBe(false);
  });
});

describe("beforeAcesFilmic", () => {
  it("gives the colour that tone mapping turns back into the theme's", () => {
    for (const color of [[0.78, 0.8, 0.83], [0.05, 0.05, 0.06], [0.2, 0.4, 0.9], [0, 0, 0]] as const) {
      const shown = acesFilmic(beforeAcesFilmic(color));
      for (let channel = 0; channel < 3; channel++) expect(shown[channel]).toBeCloseTo(color[channel], 3);
    }
  });
});
