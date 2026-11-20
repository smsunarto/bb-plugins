import type { ExperimentalPanelTab, ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";
import { describe, expect, test } from "vitest";
import { classifyOpen, observe, SETTLE_MS, type Watch } from "./overview-default.ts";

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
const readme: ExperimentalPanelTab = {
  key: "file:README.md",
  title: "README.md",
  status: null,
  closable: true,
  detail: { kind: "file", path: "README.md" } as never,
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
const STRIP = [info, overview, changes, newTab, readme];

const panel = (open: boolean, selectedKey: string | null, tabs = STRIP): ExperimentalPanelTabs => ({
  open,
  selectedKey,
  tabs,
});

/** The panel as last seen: closed on `selectedKey`, which bb 0.50 keeps reporting while closed. */
const seen = (selectedKey: string | null, extra: Partial<Watch> = {}): Watch => ({
  threadId: "t1",
  open: false,
  selectedKey,
  lastOpenKey: selectedKey,
  pending: null,
  ...extra,
});

const selectOverview = { kind: "select", overviewKey: "captain:overview" };
const none = { kind: "none" };

/** A run of observations on thread t1, one millisecond apart unless `at` says otherwise. */
function steps(
  start: Watch | null,
  frames: { tabs: ExperimentalPanelTabs; isCaptain?: boolean | null; at?: number }[],
) {
  let watch = start;
  let clock = 0;
  return frames.map((frame) => {
    clock = frame.at ?? clock + 1;
    const step = observe(
      "captain",
      watch,
      "t1",
      frame.tabs,
      frame.isCaptain === undefined ? true : frame.isCaptain,
      clock,
    );
    watch = step.watch;
    return step;
  });
}
const actions = (run: ReturnType<typeof steps>) => run.map((step) => step.action);

describe("classifyOpen", () => {
  test("an open onto bb's Info or New tab is generic", () => {
    expect(classifyOpen(seen("source-control:changes"), panel(true, "info"))).toBe("generic");
    expect(classifyOpen(seen("source-control:changes"), panel(true, "new-1"))).toBe("generic");
  });

  test("an open on the tab selected before is a restore, decided by what bb does next", () => {
    expect(
      classifyOpen(seen("source-control:changes"), panel(true, "source-control:changes")),
    ).toBe("restored");
    const blank = seen(null, { lastOpenKey: "source-control:changes" });
    expect(classifyOpen(blank, panel(true, "source-control:changes"))).toBe("restored");
  });

  test("an open onto another tab is explicit", () => {
    expect(classifyOpen(seen("info"), panel(true, readme.key))).toBe("explicit");
    expect(classifyOpen(seen("captain:overview"), panel(true, "source-control:changes"))).toBe(
      "explicit",
    );
  });

  test("the first observation is a baseline, and a panel that stays open or closed is no open", () => {
    expect(classifyOpen(null, panel(true, "info"))).toBe("none");
    expect(classifyOpen(seen("info", { open: true }), panel(true, "info"))).toBe("none");
    expect(classifyOpen(seen("info"), panel(false, "info"))).toBe("none");
  });
});

describe("a toggle on a Captain thread lands on Overview", () => {
  test("onto Info: selected at once", () => {
    expect(actions(steps(seen("info"), [{ tabs: panel(true, "info") }]))).toEqual([selectOverview]);
  });

  test("reopening on the last tab: selected when bb moves to New tab", () => {
    const run = steps(seen("source-control:changes"), [
      { tabs: panel(true, "source-control:changes") },
      { tabs: panel(true, "new-1") },
    ]);
    expect(actions(run)).toEqual([none, selectOverview]);
  });

  test("reopening on Overview: kept there through bb's move to New tab", () => {
    const run = steps(seen("captain:overview"), [
      { tabs: panel(true, "captain:overview") },
      { tabs: panel(true, "new-1") },
    ]);
    expect(actions(run)).toEqual([none, selectOverview]);
  });

  test("bb's move after Overview was selected is caught too", () => {
    const run = steps(seen("info"), [
      { tabs: panel(true, "info") },
      { tabs: panel(true, "captain:overview") },
      { tabs: panel(true, "new-1") },
    ]);
    expect(actions(run)).toEqual([selectOverview, none, selectOverview]);
  });

  test("Overview not in the strip yet is opened by reference", () => {
    const run = steps(seen("info"), [{ tabs: panel(true, "info", [info]) }]);
    expect(actions(run)).toEqual([{ kind: "select", overviewKey: null }]);
  });

  test("another plugin's tab named overview is not Captain's", () => {
    const other = plugin("someone-else", "overview");
    const run = steps(seen("info"), [{ tabs: panel(true, "info", [info, other]) }]);
    expect(actions(run)).toEqual([{ kind: "select", overviewKey: null }]);
  });
});

describe("an explicit destination keeps its tab", () => {
  test("a file link opening the panel onto its file", () => {
    expect(actions(steps(seen("info"), [{ tabs: panel(true, readme.key) }]))).toEqual([none]);
  });

  test("the same file link again, when the file was the last tab", () => {
    const run = steps(seen(readme.key), [
      { tabs: panel(true, readme.key) },
      { tabs: panel(true, readme.key), at: SETTLE_MS + 10 },
    ]);
    expect(actions(run)).toEqual([none, none]);
    expect(run[1]?.watch.pending).toBeNull();
  });

  test("a New tab the user opens after the open settled", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, changes.key) },
      { tabs: panel(true, "new-1"), at: SETTLE_MS + 10 },
    ]);
    expect(actions(run)).toEqual([none, none]);
  });

  test("a tab the user picks while the panel is open", () => {
    const run = steps(seen("info"), [
      { tabs: panel(true, "info") },
      { tabs: panel(true, "captain:overview") },
      { tabs: panel(true, changes.key) },
      { tabs: panel(true, "new-1") },
    ]);
    expect(actions(run)).toEqual([selectOverview, none, none, none]);
  });
});

test("a thread bb has not named a Captain's never moves", () => {
  const run = steps(seen("info"), [{ tabs: panel(true, "info"), isCaptain: false }]);
  expect(actions(run)).toEqual([none]);
  expect(run[0]?.watch.pending).toBeNull();
});

describe("an open before bb says whether this is a Captain thread", () => {
  test("waits, then selects Overview once the thread turns out a Captain's", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, changes.key), isCaptain: null },
      { tabs: panel(true, "new-1"), isCaptain: null },
      { tabs: panel(true, "new-1"), isCaptain: true, at: 5_000 },
    ]);
    expect(actions(run)).toEqual([none, none, selectOverview]);
  });

  test("a waiting toggle onto Info applies however late the answer comes", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, "info"), isCaptain: null },
      { tabs: panel(true, "info"), isCaptain: true, at: 60_000 },
    ]);
    expect(actions(run)).toEqual([none, selectOverview]);
  });

  test("is dropped when the user picks another tab meanwhile", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, "info"), isCaptain: null },
      { tabs: panel(true, readme.key), isCaptain: null },
      { tabs: panel(true, readme.key), isCaptain: true },
    ]);
    expect(actions(run)).toEqual([none, none, none]);
  });

  test("is dropped when the user picks Info meanwhile, though Info is bb's own tab", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, "new-1"), isCaptain: null },
      { tabs: panel(true, "info"), isCaptain: null },
      { tabs: panel(true, "info"), isCaptain: true },
    ]);
    expect(actions(run)).toEqual([none, none, none]);
  });

  test("is dropped when the user goes back to the Info tab the open first showed", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, "info"), isCaptain: null },
      { tabs: panel(true, "new-1"), isCaptain: null },
      { tabs: panel(true, "info"), isCaptain: null },
      { tabs: panel(true, "info"), isCaptain: true },
    ]);
    expect(actions(run)).toEqual([none, none, none, none]);
  });

  test("is dropped when the panel closes meanwhile", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, "info"), isCaptain: null },
      { tabs: panel(false, "info"), isCaptain: null },
      { tabs: panel(false, "info"), isCaptain: true },
    ]);
    expect(actions(run)).toEqual([none, none, none]);
  });

  test("is dropped when the thread is not a Captain's", () => {
    const run = steps(seen(changes.key), [
      { tabs: panel(true, "info"), isCaptain: null },
      { tabs: panel(true, "info"), isCaptain: false },
    ]);
    expect(run[1]?.watch.pending).toBeNull();
  });

  test("an explicit open waits for nothing", () => {
    const run = steps(seen("info"), [{ tabs: panel(true, readme.key), isCaptain: null }]);
    expect(run[0]?.watch.pending).toBeNull();
  });
});

test("a switch to another thread starts over from a baseline", () => {
  const [first] = steps(seen(changes.key), [{ tabs: panel(true, "info"), isCaptain: null }]);
  const other = observe("captain", first?.watch ?? null, "t2", panel(true, "info"), true, 2);
  expect(other.action).toEqual(none);
  expect(other.watch).toMatchObject({ threadId: "t2", pending: null });
});
