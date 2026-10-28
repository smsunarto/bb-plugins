import { describe, expect, it } from "vitest";
import {
  conditionDifferences,
  conditionsWarning,
  fileName,
  isConditionKey,
  placement,
  readCompare,
  sizeWarning,
  type CompareImage,
} from "./compare";
import type { Value } from "./types";

function images(value: Value): readonly CompareImage[] {
  const read = readCompare(value);
  if (!read.ok) throw new Error(read.error);
  return read.images;
}

describe("readCompare", () => {
  it("reads bare srcs: the first is the reference, the others are named after their file", () => {
    expect(images(["shots/before.png", "https://example.com/a/after%20fix.png?v=2"])).toEqual([
      { src: "shots/before.png", label: "Reference", named: false, note: null, meta: [] },
      { src: "https://example.com/a/after%20fix.png?v=2", label: "after fix.png", named: false, note: null, meta: [] },
    ]);
  });

  it("reads objects with labels, notes and meta, and takes scalar keys beside src as meta", () => {
    const [reference, candidate] = images([
      { src: " $BB_THREAD_STORAGE/pen.png ", label: "Pen reference", meta: { viewport: "1440×900", theme: "light", retina: true } },
      { path: "C:\\shots\\live.png", name: "Live page", note: "after the hero fix", theme: "dark", build: 413, meta: { theme: "light (ignored, meta first)" } },
    ]);
    expect(reference).toEqual({
      src: "$BB_THREAD_STORAGE/pen.png",
      label: "Pen reference",
      named: true,
      note: null,
      meta: [
        ["viewport", "1440×900"],
        ["theme", "light"],
        ["retina", "yes"],
      ],
    });
    expect(candidate).toMatchObject({ src: "C:\\shots\\live.png", label: "Live page", note: "after the hero fix" });
    expect(candidate?.meta).toEqual([
      ["theme", "light (ignored, meta first)"],
      ["build", "413"],
    ]);
  });

  it("counts entries without a usable src and refuses what is not a list", () => {
    const read = readCompare(["a.png", "", null, 3, true, { label: "no src" }, { src: "  " }, { src: "b.png" }]);
    expect(read).toMatchObject({ ok: true, ignored: 6 });
    expect(read.ok && read.images.map((image) => image.src)).toEqual(["a.png", "b.png"]);
    expect(readCompare("a.png")).toMatchObject({ ok: false });
    expect(readCompare(undefined)).toMatchObject({ ok: false });
    expect(readCompare([])).toEqual({ ok: true, images: [], ignored: 0 });
  });

  it("names files without query, fragment or trailing slash; Windows paths too", () => {
    expect(fileName("a/b/c.png#x")).toBe("c.png");
    expect(fileName("C:\\Users\\me\\shot 1.png")).toBe("shot 1.png");
    expect(fileName("https://x.dev/%E2%9C%93.png")).toBe("✓.png");
    expect(fileName("https://x.dev/%E2.png")).toBe("%E2.png");
  });
});

describe("conditionDifferences", () => {
  const [pen, live, phone] = images([
    { src: "pen.png", meta: { build: "pen v3", theme: "Light", viewport: "1440 x 900", Device: "MacBook", captured: "2026-10-01" } },
    { src: "live.png", meta: { build: "412", theme: "light", viewport: "1440×900", device: "MacBook", captured: "2026-10-09" } },
    { src: "phone.png", label: "Phone", meta: { theme: "dark", viewport: "393×852", time: "19:49", "captured-at": "2026-10-09" } },
  ]);

  it("ignores identity facts and spelling of the same condition", () => {
    expect(conditionDifferences(pen!, live!)).toEqual([]);
  });

  it("lists differing values and conditions stated for one side only", () => {
    expect(conditionDifferences(pen!, phone!)).toEqual([
      { key: "theme", reference: "Light", candidate: "dark" },
      { key: "viewport", reference: "1440 x 900", candidate: "393×852" },
      { key: "Device", reference: "MacBook", candidate: null },
      { key: "time", reference: null, candidate: "19:49" },
    ]);
    expect(conditionsWarning(conditionDifferences(pen!, phone!), "Reference", "Phone")).toBe(
      "Not the same conditions: theme Light vs dark · viewport 1440 x 900 vs 393×852 · Device stated only for Reference (MacBook) · time stated only for Phone (19:49)",
    );
    expect(conditionsWarning([], "Reference", "Phone")).toBeNull();
  });

  it("treats build, commit and capture dates as identity, everything else as a condition", () => {
    expect(["build", "SHA", "captured_at", "capturedAt", "url"].map(isConditionKey)).toEqual([false, false, false, false, false]);
    expect(["theme", "viewport", "device", "time", "browser", "state"].map(isConditionKey)).toEqual([true, true, true, true, true, true]);
  });
});

describe("placement and sizeWarning", () => {
  it("says nothing for equal sizes", () => {
    expect(placement({ width: 720, height: 683 }, { width: 720, height: 683 })).toMatchObject({ scale: 1, sameSize: true, sameAspect: true });
    expect(sizeWarning({ width: 720, height: 683 }, { width: 720, height: 683 }, "Live")).toBeNull();
  });

  it("scales a 2x capture of the same aspect", () => {
    expect(placement({ width: 720, height: 683 }, { width: 1440, height: 1366 })).toEqual({ scale: 0.5, width: 720, height: 683, sameSize: false, sameAspect: true });
    expect(sizeWarning({ width: 1440, height: 900 }, { width: 1280, height: 800 }, "Live")).toBe("Sizes differ: 1440×900 vs 1280×800, Live scaled ×1.13 to the reference");
  });

  it("top-aligns another aspect at the reference width and says which way it is off", () => {
    expect(placement({ width: 1000, height: 800 }, { width: 500, height: 300 })).toMatchObject({ scale: 2, height: 600, sameAspect: false });
    expect(sizeWarning({ width: 1000, height: 800 }, { width: 500, height: 300 }, "Live")).toBe(
      "Sizes differ: 1000×800 vs 500×300; scaled ×2 to the reference width, top-aligned, Live is 200 px shorter (the rest counts as changed)",
    );
    expect(sizeWarning({ width: 1000, height: 800 }, { width: 1000, height: 1200 }, "Live")).toBe(
      "Sizes differ: 1000×800 vs 1000×1200; top-aligned, Live is 400 px taller (cut at the reference height)",
    );
  });
});
