import { describe, expect, it } from "vitest";
import { croppable, singleBox, tileLayout } from "./gallery-logic";

describe("tileLayout", () => {
  it("is a single column when one column is laid out", () => {
    expect(tileLayout(false, 1)).toBe("single");
    expect(tileLayout(false, 3)).toBe("grid");
    expect(tileLayout(true, 1)).toBe("strip");
  });
});

describe("singleBox", () => {
  it("keeps a wide screenshot's ratio, at most its own width and 24rem tall", () => {
    expect(singleBox({ width: 1500, height: 400 })).toEqual({
      aspectRatio: "3.75",
      maxWidth: "min(100%, 1500px, 90rem)",
    });
  });

  it("clamps the ratio to 1:2 and 4:1", () => {
    expect(singleBox({ width: 400, height: 900 }).aspectRatio).toBe("0.5");
    expect(singleBox({ width: 2000, height: 100 }).aspectRatio).toBe("4");
  });

  it("never enlarges a small picture past its own width", () => {
    expect(singleBox({ width: 64, height: 64 }).maxWidth).toBe("min(100%, 64px, 24rem)");
  });

  it("is 4:3 at the column's width before the size is known", () => {
    expect(singleBox(null)).toEqual({ aspectRatio: String(4 / 3), maxWidth: "100%" });
  });
});

describe("croppable", () => {
  it("crops found photos from square to 16:9", () => {
    expect(croppable({ width: 1000, height: 1000 }, true)).toBe(true);
    expect(croppable({ width: 1500, height: 1000 }, true)).toBe(true);
    expect(croppable({ width: 1920, height: 1080 }, true)).toBe(true);
    expect(croppable({ width: 2000, height: 1000 }, true)).toBe(false);
    expect(croppable({ width: 800, height: 1200 }, true)).toBe(false);
  });

  it("crops files and URLs only close to 4:3, so screenshots keep their edges", () => {
    expect(croppable({ width: 1600, height: 1200 }, false)).toBe(true);
    expect(croppable({ width: 1250, height: 1000 }, false)).toBe(true);
    expect(croppable({ width: 1240, height: 1000 }, false)).toBe(false);
    expect(croppable({ width: 1500, height: 1000 }, false)).toBe(false);
    expect(croppable({ width: 1500, height: 400 }, false)).toBe(false);
  });

  it("crops a picture of unknown size, as before", () => {
    expect(croppable(null, false)).toBe(true);
  });
});
