import { expect, test } from "bun:test";
import type { ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";

import { matchesKeyShortcut, panelOpenRedirect } from "../app/panel-new-tab.ts";

const info = {
  key: "thread-info",
  title: "Info",
  status: null,
  closable: false,
  detail: { kind: "info" },
} as const;
const file = {
  key: "file:a.ts",
  title: "a.ts",
  status: null,
  closable: true,
  detail: { kind: "file", path: "a.ts" },
} as const;
const newTab = {
  key: "new-tab",
  title: "New tab",
  status: null,
  closable: true,
  detail: { kind: "new-tab" },
} as const;

function panel(
  open: boolean,
  selectedKey: string | null,
  tabs: ExperimentalPanelTabs["tabs"],
): ExperimentalPanelTabs {
  return { open, selectedKey, tabs };
}

test("a toggle that restores the last tab selects the open new tab", () => {
  const closed = panel(false, file.key, [info, file, newTab]);
  const opened = panel(true, file.key, [info, file, newTab]);
  expect(panelOpenRedirect(closed, opened)).toEqual({ kind: "select", key: "new-tab" });
});

test("a toggle that falls back to Info creates a new tab", () => {
  const closed = panel(false, null, [info]);
  const opened = panel(true, info.key, [info]);
  expect(panelOpenRedirect(closed, opened)).toEqual({ kind: "create" });
});

test("an open aimed at another tab is left alone", () => {
  const closed = panel(false, info.key, [info, file]);
  const opened = panel(true, file.key, [info, file]);
  expect(panelOpenRedirect(closed, opened)).toEqual({ kind: "none" });
});

test("an open that already shows the new tab is left alone", () => {
  const closed = panel(false, newTab.key, [info, newTab]);
  const opened = panel(true, newTab.key, [info, newTab]);
  expect(panelOpenRedirect(closed, opened)).toEqual({ kind: "none" });
});

test("bb's empty list before the panel mounts is not a toggle", () => {
  const empty = panel(false, null, []);
  const opened = panel(true, file.key, [info, file]);
  expect(panelOpenRedirect(empty, opened)).toEqual({ kind: "none" });
});

test("changes while open or closed do nothing", () => {
  expect(
    panelOpenRedirect(panel(true, info.key, [info]), panel(true, file.key, [info, file])),
  ).toEqual({ kind: "none" });
  expect(panelOpenRedirect(panel(true, info.key, [info]), panel(false, info.key, [info]))).toEqual({
    kind: "none",
  });
  expect(panelOpenRedirect(null, panel(true, info.key, [info]))).toEqual({ kind: "none" });
});

const key = (
  init: Partial<
    Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">
  >,
) => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

test("matches bb's toggle shortcut by key or code, with exact modifiers", () => {
  const ctrlBackslash = key({ key: "\\", code: "Backslash", ctrlKey: true });
  expect(matchesKeyShortcut(ctrlBackslash, "Control+\\")).toBe(true);
  expect(matchesKeyShortcut(ctrlBackslash, "Control+Backslash")).toBe(true);
  expect(matchesKeyShortcut({ ...ctrlBackslash, shiftKey: true }, "Control+\\")).toBe(false);
  expect(matchesKeyShortcut(ctrlBackslash, "Meta+\\")).toBe(false);
  expect(
    matchesKeyShortcut(
      key({ key: "B", code: "KeyB", metaKey: true, shiftKey: true }),
      "Meta+Shift+B",
    ),
  ).toBe(true);
  expect(matchesKeyShortcut(ctrlBackslash, "Meta+\\ Control+\\")).toBe(true);
});
