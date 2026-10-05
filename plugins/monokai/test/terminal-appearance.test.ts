import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

import {
  applyTerminalAppearance,
  findTerminalBinding,
  mountTerminalAppearance,
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

const DOM_GLOBALS = [
  "document",
  "getComputedStyle",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];
afterEach(() => {
  for (const name of DOM_GLOBALS) Reflect.deleteProperty(globalThis, name);
});

// A bb 0.45 page with one terminal in a 480px pane. Like ThreadTerminalView,
// bb refits on document.fonts "loadingdone" and sends the PTY xterm's rows.
function bbPage() {
  const { element, terminal, fit, fiber } = fixture();
  Object.assign(element, { isConnected: true, __reactFiber$test: fiber });
  fit.fit.mockImplementation(() => {
    terminal.rows = Math.floor(480 / (terminal.options.fontSize * terminal.options.lineHeight));
  });
  const ptyRows: number[] = [];
  const frames: Array<() => void> = [];
  const fonts = new EventTarget();
  fonts.addEventListener("loadingdone", () =>
    frames.push(() => {
      fit.fit();
      ptyRows.push(terminal.rows);
    }),
  );
  const tokens = new Map([
    ["--bb-monokai-active", "1"],
    ["--terminal-font-family", appearance.fontFamily],
    ["--terminal-font-size", "13"],
    ["--terminal-line-height", "1.4"],
    ["--terminal-background", "#141414"],
  ]);
  const documentElement = {};
  let notify: (records: unknown[]) => void = () => {};
  Object.assign(globalThis, {
    document: {
      documentElement,
      head: {},
      body: {},
      fonts,
      querySelectorAll: () => [element],
      addEventListener() {},
      removeEventListener() {},
    },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => tokens.get(name) ?? "" }),
    MutationObserver: class {
      constructor(callback: (records: unknown[]) => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => {},
  });
  return {
    terminal,
    ptyRows,
    frame: () => frames.splice(0).forEach((callback) => callback()),
    selectTheme: (active: boolean) => {
      tokens.set("--bb-monokai-active", active ? "1" : "");
      notify([{ target: documentElement, addedNodes: [], removedNodes: [] }]);
    },
  };
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
    restore?.();
    expect(terminal.options).toEqual(original);
    expect(fit.fit).toHaveBeenCalledTimes(2);
  });

  test("preserves changes made by another theme before cleanup", () => {
    const { terminal, fit } = fixture();
    const restore = applyTerminalAppearance({ terminal, fit: fit.fit }, appearance);
    terminal.options.fontFamily = "new-theme-font";
    terminal.options.theme = { background: "#ffffff", cursorAccent: "#eeeeee", red: "#990000" };
    restore?.();
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

  test("stands down when the host already renders terminal typography tokens", () => {
    const { terminal, fit } = fixture();
    terminal.options.fontFamily = appearance.fontFamily;
    terminal.options.fontSize = appearance.fontSize;
    terminal.options.lineHeight = appearance.lineHeight;
    const original = structuredClone(terminal.options);

    const restore = applyTerminalAppearance({ terminal, fit: fit.fit }, appearance);

    expect(restore).toBeNull();
    expect(fit.fit).not.toHaveBeenCalled();
    expect(terminal.refresh).not.toHaveBeenCalled();
    restore?.();
    expect(terminal.options).toEqual(original);
  });
});

describe("terminal PTY size", () => {
  test("sends the PTY the refit grid when the theme is selected and deselected", () => {
    const page = bbPage();
    mountTerminalAppearance({ signal: new AbortController().signal } as PluginContentScriptContext);
    page.frame(); // The adapter applies 13px / 1.4.
    page.frame(); // bb's fit runs.
    expect(page.terminal.options.fontSize).toBe(13);
    expect(page.ptyRows).toEqual([26]);

    page.selectTheme(false);
    page.frame();
    page.frame();
    expect(page.terminal.options.fontSize).toBe(12);
    expect(page.ptyRows).toEqual([26, 40]);
  });

  test("sends the PTY the host grid when the plugin is disabled", () => {
    const page = bbPage();
    const controller = new AbortController();
    mountTerminalAppearance({ signal: controller.signal } as PluginContentScriptContext);
    page.frame();
    page.frame();

    controller.abort();
    page.frame();
    expect(page.terminal.options.fontSize).toBe(12);
    expect(page.ptyRows).toEqual([26, 40]);
  });
});
