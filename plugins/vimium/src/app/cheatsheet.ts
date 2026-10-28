// The cheatsheet page's content. Each pinned hint label and direct key has
// one description here; the type keys the hint labels to RESERVED_CONTROLS,
// and a test checks every direct key is listed, so a new binding cannot ship
// without its cheatsheet row.

import { RESERVED_CONTROLS } from "./hint-labels.ts";

export interface CheatsheetEntry {
  /** Keys pressed in order, each a single key or chord. */
  readonly keys: readonly string[];
  /** The keys are alternatives, one per choice, rather than a sequence. */
  readonly oneOf?: true;
  readonly action: string;
}

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

export const CHEATSHEET: readonly CheatsheetSection[] = [
  {
    title: "Link hints",
    note: "Every clickable element on screen gets a yellow label. Type it to click.",
    entries: [
      { keys: ["f"], action: "Show hints" },
      { keys: ["Cmd+Shift+F"], action: "Show hints from anywhere, even the composer" },
      { keys: ["Backspace"], action: "Drop the last typed letter" },
      { keys: ["Escape"], action: "Leave hint mode" },
    ],
  },
  {
    title: "Navigation",
    entries: [
      { keys: ["n"], action: "New thread" },
      { keys: ["h"], action: "Home" },
      { keys: ["s"], action: "Search threads" },
      { keys: [","], action: "Settings" },
      { keys: ["]"], action: "Next thread" },
      { keys: ["["], action: "Previous thread" },
      { keys: ["e"], action: "Settle the focused thread" },
      { keys: ["E"], action: "Undo the latest archive" },
      { keys: ["?"], action: "Open this cheatsheet" },
    ],
  },
  {
    title: "Composer",
    entries: [
      { keys: ["i"], action: "Focus the composer" },
      { keys: ["m"], action: "Model" },
      { keys: ["p"], action: "Project" },
      { keys: ["l"], action: "Machine" },
      { keys: ["b"], action: "Branch" },
      { keys: ["a"], action: "Permission mode" },
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
