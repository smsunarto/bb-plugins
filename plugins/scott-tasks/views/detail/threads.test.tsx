// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const THREAD_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const OFFLINE_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR2";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the PR pill",
  position: 1,
});

function taskThreadRow(id: string, threadId: string, title: string) {
  return {
    id,
    taskId: TASK_ID,
    threadId,
    presetName: "Attached",
    title,
    liveStatus: "working",
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function statusRows(input: unknown, row: (threadId: string) => unknown) {
  const { keys } = input as { keys: string[] };
  return Object.fromEntries(keys.map((key) => [key, row(key)]));
}

function changeRow(pullRequest: { number: number; title: string; state: string } | null) {
  return {
    state: "change",
    key: "gh:acme/bb:acme:bb/pill",
    branch: "bb/pill",
    pullRequest: pullRequest && {
      ...pullRequest,
      url: `https://github.com/acme/bb/pull/${pullRequest.number}`,
    },
    line: "",
    source: "checkout",
    forge: { state: "read", at: 1 },
    chips: [],
    tone: "neutral",
    sort: 0,
  };
}

function detailRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({
      projects: [
        {
          id: PROJECT_ID,
          name: "Tasks Plugin",
          prefix: "TSK",
          nextTaskNumber: 6,
          color: "blue",
          folderId: null,
          linkedBbProjectId: null,
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }),
    listTasks: (input: unknown) =>
      input !== null && rpcInput(input).parentTaskId ? { tasks: [] } : { tasks: [task] },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({
      taskThreads: [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
    }),
    // Source Control's keyed read; the test host routes by method name.
    statusForThread: (input: unknown) => statusRows(input, () => ({ state: "none" })),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...overrides,
  };
}

describe("task detail pull request pills", () => {
  it("links a thread's pull request as a keyboard-reachable anchor", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        openUrl: () => true,
        rpc: detailRpc({
          statusForThread: (input: unknown) =>
            statusRows(input, () =>
              changeRow({ number: 12, title: "Ship the PR pill", state: "merged" }),
            ),
        }),
      },
    );

    const link = (await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Merged)",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/acme/bb/pull/12");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.textContent).toContain("#12");
    fireEvent.click(link);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("marks threads whose PR read failed and stays quiet for threads without one", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              taskThreadRow(OFFLINE_ROW_ID, "thr_offline00", "Offline worker"),
            ],
          }),
          // GitHub couldn't be read for the offline worker; the other has no PR.
          statusForThread: (input: unknown) =>
            statusRows(input, (threadId) =>
              threadId === "thr_offline00"
                ? {
                    ...changeRow(null),
                    forge: { state: "failed", at: null, problem: { kind: "auth" } },
                  }
                : changeRow(null),
            ),
        }),
      },
    );

    await slot.findByText("Offline worker");
    expect(slot.getAllByText("PR unavailable")).toHaveLength(1);
    expect(slot.queryByRole("link", { name: /Pull request/ })).toBeNull();
  });

  it("closes the detach confirmation on Escape without leaving the task", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
          }),
        }),
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Detach Worker" }));
    const confirm = await slot.findByRole("alertdialog", { name: "Detach thread?" });
    const callsBefore = slot.navigateCalls.length;
    fireEvent.keyDown(confirm, { key: "Escape" });

    await waitFor(() => expect(slot.queryByRole("alertdialog")).toBeNull());
    expect(slot.navigateCalls.slice(callsBefore)).toEqual([]);
    expect(slot.rpcCalls.some((call) => call.method === "taskThreadsDetach")).toBe(false);
  });

  it("keeps the new-task shortcut inert while the detach confirmation is open", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
          }),
        }),
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Detach Worker" }));
    const confirm = await slot.findByRole("alertdialog", { name: "Detach thread?" });
    fireEvent.keyDown(confirm, { key: "c" });

    expect(slot.queryByRole("dialog")).toBeNull();
    expect(slot.getByRole("alertdialog", { name: "Detach thread?" })).toBeDefined();
  });

  it("detaches a thread from its card after confirmation and refetches the list", async () => {
    let detached = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: detached ? [] : [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
          }),
          taskThreadsDetach: (input: unknown) => {
            detached = true;
            return { threadId: rpcInput(input).threadId };
          },
        }),
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Detach Worker" }));
    fireEvent.click(await slot.findByRole("button", { name: "Detach" }));

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "taskThreadsDetach",
        input: { taskId: TASK_ID, threadId: "thr_worker000" },
      });
    });
    await waitFor(() => expect(slot.queryByText("Worker")).toBeNull());
  });

  it("marks every thread's PR unavailable when Source Control can't answer", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              taskThreadRow(OFFLINE_ROW_ID, "thr_offline00", "Offline worker"),
            ],
          }),
          statusForThread: () => {
            throw new Error("Plugin source-control is disabled");
          },
        }),
      },
    );

    await waitFor(() => expect(slot.getAllByText("PR unavailable")).toHaveLength(2));
    expect(slot.getByText("Offline worker")).toBeDefined();
  });

  it("updates the pill when Source Control reports the thread changed", async () => {
    let state = "open";
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          statusForThread: (input: unknown) =>
            statusRows(input, () => changeRow({ number: 12, title: "Ship the PR pill", state })),
        }),
      },
    );

    await slot.findByRole("link", { name: "Pull request #12: Ship the PR pill (Open)" });
    state = "merged";
    await slot.experimental_invalidateRpc(["thread:thr_worker000"], "source-control");

    await waitFor(() => {
      expect(
        slot.getByRole("link", { name: "Pull request #12: Ship the PR pill (Merged)" }),
      ).toBeTruthy();
    });
  });

  it("asks Source Control to re-read open pull requests when the window regains focus", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              taskThreadRow(OFFLINE_ROW_ID, "thr_merged000", "Merged worker"),
            ],
          }),
          statusForThread: (input: unknown) =>
            statusRows(input, (threadId) =>
              threadId === "thr_worker000"
                ? changeRow({ number: 12, title: "Ship the PR pill", state: "open" })
                : changeRow({ number: 9, title: "Done", state: "merged" }),
            ),
          refreshThread: () => ({ ok: true }),
        }),
      },
    );

    await slot.findByRole("link", { name: "Pull request #9: Done (Merged)" });
    await slot.findByRole("link", { name: "Pull request #12: Ship the PR pill (Open)" });
    expect(slot.rpcCalls.filter((call) => call.method === "refreshThread")).toEqual([]);
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(slot.rpcCalls.filter((call) => call.method === "refreshThread")).toEqual([
        { method: "refreshThread", input: { threadId: "thr_worker000" } },
      ]);
    });
  });
});
