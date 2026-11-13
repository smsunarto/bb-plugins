// Stands in for bb's keyboard dispatcher, bound the way the README tells users
// to bind vimium's commands. Importing it loads the plugin app, takes the
// commands app.tsx registered, and adds bb's bubbling window keydown listener,
// so a test presses a key and the plugin's own registration handles it. Import
// it after ./dom.ts.

import type { PluginCommandRegistration, PluginCommandShortcut } from "@get-bb/plugin-sdk/app";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

/** The README's single-key bindings, by command id. */
export const README_BINDINGS: Readonly<Record<string, PluginCommandShortcut>> = {
  "new-thread": { key: "n" },
  home: { key: "h" },
  "search-threads": { key: "s" },
  settings: { key: "," },
  "next-thread": { key: "]" },
  "previous-thread": { key: "[" },
  "settle-thread": { key: "e" },
  "undo-archive": { key: "e", shift: true },
  cheatsheet: { key: "/", shift: true },
  "focus-composer": { key: "i" },
  model: { key: "m" },
  project: { key: "p" },
  machine: { key: "l" },
  branch: { key: "b" },
  "permission-mode": { key: "a" },
};

// bb's normalization: a shifted symbol matches its unshifted key plus Shift.
const UNSHIFTED: Readonly<Record<string, string>> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

function matches(event: KeyboardEvent, shortcut: PluginCommandShortcut): boolean {
  const key = event.shiftKey ? (UNSHIFTED[event.key] ?? event.key) : event.key;
  return (
    key.toLowerCase() === shortcut.key.toLowerCase() &&
    event.metaKey === Boolean(shortcut.meta) &&
    event.ctrlKey === Boolean(shortcut.control || shortcut.mod) &&
    event.altKey === Boolean(shortcut.alt) &&
    event.shiftKey === Boolean(shortcut.shift)
  );
}

const app = (await loadPluginApp(() => import("../../src/app/app.tsx"))) as unknown as {
  commandPaletteActions: ReadonlyArray<PluginCommandRegistration & { target: string }>;
};
const commands = app.commandPaletteActions.filter((command) => command.target === "app");

/** The vimium commands app.tsx registered, by id. */
export const registeredCommandIds: readonly string[] = commands.map((command) => command.id);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  const command = commands.find((candidate) => {
    const shortcut = README_BINDINGS[candidate.id];
    return shortcut !== undefined && matches(event, shortcut);
  });
  if (command === undefined) return;
  const context = { threadId: null, projectId: null } as never;
  if (command.isAvailable && !command.isAvailable(context)) return;
  void command.run(context);
  event.preventDefault();
  event.stopPropagation();
});
