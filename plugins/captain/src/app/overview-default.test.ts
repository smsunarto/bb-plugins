import type { ExperimentalPanelTab, ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";
import { expect, test } from "vitest";
import { decideFirstOpen } from "./overview-default.ts";

const info: ExperimentalPanelTab = {
  key: "info",
  title: "Info",
  status: null,
  closable: false,
  detail: { kind: "info" },
};
const newTab: ExperimentalPanelTab = {
  key: "new-1",
  title: "New tab",
  status: null,
  closable: true,
  detail: { kind: "new-tab" },
};
const plugin = (pluginId: string, id: string): ExperimentalPanelTab => ({
  key: `${pluginId}:${id}`,
  title: id,
  status: null,
  closable: false,
  detail: {
    kind: "plugin",
    pluginId,
    tab: { id, context: { kind: "thread" }, availability: "fixed" },
    params: null,
  },
});
const overview = plugin("captain", "overview");
const changes = plugin("source-control", "changes");

const panel = (
  open: boolean,
  selectedKey: string | null,
  tabs: ExperimentalPanelTab[] = [info, overview, changes],
): ExperimentalPanelTabs => ({ open, selectedKey, tabs });

const closed = { open: false };

test("a first open onto bb's Info fallback selects Overview", () => {
  expect(decideFirstOpen("captain", closed, panel(true, "info"), false)).toEqual({
    kind: "select",
    overviewKey: "captain:overview",
  });
});

test("a first open onto a New tab page selects Overview", () => {
  const tabs = [info, overview, changes, newTab];
  expect(decideFirstOpen("captain", closed, panel(true, "new-1", tabs), false)).toEqual({
    kind: "select",
    overviewKey: "captain:overview",
  });
});

test("Overview not in the strip yet is opened by reference", () => {
  expect(decideFirstOpen("captain", closed, panel(true, "info", [info]), false)).toEqual({
    kind: "select",
    overviewKey: null,
  });
});

test("a remembered pick that is not bb's fallback is kept", () => {
  expect(decideFirstOpen("captain", closed, panel(true, "source-control:changes"), false)).toEqual({
    kind: "keep",
  });
});

test("once handled, later opens are bb's own", () => {
  expect(decideFirstOpen("captain", closed, panel(true, "info"), true)).toEqual({ kind: "none" });
});

test("the first observation of a thread is a baseline, even with the panel open", () => {
  expect(decideFirstOpen("captain", null, panel(true, "info"), false)).toEqual({ kind: "none" });
});

test("nothing happens while the panel stays closed or stays open", () => {
  expect(decideFirstOpen("captain", closed, panel(false, null), false)).toEqual({ kind: "none" });
  expect(decideFirstOpen("captain", { open: true }, panel(true, "info"), false)).toEqual({
    kind: "none",
  });
});

test("another plugin's tab named overview is not Captain's", () => {
  const other = plugin("someone-else", "overview");
  expect(decideFirstOpen("captain", closed, panel(true, "info", [info, other]), false)).toEqual({
    kind: "select",
    overviewKey: null,
  });
});
