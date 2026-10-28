import { describe, expect, it } from "vitest";
import { CodeHeights } from "./codeHeight";

describe("CodeHeights", () => {
  it("predicts nothing until it has seen two lengths of code", () => {
    const store = new CodeHeights();
    expect(store.predict(5, 384)).toBeNull();
    store.record(2, 68);
    expect(store.predict(2, 384)).toBe(68);
    expect(store.predict(5, 384)).toBeNull();
  });

  it("puts unseen lengths on the line through the nearest lengths it has seen, up to the body's cap", () => {
    const store = new CodeHeights();
    store.record(1, 50);
    store.record(2, 68);
    expect(store.predict(10, 384)).toBe(212);
    expect(store.predict(19, 384)).toBe(374);
    expect(store.predict(30, 384)).toBe(384);
  });

  it("leaves capped heights out of the line, and follows the viewer when it draws a length differently", () => {
    const store = new CodeHeights();
    store.record(1, 50);
    store.record(25, 384);
    expect(store.predict(4, 384)).toBeNull();
    store.record(2, 68);
    expect(store.predict(4, 384)).toBe(104);
    store.record(2, 72);
    expect(store.predict(2, 384)).toBe(72);
  });

  it("round-trips through storage and skips what a damaged copy holds", () => {
    const store = new CodeHeights();
    store.record(1, 50);
    store.record(2, 68);
    expect(CodeHeights.read(store.serialize()).predict(3, 384)).toBe(86);
    const mixed = CodeHeights.read(JSON.stringify([[1, 50], [2, -4], ["3", 86], [4, "tall"], [0, 30]]));
    expect([mixed.predict(1, 384), mixed.predict(2, 384)]).toEqual([50, null]);
    expect(CodeHeights.read("{not json").predict(1, 384)).toBeNull();
  });
});

