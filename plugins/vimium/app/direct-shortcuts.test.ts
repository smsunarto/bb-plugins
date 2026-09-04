import { describe, expect, test } from "bun:test";
import {
  DIRECT_SHORTCUTS,
  SCROLL_GOAL_MS,
  SCROLL_STEP_PX,
  adjacentThreadIndex,
  directShortcutFor,
  scrollBaseFor,
  scrollTopFor,
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
    for (const char of ["n", "m", "p", "l", "b", "s", ","]) {
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

  test("j and k scroll the conversation a step and shift+j goes to the bottom", () => {
    expect(directShortcutFor(key({ key: "j" }))).toEqual({ kind: "scroll", motion: "down" });
    expect(directShortcutFor(key({ key: "k" }))).toEqual({ kind: "scroll", motion: "up" });
    expect(directShortcutFor(key({ key: "J", shiftKey: true }))).toEqual({
      kind: "scroll",
      motion: "bottom",
    });
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

describe("scrollTopFor", () => {
  const view = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 };

  test("steps down and up by one step", () => {
    expect(scrollTopFor("down", view)).toBe(100 + SCROLL_STEP_PX);
    expect(scrollTopFor("up", view)).toBe(100 - SCROLL_STEP_PX);
  });

  test("clamps to the top and to the bottom", () => {
    expect(scrollTopFor("up", { ...view, scrollTop: 10 })).toBe(0);
    expect(scrollTopFor("down", { ...view, scrollTop: 590 })).toBe(600);
    expect(scrollTopFor("bottom", view)).toBe(600);
  });

  test("a view that does not overflow stays at zero", () => {
    const flat = { scrollTop: 0, scrollHeight: 300, clientHeight: 400 };
    expect(scrollTopFor("down", flat)).toBe(0);
    expect(scrollTopFor("bottom", flat)).toBe(0);
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

describe("scrollBaseFor", () => {
  test("a fresh goal is the base", () => {
    expect(scrollBaseFor({ top: 120, at: 1000 }, 1000 + SCROLL_GOAL_MS - 1, 75)).toBe(120);
  });

  test("a stale goal yields to the live scrollTop", () => {
    expect(scrollBaseFor({ top: 120, at: 1000 }, 1000 + SCROLL_GOAL_MS, 75)).toBe(75);
  });

  test("no goal yields to the live scrollTop", () => {
    expect(scrollBaseFor(null, 1000, 75)).toBe(75);
  });
});
