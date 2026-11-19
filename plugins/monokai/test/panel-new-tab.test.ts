import { afterEach, expect, test } from "bun:test";
import type { ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";
import { installDom } from "@bb-plugins/testing";

import {
  matchesKeyShortcut,
  mountPanelNewTab,
  panelOpenRedirect,
  pressPanelNewTab,
} from "../app/panel-new-tab.ts";

installDom();

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

// bb's DOM around the new-tab button: the desktop panel, or the phone shelf.
const DESKTOP_PANEL = '<div id="thread-detail-secondary-panel"></div>';
const PHONE_SHELF = '<div data-testid="secondary-panel-shelf"></div>';

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

/** Mounts the content script and returns the presses each new-tab button gets. */
function mountWith(html: string) {
  document.body.innerHTML = html;
  // jsdom only accepts its own AbortSignal.
  const controller = new window.AbortController();
  const disposer = mountPanelNewTab({ signal: controller.signal, document });
  dispose = () => {
    controller.abort();
    void disposer();
  };
  const presses: string[] = [];
  document.addEventListener("click", (event) => {
    const button = (event.target as Element).closest("button[data-panel-new-tab]");
    if (button)
      presses.push(button.parentElement?.id || button.parentElement?.dataset["testid"] || "page");
  });
  return presses;
}

function addNewTabButton(container: string) {
  const button = document.createElement("button");
  button.setAttribute("data-panel-new-tab", "");
  document.querySelector(container)!.append(button);
}

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(count);
  });

test("presses the new-tab button in the desktop panel", () => {
  const presses = mountWith(DESKTOP_PANEL);
  addNewTabButton("#thread-detail-secondary-panel");
  pressPanelNewTab(() => false);
  expect(presses).toEqual(["thread-detail-secondary-panel"]);
});

test("presses the new-tab button in the phone shelf", () => {
  const presses = mountWith(PHONE_SHELF);
  addNewTabButton('[data-testid="secondary-panel-shelf"]');
  pressPanelNewTab(() => false);
  expect(presses).toEqual(["secondary-panel-shelf"]);
});

test("waits a few frames for the button to mount", async () => {
  const presses = mountWith(PHONE_SHELF);
  pressPanelNewTab(() => false);
  await frames(2);
  addNewTabButton('[data-testid="secondary-panel-shelf"]');
  await frames(2);
  expect(presses).toEqual(["secondary-panel-shelf"]);
});

test("presses nothing outside the panel or when the button is ambiguous", async () => {
  const presses = mountWith(`${DESKTOP_PANEL}${PHONE_SHELF}<div id="page"></div>`);
  addNewTabButton("#page");
  pressPanelNewTab(() => false);
  addNewTabButton("#thread-detail-secondary-panel");
  addNewTabButton('[data-testid="secondary-panel-shelf"]');
  await frames(8);
  expect(presses).toEqual([]);
});

test("a cancelled or disposed press waiting for the button never lands", async () => {
  const presses = mountWith(PHONE_SHELF);
  let cancelled = false;
  pressPanelNewTab(() => cancelled);
  cancelled = true;
  addNewTabButton('[data-testid="secondary-panel-shelf"]');
  await frames(2);
  pressPanelNewTab(() => false);
  expect(presses).toEqual(["secondary-panel-shelf"]);

  presses.length = 0;
  dispose?.();
  dispose = null;
  pressPanelNewTab(() => false);
  expect(presses).toEqual([]);
});
