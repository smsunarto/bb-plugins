import { describe, expect, it } from "vitest";
import { HeightStore } from "./reservedHeight";

describe("HeightStore", () => {
  it("gives a block's height back only at about the width it settled at", () => {
    const store = new HeightStore();
    store.set("a", 720, 412.4);
    expect(store.get("a", 723)).toBe(412);
    expect(store.get("a", 717)).toBe(412);
    expect(store.get("a", 393)).toBeNull();
    expect(store.get("a")).toBe(412);
    expect(store.get("b", 720)).toBeNull();
  });

  it("keeps the most recently settled blocks when full", () => {
    const store = new HeightStore(2);
    store.set("a", 720, 100);
    store.set("b", 720, 200);
    store.set("a", 720, 110);
    store.set("c", 720, 300);
    expect([store.get("a"), store.get("b"), store.get("c")]).toEqual([110, null, 300]);
  });

  it("round-trips through storage and skips what a damaged copy holds", () => {
    const store = new HeightStore();
    store.set("a", 720, 100);
    expect(HeightStore.read(store.serialize()).get("a", 720)).toBe(100);
    const mixed = JSON.stringify([["a", [720, 100]], ["b", [720, -5]], ["c", "tall"], [3, [720, 50]]]);
    const read = HeightStore.read(mixed);
    expect([read.get("a"), read.get("b"), read.get("c")]).toEqual([100, null, null]);
    expect(HeightStore.read("{not json").get("a")).toBeNull();
    expect(HeightStore.read(null).get("a")).toBeNull();
  });
});
