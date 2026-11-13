// The cheatsheet page's content. Each pinned hint label, bb command, and
// scroll key has one row here; the type keys the hint labels to
// RESERVED_CONTROLS, and a test checks every command and scroll key is
// listed, so a new binding cannot ship without its cheatsheet row. Command
// rows show the shortcut bound in the user's bb keyboard settings.

import type { PluginCommandShortcut } from "@get-bb/plugin-sdk/app";
import { VIMIUM_COMMANDS, type VimiumCommand } from "./direct-shortcuts.ts";
import { RESERVED_CONTROLS } from "./hint-labels.ts";

export type CheatsheetEntry =
  | {
      /** Keys pressed in order, each a single key or chord. */
      readonly keys: readonly string[];
      /** The keys are alternatives, one per choice, rather than a sequence. */
      readonly oneOf?: true;
      readonly action: string;
    }
  | {
      /** A vimium bb command, whose keys come from Settings → Keyboard. */
      readonly command: VimiumCommand;
      readonly action: string;
    };

export interface CheatsheetSection {
  readonly title: string;
  readonly note?: string;
  readonly entries: readonly CheatsheetEntry[];
}

type ReservedChar = (typeof RESERVED_CONTROLS)[number]["char"];

/** What each pinned label clicks after `f`, in the order the page lists them. */
const HINT_LABEL_ACTIONS: Readonly<Record<ReservedChar, string>> = {
  i: "Composer input",
  j: "Send",
  m: "Model",
  p: "Project",
  l: "Machine",
  b: "Branch",
  k: "Permission mode",
  a: "Prompt actions",
  v: "Voice input",
  n: "New thread",
  s: "Search threads",
  h: "Home",
  e: "More menu, including Plugins",
  ",": "Settings",
  "[": "Back",
  "]": "Forward",
  q: "Left sidebar",
  "\\": "Right panel",
};

function commandEntries(section: VimiumCommand["section"]): CheatsheetEntry[] {
  return VIMIUM_COMMANDS.filter((command) => command.section === section).map((command) => ({
    command,
    action: command.title,
  }));
}

export const CHEATSHEET: readonly CheatsheetSection[] = [
  {
    title: "Link hints",
    note: "Every clickable element on screen gets a yellow label. Type it to click.",
    entries: [
      ...commandEntries("Link hints"),
      { keys: ["Cmd+Shift+F"], action: "Show hints from anywhere, even the composer" },
      { keys: ["Backspace"], action: "Drop the last typed letter" },
      { keys: ["Escape"], action: "Leave hint mode" },
    ],
  },
  {
    title: "Navigation",
    note: "bb commands. Bind or change their keys in Settings → Keyboard.",
    entries: commandEntries("Navigation"),
  },
  {
    title: "Composer",
    note: "bb commands. Bind or change their keys in Settings → Keyboard.",
    entries: commandEntries("Composer"),
  },
  {
    title: "Escape shortcuts",
    note: "Press Escape, then the key within 1.5 seconds. Works from the composer too.",
    entries: [
      { keys: ["Escape", "a"], action: "Open Agentation feedback mode" },
      { keys: ["Escape", "m"], action: "Toggle Claude/Codex: Astra ↔ Fable, Sol ↔ Opus" },
      { keys: ["Escape", "r"], action: "Cycle reasoning forward" },
      { keys: ["Escape", ";"], action: "Cycle Normal / Fast / Ultrafast (supported speeds)" },
    ],
  },
  {
    title: "Scrolling",
    note: "Hold a key to keep scrolling.",
    entries: [
      { keys: ["j"], action: "Scroll the conversation down" },
      { keys: ["k"], action: "Scroll the conversation up" },
      { keys: ["J"], action: "Jump to the bottom" },
    ],
  },
  {
    title: "Pinned hint labels",
    note: "Press f, then a label. These labels never move; everything else gets two letters.",
    entries: [
      ...Object.entries(HINT_LABEL_ACTIONS).map(([char, action]) => ({ keys: [char], action })),
      { keys: ["1–0"], action: "Sidebar threads, top to bottom" },
    ],
  },
  {
    title: "Dropdowns",
    note: "Branch, permission mode, and other menus label their choices. Project, machine, and model pickers keep their own search.",
    entries: [
      { keys: ["a", "s", "d", "f", "g", "h"], action: "Permission modes", oneOf: true },
      { keys: ["1", "2", "3"], action: "Reasoning levels, after picking a model", oneOf: true },
      { keys: ["f", "j", "d", "k"], action: "Other choices, in order", oneOf: true },
    ],
  },
];

export type KeybindingPlatform = "mac" | "windows" | "linux";

/** One saved Settings → Keyboard override, as `sdk.system.config()` returns it. */
export interface KeybindingOverride {
  readonly command: string;
  readonly platform?: KeybindingPlatform;
  readonly shortcut: Required<PluginCommandShortcut> | null;
}

/** bb's platform detection for keybindings, from `navigator.platform`. */
export function keybindingPlatform(platform: string): KeybindingPlatform {
  if (/Mac|iPhone|iPad|iPod|darwin/u.test(platform)) return "mac";
  if (/Win/u.test(platform)) return "windows";
  return "linux";
}

/**
 * The shortcut bb dispatches for a vimium command: a platform-scoped binding,
 * then an unscoped one. Null when unbound, since the commands have no default.
 */
export function boundShortcut(
  commandId: string,
  overrides: readonly KeybindingOverride[],
  platform: KeybindingPlatform,
): PluginCommandShortcut | null {
  const override =
    overrides.find((entry) => entry.command === commandId && entry.platform === platform) ??
    overrides.find((entry) => entry.command === commandId && entry.platform === undefined);
  return override?.shortcut ?? null;
}

// bb stores a shifted symbol as its unshifted key plus Shift.
const SHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
};

/**
 * A shortcut as the cheatsheet's `+`-joined key label. A lone Shift folds into
 * the key it produces, so Shift+e reads `E` and Shift+/ reads `?`.
 */
export function shortcutLabel(shortcut: PluginCommandShortcut, mac: boolean): string {
  const parts = modifierNames(shortcut, mac);
  if (parts.length === 1 && shortcut.shift) {
    const typed = shiftedCharacter(shortcut.key);
    if (typed !== undefined) return typed;
  }
  // A bare letter reads as typed; in a chord it reads like a key cap.
  parts.push(parts.length === 0 ? shortcut.key : shortcut.key.toUpperCase());
  return parts.join("+");
}

function modifierNames(shortcut: PluginCommandShortcut, mac: boolean): string[] {
  const names: string[] = [];
  if (shortcut.control || (shortcut.mod && !mac)) names.push("Ctrl");
  if (shortcut.meta || (shortcut.mod && mac)) names.push(mac ? "Cmd" : "Meta");
  if (shortcut.alt) names.push(mac ? "Option" : "Alt");
  if (shortcut.shift) names.push("Shift");
  return names;
}

/** The character Shift plus `key` types, or undefined for a non-character key. */
function shiftedCharacter(key: string): string | undefined {
  return /^[a-z]$/iu.test(key) ? key.toUpperCase() : SHIFTED_SYMBOLS[key];
}
