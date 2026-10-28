// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerSheet, type SheetEntry } from "./answerSheet";

/** Vitest's jsdom environment exposes the JSDOM instance; only its window is used here. */
declare const jsdom: { window: Window & typeof globalThis };

const KEY = "bb.genui.sheet:thr_windows";

function entry(block: string, text: string): Omit<SheetEntry, "seq"> {
  return { block, question: "q", message: "m", reply: 0, fence: 0, position: 0, text, selection: text };
}

beforeEach(() => {
  // Node 25+ has its own global localStorage (undefined without --localstorage-file), which hides jsdom's.
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("two windows on one thread", () => {
  it("never answer each other's writes: no write follows another window's, the last writer wins", () => {
    const one = new AnswerSheet(KEY);
    const two = new AnswerSheet(KEY);
    const setItem = vi.spyOn(jsdom.window.Storage.prototype, "setItem");
    one.stage(entry("a", "Pro"));
    expect(setItem).toHaveBeenCalledTimes(1);
    // What the browser does for every other window when one writes the key.
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: localStorage.getItem(KEY) }));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect([...two.snapshot("a").staged.keys()]).toEqual([]);
    two.stage(entry("b", "Basic"));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: localStorage.getItem(KEY) }));
    expect(setItem).toHaveBeenCalledTimes(2);
    // A fresh page reads the last write.
    const fresh = new AnswerSheet(KEY);
    expect([...fresh.snapshot("a").staged.keys()]).toEqual([]);
    expect([...fresh.snapshot("b").staged.values()].map((item) => item.text)).toEqual(["Basic"]);
    setItem.mockRestore();
  });
});
