// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_LAYOUT_STORAGE_KEY } from "../../shared/contracts/panel.ts";
import {
  currentDiffLayout,
  currentTheme,
  onDidChangeDiffLayout,
  onDidChangeTheme,
  setDiffLayout,
} from "./theme.ts";

afterEach(() => {
  document.documentElement.className = "";
  window.localStorage.clear();
});

describe("theme", () => {
  it("follows bb's .dark class on <html>", () => {
    expect(currentTheme()).toBe("light");
    document.documentElement.classList.add("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("fires once per theme change, not per class change", async () => {
    const seen: string[] = [];
    const subscription = onDidChangeTheme((theme) => seen.push(theme));
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    document.documentElement.classList.add("unrelated");
    await Promise.resolve();
    document.documentElement.classList.remove("dark");
    await Promise.resolve();
    subscription.dispose();
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    expect(seen).toEqual(["dark", "light"]);
  });
});

describe("diff layout", () => {
  it("defaults to split and persists the reader's choice", async () => {
    expect(currentDiffLayout()).toBe("split");
    const listener = vi.fn();
    const subscription = onDidChangeDiffLayout(listener);
    await setDiffLayout("unified");
    expect(currentDiffLayout()).toBe("unified");
    expect(window.localStorage.getItem(DIFF_LAYOUT_STORAGE_KEY)).toBe("unified");
    expect(listener).toHaveBeenCalledWith("unified");
    subscription.dispose();
    await setDiffLayout("split");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("follows changes from other bb windows", () => {
    const listener = vi.fn();
    const subscription = onDidChangeDiffLayout(listener);
    window.dispatchEvent(
      new StorageEvent("storage", { key: DIFF_LAYOUT_STORAGE_KEY, newValue: "unified" }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "x" }));
    subscription.dispose();
    expect(listener.mock.calls).toEqual([["unified"]]);
  });
});
