import { describe, expect, test } from "bun:test";
import {
  DIRECT_SHORTCUTS,
  adjacentThreadIndex,
  directShortcutFor,
  threadIdFromPath,
  type DirectKey,
} from "./direct-shortcuts.ts";
import { RESERVED_CONTROLS } from "./hint-labels.ts";

function key(overrides: Partial<DirectKey> = {}): DirectKey {
  return {
    key: "m",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    editableTarget: false,
    ...overrides,
  };
}

describe("directShortcutFor", () => {
  test("control keys reuse the reserved hint selectors", () => {
    for (const char of ["n", "m", "p", "l", "b", "k", "s", ","]) {
      const reserved = RESERVED_CONTROLS.find((control) => control.char === char);
      expect(directShortcutFor(key({ key: char }))).toEqual({
        kind: "control",
        selector: reserved?.selector ?? "",
      });
    }
  });

  test("brackets step threads and e settles", () => {
    expect(directShortcutFor(key({ key: "[" }))).toEqual({ kind: "thread-step", step: -1 });
    expect(directShortcutFor(key({ key: "]" }))).toEqual({ kind: "thread-step", step: 1 });
    expect(directShortcutFor(key({ key: "e" }))).toEqual({ kind: "settle-thread" });
    expect(directShortcutFor(key({ key: "i" }))).toEqual({ kind: "focus-composer" });
  });

  test("modifiers, editable targets, and unbound keys map to nothing", () => {
    expect(directShortcutFor(key({ ctrlKey: true }))).toBeNull();
    expect(directShortcutFor(key({ metaKey: true }))).toBeNull();
    expect(directShortcutFor(key({ altKey: true }))).toBeNull();
    expect(directShortcutFor(key({ key: "M", shiftKey: true }))).toBeNull();
    expect(directShortcutFor(key({ editableTarget: true }))).toBeNull();
    expect(directShortcutFor(key({ key: "f" }))).toBeNull();
    expect(directShortcutFor(key({ key: "q" }))).toBeNull();
  });

  test("every direct key is a single character", () => {
    for (const bound of DIRECT_SHORTCUTS.keys()) expect(bound).toHaveLength(1);
  });
});

describe("threadIdFromPath", () => {
  test("reads the thread id from both bb thread routes", () => {
    expect(threadIdFromPath("/threads/thr_1")).toBe("thr_1");
    expect(threadIdFromPath("/projects/proj_a/threads/thr_2/files")).toBe("thr_2");
    expect(threadIdFromPath("/threads/thr_3?tab=diff")).toBe("thr_3");
  });

  test("other routes have no thread", () => {
    expect(threadIdFromPath("/")).toBeNull();
    expect(threadIdFromPath("/settings")).toBeNull();
    expect(threadIdFromPath("/projects/proj_a")).toBeNull();
  });
});

describe("adjacentThreadIndex", () => {
  const ids = ["a", "b", "c"];

  test("steps forward and back from the active thread, wrapping at the ends", () => {
    expect(adjacentThreadIndex(ids, "a", 1)).toBe(1);
    expect(adjacentThreadIndex(ids, "b", -1)).toBe(0);
    expect(adjacentThreadIndex(ids, "c", 1)).toBe(0);
    expect(adjacentThreadIndex(ids, "a", -1)).toBe(2);
  });

  test("with no active thread ] starts at the top and [ at the bottom", () => {
    expect(adjacentThreadIndex(ids, null, 1)).toBe(0);
    expect(adjacentThreadIndex(ids, null, -1)).toBe(2);
    expect(adjacentThreadIndex(ids, "missing", 1)).toBe(0);
  });

  test("an empty list has nowhere to go", () => {
    expect(adjacentThreadIndex([], "a", 1)).toBeNull();
  });
});
