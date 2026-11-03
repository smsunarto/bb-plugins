import { describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import type { GtdListActions } from "./gtd-actions.ts";

installTestPluginRuntime();
const { settleThreadAction, snoozeThreadAction, unsettleThreadAction, wakeThreadAction } =
  await import("./gtd-actions.ts");

function target(id: string, archivedAt: number | null = null): PluginThreadActionTarget {
  return {
    id,
    projectId: "proj_a",
    parentThreadId: null,
    parentNotifications: "auto",
    archivedAt,
    pinnedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle",
    environment: null,
  };
}

function listActions(): GtdListActions {
  return {
    shelfOf: new Map([
      ["root", "nextAction"],
      ["child", "nextAction"],
      ["busy", "waiting"],
      ["parked", "snoozed"],
      ["done", "settled"],
    ]),
    rootOf: new Map([
      ["root", "root"],
      ["child", "root"],
      ["busy", "busy"],
      ["parked", "parked"],
      ["done", "done"],
    ]),
    parkableRoots: new Set(["root", "parked", "done"]),
    settle: vi.fn(),
    unsettle: vi.fn(),
    snooze: vi.fn(),
    wake: vi.fn(),
  };
}

function item(
  action: typeof settleThreadAction,
  thread: PluginThreadActionTarget,
  data: GtdListActions | null,
) {
  return action.item({
    thread,
    data,
    sdk: {} as never,
    navigate: {} as never,
    experimental_panel: {} as never,
  });
}

describe("GTD thread actions", () => {
  it("hides every verb while no list is mounted", () => {
    for (const action of [
      settleThreadAction,
      snoozeThreadAction,
      unsettleThreadAction,
      wakeThreadAction,
    ]) {
      expect(item(action, target("root"), null)).toBeNull();
    }
  });

  it("settles an active thread and un-settles a settled one", () => {
    const data = listActions();
    item(settleThreadAction, target("busy"), data)?.run({ requestRename: vi.fn() });
    expect(data.settle).toHaveBeenCalledWith("busy");
    expect(item(settleThreadAction, target("done", 5), data)).toBeNull();
    expect(item(unsettleThreadAction, target("root"), data)).toBeNull();
    item(unsettleThreadAction, target("done", 5), data)?.run({ requestRename: vi.fn() });
    expect(data.unsettle).toHaveBeenCalledWith("done");
  });

  it("snoozes the whole family from any member, only when it can park", () => {
    const data = listActions();
    const fromChild = item(snoozeThreadAction, target("child"), data);
    expect(fromChild?.detail).toBe("Snoozes the whole family");
    fromChild?.run({ requestRename: vi.fn() });
    expect(data.snooze).toHaveBeenCalledWith("root");
    expect(item(snoozeThreadAction, target("busy"), data)).toBeNull();
    expect(item(snoozeThreadAction, target("parked"), data)).toBeNull();
  });

  it("wakes only a snoozed family", () => {
    const data = listActions();
    expect(item(wakeThreadAction, target("root"), data)).toBeNull();
    item(wakeThreadAction, target("parked"), data)?.run({ requestRename: vi.fn() });
    expect(data.wake).toHaveBeenCalledWith("parked");
  });
});
