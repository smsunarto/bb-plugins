import { describe, expect, test } from "bun:test";
import {
  CHEATSHEET,
  boundShortcut,
  keybindingPlatform,
  shortcutLabel,
  type KeybindingOverride,
} from "./cheatsheet.ts";
import { SCROLL_SHORTCUTS, VIMIUM_COMMANDS } from "./direct-shortcuts.ts";
import { RESERVED_CONTROLS } from "./hint-labels.ts";

function entriesIn(titles: readonly string[]) {
  return CHEATSHEET.filter((section) => titles.includes(section.title)).flatMap(
    (section) => section.entries,
  );
}

const NONE = { mod: false, meta: false, control: false, alt: false, shift: false };

describe("cheatsheet", () => {
  test("lists every command exactly once", () => {
    const listed = entriesIn(["Link hints", "Navigation", "Composer"]).flatMap((entry) =>
      "command" in entry ? [entry.command.id] : [],
    );
    expect([...listed].sort()).toEqual(VIMIUM_COMMANDS.map((command) => command.id).sort());
  });

  test("lists every scroll key exactly once", () => {
    const listed = entriesIn(["Scrolling"]).flatMap((entry) => ("keys" in entry ? entry.keys : []));
    expect([...listed].sort()).toEqual([...SCROLL_SHORTCUTS.keys()].sort());
  });

  test("lists every pinned hint label", () => {
    const listed = entriesIn(["Pinned hint labels"]).flatMap((entry) =>
      "keys" in entry ? entry.keys : [],
    );
    for (const { char } of RESERVED_CONTROLS) expect(listed).toContain(char);
  });
});

describe("boundShortcut", () => {
  const id = "plugin:vimium/new-thread";
  const n = { ...NONE, key: "n" };
  const t = { ...NONE, key: "t" };

  test("a platform binding beats an unscoped one", () => {
    const overrides: KeybindingOverride[] = [
      { command: id, shortcut: n },
      { command: id, platform: "mac", shortcut: t },
    ];
    expect(boundShortcut(id, overrides, "mac")).toEqual(t);
    expect(boundShortcut(id, overrides, "linux")).toEqual(n);
  });

  test("a command with no binding, or a cleared one, is unbound", () => {
    expect(boundShortcut(id, [], "linux")).toBeNull();
    expect(boundShortcut(id, [{ command: id, shortcut: null }], "linux")).toBeNull();
    expect(boundShortcut(id, [{ command: "plugin:vimium/home", shortcut: n }], "linux")).toBeNull();
  });
});

describe("shortcutLabel", () => {
  test("a bare key reads as typed, and a lone Shift folds into its character", () => {
    expect(shortcutLabel({ key: "n" }, false)).toBe("n");
    expect(shortcutLabel({ key: "e", shift: true }, false)).toBe("E");
    expect(shortcutLabel({ key: "/", shift: true }, false)).toBe("?");
    expect(shortcutLabel({ key: "]" }, false)).toBe("]");
  });

  test("chords name their modifiers for the platform", () => {
    expect(shortcutLabel({ key: "k", mod: true }, true)).toBe("Cmd+K");
    expect(shortcutLabel({ key: "k", mod: true }, false)).toBe("Ctrl+K");
    expect(shortcutLabel({ key: "e", alt: true, shift: true }, true)).toBe("Option+Shift+E");
    expect(shortcutLabel({ key: "F2" }, false)).toBe("F2");
  });
});

describe("keybindingPlatform", () => {
  test("reads bb's three platforms", () => {
    expect(keybindingPlatform("MacIntel")).toBe("mac");
    expect(keybindingPlatform("Win32")).toBe("windows");
    expect(keybindingPlatform("Linux x86_64")).toBe("linux");
  });
});
