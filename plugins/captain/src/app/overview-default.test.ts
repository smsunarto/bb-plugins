import type { ExperimentalPanelTab, ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";
import { expect, test } from "vitest";
import { decideOnOpen } from "./overview-default.ts";

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
const selectOverview = { kind: "select", overviewKey: "captain:overview" };

test("an open onto bb's Info tab selects Overview", () => {
  expect(decideOnOpen("captain", closed, panel(true, "info"))).toEqual(selectOverview);
});

test("an open onto a New tab page selects Overview", () => {
  const tabs = [info, overview, changes, newTab];
  expect(decideOnOpen("captain", closed, panel(true, "new-1", tabs))).toEqual(selectOverview);
});

test("an open onto a remembered pick still selects Overview", () => {
  expect(decideOnOpen("captain", closed, panel(true, "source-control:changes"))).toEqual(
    selectOverview,
  );
});

test("every open selects Overview, not only the first", () => {
  const first = decideOnOpen("captain", closed, panel(true, "info"));
  const again = decideOnOpen("captain", closed, panel(true, "new-1", [info, overview, newTab]));
  expect([first, again]).toEqual([selectOverview, selectOverview]);
});

test("an open onto Overview needs nothing", () => {
  expect(decideOnOpen("captain", closed, panel(true, "captain:overview"))).toEqual({
    kind: "none",
  });
});

test("Overview not in the strip yet is opened by reference", () => {
  expect(decideOnOpen("captain", closed, panel(true, "info", [info]))).toEqual({
    kind: "select",
    overviewKey: null,
  });
});

test("the first observation of a thread is a baseline, even with the panel open", () => {
  expect(decideOnOpen("captain", null, panel(true, "info"))).toEqual({ kind: "none" });
});

test("nothing happens while the panel stays closed or stays open", () => {
  expect(decideOnOpen("captain", closed, panel(false, null))).toEqual({ kind: "none" });
  // A tab picked while the panel is open stays.
  expect(decideOnOpen("captain", { open: true }, panel(true, "source-control:changes"))).toEqual({
    kind: "none",
  });
});

test("another plugin's tab named overview is not Captain's", () => {
  const other = plugin("someone-else", "overview");
  expect(decideOnOpen("captain", closed, panel(true, "info", [info, other]))).toEqual({
    kind: "select",
    overviewKey: null,
  });
});
