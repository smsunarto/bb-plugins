import { describe, expect, it } from "vitest";
import { cycleValue, matchModelShortcut, modelShortcutBindings } from "./model-shortcuts";

const when = (all: string[] = [], none: string[] = []) =>
  ({ all: ["mainSurface", "promptAvailable", ...all], none }) as never;
const shortcut = (
  key: string,
  mods: Partial<Record<"mod" | "meta" | "control" | "alt" | "shift", boolean>> = {},
) => ({
  key,
  mod: false,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
});
const key = (
  k: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  code = "",
) => ({ key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

// The shape `system.config().keybindings` returns, as `bb settings keyboard list` shows it.
const keybindings = [
  {
    command: "composer.focus",
    desktopOnly: false,
    shortcut: shortcut("c", { mod: true, shift: true }),
    when: when(),
  },
  {
    command: "modelPicker.cycleModel",
    desktopOnly: false,
    shortcut: shortcut("m", { alt: true }),
    when: when(),
  },
  {
    command: "modelPicker.cycleProvider",
    desktopOnly: false,
    shortcut: shortcut("ArrowRight", { mod: true, alt: true }),
    when: when(),
  },
  {
    command: "modelPicker.cycleReasoning",
    desktopOnly: false,
    shortcut: shortcut("F10"),
    when: when(["macPlatform"]),
  },
  {
    command: "modelPicker.cycleReasoning",
    desktopOnly: false,
    shortcut: shortcut("ArrowUp", { mod: true, alt: true }),
    when: when(["linuxPlatform"]),
  },
  // While BB's picker is open; T3's picker handles its own keys.
  {
    command: "modelPicker.cycleModel",
    desktopOnly: false,
    shortcut: shortcut("m", { alt: true }),
    when: { all: ["mainSurface", "modelPickerOpen"], none: [] },
  },
] as never;

describe("modelShortcutBindings", () => {
  it("keeps the cycle commands for this platform while the picker is closed", () => {
    expect(
      modelShortcutBindings(keybindings, "linux").map((b) => [b.command, b.shortcut.key]),
    ).toEqual([
      ["modelPicker.cycleModel", "m"],
      ["modelPicker.cycleProvider", "ArrowRight"],
      ["modelPicker.cycleReasoning", "ArrowUp"],
    ]);
    expect(modelShortcutBindings(keybindings, "mac").at(-1)?.shortcut.key).toBe("F10");
  });
});

describe("matchModelShortcut", () => {
  const linux = modelShortcutBindings(keybindings, "linux");
  const mac = modelShortcutBindings(keybindings, "mac");

  it("reads Mod as Control off macOS and Command on macOS", () => {
    expect(
      matchModelShortcut(key("ArrowRight", { ctrlKey: true, altKey: true }), linux, "linux"),
    ).toBe("modelPicker.cycleProvider");
    expect(
      matchModelShortcut(key("ArrowRight", { metaKey: true, altKey: true }), linux, "linux"),
    ).toBeNull();
    expect(matchModelShortcut(key("ArrowRight", { metaKey: true, altKey: true }), mac, "mac")).toBe(
      "modelPicker.cycleProvider",
    );
  });

  it("reads an Option letter from its physical key, as macOS types µ for Option+M", () => {
    expect(matchModelShortcut(key("µ", { altKey: true }, "KeyM"), mac, "mac")).toBe(
      "modelPicker.cycleModel",
    );
  });

  it("requires the exact modifiers", () => {
    expect(
      matchModelShortcut(key("m", { altKey: true, shiftKey: true }, "KeyM"), linux, "linux"),
    ).toBeNull();
    expect(matchModelShortcut(key("m"), linux, "linux")).toBeNull();
  });
});

describe("cycleValue", () => {
  it("wraps in both directions", () => {
    expect(cycleValue(["a", "b", "c"], "c", false)).toBe("a");
    expect(cycleValue(["a", "b", "c"], "a", true)).toBe("c");
    expect(cycleValue(["a", "b", "c"], "b", false)).toBe("c");
  });

  it("starts at the first value when the current one is not listed", () => {
    expect(cycleValue(["a", "b"], "z", false)).toBe("a");
  });

  it("has nothing to move to with one value or none", () => {
    expect(cycleValue(["a"], "a", false)).toBeNull();
    expect(cycleValue([], undefined, false)).toBeNull();
  });
});
