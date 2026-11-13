import { describe, expect, test } from "bun:test";
import {
  SCROLL_SHORTCUTS,
  SCROLL_STEP_PX,
  VIMIUM_COMMANDS,
  adjacentThreadIndex,
  directShortcutFor,
  isTypingKey,
  scrollAmountFor,
  threadIdFromPath,
  type DirectKey,
} from "./direct-shortcuts.ts";
import { reservedControl, type ReservedControlId } from "./hint-labels.ts";

function key(overrides: Partial<DirectKey> = {}): DirectKey {
  return {
    key: "j",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    editableTarget: false,
    ...overrides,
  };
}

function actionOf(id: string) {
  return VIMIUM_COMMANDS.find((command) => command.id === id)?.action;
}

function reservedSelector(id: ReservedControlId): string {
  return reservedControl(id).selector;
}

describe("VIMIUM_COMMANDS", () => {
  test("ids are unique and valid bb plugin command ids", () => {
    const ids = VIMIUM_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/u);
  });

  test("control commands press the same control as their hint label", () => {
    for (const [id, control] of [
      ["new-thread", "new-thread"],
      ["home", "home"],
      ["settings", "settings"],
      ["model", "model"],
      ["project", "project"],
      ["machine", "machine"],
      ["branch", "branch"],
      ["permission-mode", "permission"],
    ] as const) {
      expect(actionOf(id)).toEqual({ kind: "control", selector: reservedSelector(control) });
    }
  });

  test("thread commands step, settle, undo, and search", () => {
    expect(actionOf("next-thread")).toEqual({ kind: "thread-step", step: 1 });
    expect(actionOf("previous-thread")).toEqual({ kind: "thread-step", step: -1 });
    expect(actionOf("settle-thread")).toEqual({ kind: "settle-thread" });
    expect(actionOf("undo-archive")).toEqual({ kind: "undo-archive" });
    expect(actionOf("search-threads")).toEqual({ kind: "thread-search" });
    expect(actionOf("focus-composer")).toEqual({ kind: "focus-composer" });
    expect(actionOf("cheatsheet")).toEqual({ kind: "cheatsheet" });
  });
});

describe("directShortcutFor", () => {
  test("j and k scroll the conversation a step and shift+j goes to the bottom", () => {
    expect(directShortcutFor(key({ key: "j" }))).toEqual({ kind: "scroll", motion: "down" });
    expect(directShortcutFor(key({ key: "k" }))).toEqual({ kind: "scroll", motion: "up" });
    expect(directShortcutFor(key({ key: "J", shiftKey: true }))).toEqual({
      kind: "scroll",
      motion: "bottom",
    });
  });

  test("command keys are bb's to dispatch, not vimium's", () => {
    for (const bound of ["n", "h", "s", ",", "[", "]", "e", "E", "?", "i", "m", "a"]) {
      expect(directShortcutFor(key({ key: bound }))).toBeNull();
    }
  });

  test("modifiers, editable targets, and unbound keys map to nothing", () => {
    expect(directShortcutFor(key({ ctrlKey: true }))).toBeNull();
    expect(directShortcutFor(key({ metaKey: true }))).toBeNull();
    expect(directShortcutFor(key({ altKey: true }))).toBeNull();
    expect(directShortcutFor(key({ key: "K", shiftKey: true }))).toBeNull();
    expect(directShortcutFor(key({ editableTarget: true }))).toBeNull();
    expect(directShortcutFor(key({ key: "f" }))).toBeNull();
  });

  test("every scroll key is a single character", () => {
    for (const bound of SCROLL_SHORTCUTS.keys()) expect(bound).toHaveLength(1);
  });
});

describe("isTypingKey", () => {
  const plain = { key: "n", ctrlKey: false, metaKey: false, altKey: false, editableTarget: true };

  test("a bare or shifted key in a text field is typing", () => {
    expect(isTypingKey(plain)).toBe(true);
  });

  test("a key outside a text field is not", () => {
    expect(isTypingKey({ ...plain, editableTarget: false })).toBe(false);
  });

  test("a key that types no character runs even from a text field", () => {
    expect(isTypingKey({ ...plain, key: "F8" })).toBe(false);
  });

  test("a Ctrl, Cmd, or Alt chord runs even from a text field", () => {
    expect(isTypingKey({ ...plain, ctrlKey: true })).toBe(false);
    expect(isTypingKey({ ...plain, metaKey: true })).toBe(false);
    expect(isTypingKey({ ...plain, altKey: true })).toBe(false);
  });
});

describe("scrollAmountFor", () => {
  const view = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 };

  test("a step is one step in either direction, wherever the view sits", () => {
    expect(scrollAmountFor("down", view)).toBe(SCROLL_STEP_PX);
    expect(scrollAmountFor("up", view)).toBe(-SCROLL_STEP_PX);
    expect(scrollAmountFor("down", { ...view, scrollTop: 599 })).toBe(SCROLL_STEP_PX);
    expect(scrollAmountFor("up", { ...view, scrollTop: 0 })).toBe(-SCROLL_STEP_PX);
  });

  test("the bottom is the distance left to the last scrollable pixel", () => {
    expect(scrollAmountFor("bottom", view)).toBe(500);
    expect(scrollAmountFor("bottom", { ...view, scrollTop: 600 })).toBe(0);
  });

  test("a view that does not overflow has nowhere to go", () => {
    const flat = { scrollTop: 0, scrollHeight: 300, clientHeight: 400 };
    expect(scrollAmountFor("bottom", flat)).toBe(0);
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
