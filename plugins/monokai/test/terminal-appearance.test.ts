import { describe, expect, mock, test } from "bun:test";

import {
  applyTerminalAppearance,
  findTerminalBinding,
  type TerminalAppearance,
} from "../app/terminal-appearance.ts";

const appearance: TerminalAppearance = {
  fontFamily: '"BerkeleyMono Nerd Font Mono", monospace',
  fontSize: 13,
  lineHeight: 1.4,
  background: "#141414",
};

function fixture() {
  const element = {} as Element;
  const options = {
    fontFamily: "host-font",
    fontSize: 12,
    lineHeight: 1,
    theme: { background: "#181818", cursorAccent: "#181818", red: "#ff0000" },
  };
  const terminal = {
    element,
    options,
    rows: 20,
    refresh: mock(() => {}),
    _addonManager: { _addons: [] as Array<{ instance: unknown }> },
  };
  const fit = {
    _terminal: terminal,
    fit: mock(() => {
      terminal.rows = 16;
    }),
    proposeDimensions: mock(() => ({ cols: 80, rows: 16 })),
  };
  terminal._addonManager._addons.push({ instance: fit });
  const fiber = {
    memoizedState: { memoizedState: { current: terminal }, next: null },
    return: null,
  };
  return { element, terminal, fit, fiber };
}

describe("terminal discovery", () => {
  test("finds an owning terminal and its FitAddon without component names or hook positions", () => {
    const { element, terminal, fit, fiber } = fixture();
    const root = { memoizedState: { memoizedState: "unrelated state", next: null }, return: fiber };
    const binding = findTerminalBinding(root, element);
    expect(binding?.terminal).toBe(terminal);
    binding?.fit();
    expect(fit.fit).toHaveBeenCalledTimes(1);
  });

  test("does not select a terminal belonging to another DOM element", () => {
    expect(findTerminalBinding(fixture().fiber, {} as Element)).toBeNull();
  });

  test("does not use another terminal's fit addon", () => {
    const { element, terminal, fiber } = fixture();
    terminal._addonManager._addons = [{ instance: { ...fixture().fit } }];
    expect(findTerminalBinding(fiber, element)).toBeNull();
  });

  test("skips unsupported host shapes and bounds cyclic traversal", () => {
    const { element, terminal, fiber } = fixture();
    terminal._addonManager._addons = [];
    expect(findTerminalBinding(fiber, element)).toBeNull();
    const cycle: { memoizedState: unknown; return?: unknown } = { memoizedState: null };
    const hook: { memoizedState: unknown; next?: unknown } = { memoizedState: null };
    hook.next = hook;
    cycle.memoizedState = hook;
    cycle.return = cycle;
    expect(findTerminalBinding(cycle, element)).toBeNull();
    expect(findTerminalBinding(null, element)).toBeNull();
  });
});

describe("terminal appearance ownership", () => {
  test("applies real xterm options, refits the grid, and restores the originals", () => {
    const { terminal, fit } = fixture();
    const original = structuredClone(terminal.options);
    const restore = applyTerminalAppearance({ terminal, fit: fit.fit }, appearance);
    expect(terminal.options).toEqual({
      fontFamily: appearance.fontFamily,
      fontSize: 13,
      lineHeight: 1.4,
      theme: { background: "#141414", cursorAccent: "#141414", red: "#ff0000" },
    });
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 15);
    restore();
    expect(terminal.options).toEqual(original);
    expect(fit.fit).toHaveBeenCalledTimes(2);
  });

  test("preserves changes made by another theme before cleanup", () => {
    const { terminal, fit } = fixture();
    const restore = applyTerminalAppearance({ terminal, fit: fit.fit }, appearance);
    terminal.options.fontFamily = "new-theme-font";
    terminal.options.theme = { background: "#ffffff", cursorAccent: "#eeeeee", red: "#990000" };
    restore();
    expect(terminal.options.fontFamily).toBe("new-theme-font");
    expect(terminal.options.fontSize).toBe(12);
    expect(terminal.options.theme).toEqual({
      background: "#ffffff",
      cursorAccent: "#eeeeee",
      red: "#990000",
    });
  });

  test("rolls back an application if the terminal becomes unavailable", () => {
    const { terminal } = fixture();
    const original = structuredClone(terminal.options);
    const fit = mock(() => {
      throw new Error("disposed");
    });
    expect(() => applyTerminalAppearance({ terminal, fit }, appearance)).toThrow("disposed");
    expect(terminal.options).toEqual(original);
  });
});
