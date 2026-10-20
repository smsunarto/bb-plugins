// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "../../shared/contract.js";
import { makeTask } from "../../test-fixtures.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";

vi.mock("../../shell/routes.js", () => ({ useTasksNavigation: () => ({ go() {} }) }));
vi.mock("../../editor/tasks-editor.js", () => ({ TasksEditor: () => null }));
vi.mock("../activity/task-activity.js", () => ({ TaskActivity: () => null }));
vi.mock("./threads.js", () => ({ ThreadsSection: () => null }));
vi.mock("./rail.js", () => ({
  PropertiesRail: () => null,
  InlineProperties: ({
    task,
    onUpdate,
  }: {
    task: { status: string };
    onUpdate(input: { status: string }): void;
  }) => <button onClick={() => onUpdate({ status: "done" })}>{task.status}</button>,
}));
const { DetailView } = await import("./index.js");
const task = makeTask({ key: "TSK-1", title: "Original title", status: "todo" });
// The write's server stamp and a later one; `task` is stamped before both.
const WRITTEN_AT = "2026-07-16T00:00:00.000Z";
const LATER = "2026-07-17T00:00:00.000Z";
let server: Task = task;
function Harness() {
  return (
    <TasksRefreshProvider>
      <DetailView taskKey={task.key} />
    </TasksRefreshProvider>
  );
}
function mount(update: () => Promise<unknown>) {
  return renderSlot(
    { component: Harness },
    {},
    {
      rpc: {
        getTaskByKey: () => ({ task: server }),
        listProjects: () => ({ projects: [] }),
        listTasks: () => ({ tasks: [] }),
        listLabels: () => ({ labels: [] }),
        listAttachments: () => ({ attachments: [] }),
        listTaskThreads: () => ({ taskThreads: [] }),
        listPresets: () => ({ presets: [] }),
        listTaskPullRequests: () => ({ pullRequests: [] }),
        updateTask: update,
      } as never,
    },
  );
}
type Slot = ReturnType<typeof mount>;
afterEach(() => {
  cleanup();
  server = task;
});

async function refetch(slot: Slot, next: Task) {
  server = next;
  await slot.emitRealtime("tasks:changed", { taskId: task.id, projectId: task.projectId });
}

function titleOf(slot: Slot) {
  return slot.getByRole("textbox", { name: "Task title" }).textContent;
}

function deferredUpdate() {
  let finish!: (result: unknown) => void;
  const update = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  return { update, finish: (result: unknown) => act(async () => finish(result)) };
}

it("renders a detail property edit before the RPC resolves and rolls back rejection", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const slot = mount(() => pending);
  await slot.findByRole("button", { name: "todo" });
  fireEvent.click(slot.getByRole("button", { name: "todo" }));
  expect(slot.getByRole("button", { name: "done" })).toBeTruthy();
  await act(async () => reject(new Error("offline")));
  expect(slot.getByRole("button", { name: "todo" })).toBeTruthy();
});

it("rolls back a rejected title", async () => {
  const write = deferredUpdate();
  const slot = mount(write.update);
  const title = await slot.findByRole("textbox", { name: "Task title" });
  title.textContent = "New title";
  fireEvent.blur(title);
  expect(titleOf(slot)).toBe("New title");
  await write.finish({ ok: false, error: { message: "refused" } });
  expect(titleOf(slot)).toBe("Original title");
});

it("keeps an edit through a stale refetch and drops it once the server carries it", async () => {
  const write = deferredUpdate();
  const slot = mount(write.update);
  fireEvent.click(await slot.findByRole("button", { name: "todo" }));

  // A refetch from before the write lands leaves the pending edit on screen.
  await refetch(slot, { ...task, title: "Stale refetch" });
  await waitFor(() => expect(titleOf(slot)).toBe("Stale refetch"));
  expect(slot.getByRole("button", { name: "done" })).toBeTruthy();

  await write.finish({ ok: true, task: { ...task, status: "done", updatedAt: WRITTEN_AT } });
  expect(slot.getByRole("button", { name: "done" })).toBeTruthy();

  await refetch(slot, { ...task, title: "Caught up", status: "done", updatedAt: WRITTEN_AT });
  await waitFor(() => expect(titleOf(slot)).toBe("Caught up"));
  expect(slot.getByRole("button", { name: "done" })).toBeTruthy();

  // Nothing overlays the task any more, so even an older server value draws.
  await refetch(slot, { ...task, title: "Caught up", status: "in_progress" });
  expect(await slot.findByRole("button", { name: "in_progress" })).toBeTruthy();
});

it("shows a newer server value that lands after a successful edit", async () => {
  const write = deferredUpdate();
  const slot = mount(write.update);
  const title = await slot.findByRole("textbox", { name: "Task title" });
  title.textContent = "Edited title";
  fireEvent.blur(title);
  await write.finish({ ok: true, task: { ...task, title: "Edited title", updatedAt: WRITTEN_AT } });

  // A refetch older than the write keeps the edit.
  await refetch(slot, { ...task, status: "in_progress" });
  await slot.findByRole("button", { name: "in_progress" });
  expect(titleOf(slot)).toBe("Edited title");

  // An agent renames the task before the view's refetch observes the edit.
  await refetch(slot, { ...task, title: "Agent title", updatedAt: LATER });
  await waitFor(() => expect(titleOf(slot)).toBe("Agent title"));
});
