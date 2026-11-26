// @vitest-environment jsdom

import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TASKS_PAGE_FRAME_STYLE_ATTR, TASKS_PAGE_UNFRAMED_ATTR } from "./shell/page-frame.js";

const app = await loadPluginApp(() => import("./app"));
const registeredBadge = app.navPanels[0]?.experimental_useBadge;
if (registeredBadge === undefined) {
  throw new Error("Tasks must register a badge");
}
const useBadge = registeredBadge;

function Badge() {
  const badge = useBadge();
  return badge === null ? null : (
    <span>
      {badge.count ?? "dot"}|{badge.label}
    </span>
  );
}

afterEach(cleanup);

describe("Tasks registrations", () => {
  it("puts navigation in the left sidebar and keeps the thread tab identity", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(app.contentScripts).toEqual([]);
    expect(app.navPanels[0]).not.toHaveProperty("fixedTabs");
    expect(app.navPanels[0]?.experimental_sidebar).toBeTypeOf("function");
    expect(app.tabs).toEqual([
      expect.objectContaining({
        context: { kind: "thread" },
        availability: "action",
        id: "task",
        title: "Task",
        icon: "ListTodo",
      }),
    ]);
  });
});

describe("Tasks nav panel badge", () => {
  it("reports the durable open count and refreshes it on task changes", async () => {
    let openTaskCount = 12;

    const slot = renderSlot(
      { component: Badge },
      {},
      {
        rpc: {
          sidebarOpenTaskCount: () => ({ openTaskCount }),
        },
      },
    );

    expect(await slot.findByText("12|12 open tasks")).toBeDefined();
    openTaskCount = 13;
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    });

    await waitFor(() => expect(slot.getByText("13|13 open tasks")).toBeDefined());
    openTaskCount = 7;
    await slot.behavior.emitRealtime("projects:changed", {
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    });
    await waitFor(() => expect(slot.getByText("7|7 open tasks")).toBeDefined());
    expect(
      slot.inspection.rpcCalls.filter(({ method }) => method === "sidebarOpenTaskCount"),
    ).toHaveLength(3);
  });

  it("reports no badge when there are no open tasks", async () => {
    let openTaskCount = 0;

    const slot = renderSlot(
      { component: Badge },
      {},
      {
        rpc: {
          sidebarOpenTaskCount: () => ({ openTaskCount }),
        },
      },
    );

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(({ method }) => method === "sidebarOpenTaskCount"),
      ).toHaveLength(1),
    );
    expect(slot.container.textContent).toBe("");

    openTaskCount = 1;
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    });
    expect(await slot.findByText("1|1 open task")).toBeDefined();

    openTaskCount = 0;
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    });
    await waitFor(() => expect(slot.container.textContent).toBe(""));
  });

  it("coalesces a burst of task changes into one trailing count refresh", async () => {
    let calls = 0;
    let resolveFirstRequest: ((result: { openTaskCount: number }) => void) | undefined;
    const firstRequest = new Promise<{ openTaskCount: number }>((resolve) => {
      resolveFirstRequest = resolve;
    });

    const slot = renderSlot(
      { component: Badge },
      {},
      {
        rpc: {
          sidebarOpenTaskCount: () => {
            calls += 1;
            return calls === 1 ? firstRequest : { openTaskCount: 13 };
          },
        },
      },
    );

    await waitFor(() => expect(calls).toBe(1));
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    });
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZT2",
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    });
    await slot.behavior.emitRealtime("projects:changed", {
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    });
    expect(calls).toBe(1);

    await act(async () => {
      resolveFirstRequest?.({ openTaskCount: 12 });
      await firstRequest;
    });

    await waitFor(() => expect(calls).toBe(2));
    expect(await slot.findByText("13|13 open tasks")).toBeDefined();
  });

  it("toggles data-scott-tasks-unframed on app-layout-root only while Tasks navPanel is mounted", async () => {
    const layoutRoot = document.createElement("div");
    layoutRoot.setAttribute("data-testid", "app-layout-root");
    document.body.append(layoutRoot);

    try {
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: {
            listFolders: () => ({ folders: [] }),
            listProjects: () => ({ projects: [] }),
            listTasks: () => ({ tasks: [] }),
            listLabels: () => ({ labels: [] }),
            listPresets: () => ({ presets: [] }),
            listActiveTaskThreads: () => ({ taskThreads: [] }),
            sidebarSummary: () => ({ projects: [] }),
            listBbProjects: () => ({ bbProjects: [] }),
          },
        },
      );

      await waitFor(() => {
        expect(layoutRoot.hasAttribute(TASKS_PAGE_UNFRAMED_ATTR)).toBe(true);
      });
      const styleEl = document.head.querySelector(`style[${TASKS_PAGE_FRAME_STYLE_ATTR}]`);
      expect(styleEl).not.toBeNull();
      expect(styleEl?.textContent).not.toContain(":has(");

      // Adding a focused split pane restores the shared frame.
      const splitPane = document.createElement("div");
      splitPane.setAttribute("data-split-pane-id", "pane-1");
      splitPane.setAttribute("data-focused", "true");
      layoutRoot.append(splitPane);
      await waitFor(() => {
        expect(layoutRoot.hasAttribute(TASKS_PAGE_UNFRAMED_ATTR)).toBe(false);
      });

      // Removing the focused split pane unframes again.
      splitPane.remove();
      await waitFor(() => {
        expect(layoutRoot.hasAttribute(TASKS_PAGE_UNFRAMED_ATTR)).toBe(true);
      });

      // Unmounting Tasks removes both the attribute and the style element.
      slot.unmount();
      expect(layoutRoot.hasAttribute(TASKS_PAGE_UNFRAMED_ATTR)).toBe(false);
      expect(document.head.querySelector(`style[${TASKS_PAGE_FRAME_STYLE_ATTR}]`)).toBeNull();
    } finally {
      layoutRoot.remove();
    }
  });
});
