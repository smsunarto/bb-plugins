import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { ListView } from "../views/list";
import { BoardView } from "../views/board";
import { ManagePanel } from "../views/manage/manage-panel";
import { DetailView } from "../views/detail";
import { TasksRefreshProvider } from "../shell/refresh";
import { resetQuerySnapshotStateForTest } from "../shell/query-snapshot";
import { makeTask, rpcInput } from "../test-fixtures";
import type { Task } from "../shared/contract";

const projectId = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const project = {
  id: projectId,
  name: "Plugin experience",
  prefix: "TSK",
  nextTaskNumber: 5,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};
const tasks: Task[] = [
  makeTask({
    title: "Document the component catalog",
    description: "## Acceptance criteria\n\n- Cover each plugin\n- Verify narrow panels",
    status: "in_progress",
    priority: "high",
    labelIds: ["01HZZZZZZZZZZZZZZZZZZZZLBL"],
  }),
  makeTask({
    id: "01HZZZZZZZZZZZZZZZZZZZZZT2",
    number: 2,
    key: "TSK-2",
    title: "Review empty states",
    status: "todo",
    priority: "medium",
    position: 1,
  }),
  makeTask({
    id: "01HZZZZZZZZZZZZZZZZZZZZZT3",
    number: 3,
    key: "TSK-3",
    title: "Verify dialogs",
    status: "done",
    position: 2,
  }),
  makeTask({
    id: "01HZZZZZZZZZZZZZZZZZZZZZT4",
    number: 4,
    key: "TSK-4",
    title: "Check narrow layout",
    parentTaskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
    status: "todo",
    position: 3,
  }),
];
let currentTasks: Task[] = structuredClone(tasks);
function fixture(
  mode: "populated" | "empty" | "loading" | "error" = "populated",
): RenderSlotOptions {
  const read = () => {
    if (mode === "loading") return new Promise<never>(() => {});
    if (mode === "error") throw new Error("The task host is offline. Retry when it reconnects.");
    return mode === "empty" ? [] : currentTasks;
  };
  return {
    pluginId: "scott-tasks",
    rpc: {
      listProjects: () => ({ projects: [project] }),
      listFolders: () => ({ folders: [] }),
      listPresets: () => ({ presets: [] }),
      listLabels: () => ({
        labels: [
          { id: "01HZZZZZZZZZZZZZZZZZZZZLBL", projectId, name: "Documentation", color: "blue" },
        ],
      }),
      listTasks: async (raw) => {
        const input = rpcInput(raw);
        const all = await read();
        return {
          tasks: all.filter(
            (task) =>
              (input.parentTaskId === undefined || task.parentTaskId === input.parentTaskId) &&
              (!Array.isArray(input.statuses) || input.statuses.includes(task.status)),
          ),
          nextCursor: null,
        };
      },
      getTaskByKey: async () => ({ task: (await read())[0] ?? null }),
      getTask: (raw) => ({
        task: currentTasks.find((task) => task.id === rpcInput(raw).taskId) ?? null,
      }),
      listTaskThreads: () => ({ taskThreads: [] }),
      listComments: () => ({
        comments: [
          {
            id: "01HZZZZZZZZZZZZZZZZZZZZZC1",
            taskId: tasks[0]!.id,
            kind: "user",
            authorName: "Developer",
            presetName: null,
            threadId: null,
            body: "Narrow panels are ready for review.",
            notifiedCount: 0,
            createdAt: "2026-10-22T12:00:00Z",
            threadTitle: null,
            provider: null,
            attachments: [],
          },
        ],
      }),
      listAttachments: () => ({ attachments: [] }),
      listTaskPullRequests: () => ({ pullRequests: [], errors: [] }),
      updateTask: (raw) => {
        const { taskId, ...patch } = rpcInput(raw);
        const task = currentTasks.find((task) => task.id === taskId);
        if (!task) throw new Error("Task not found");
        Object.assign(task, patch, {
          updatedAt: new Date(Date.parse(task.updatedAt) + 1000).toISOString(),
        });
        return { ok: true, task };
      },
    },
  };
}
function TasksView({ view }: { view: "list" | "board" | "detail" | "manage" }) {
  return (
    <TasksRefreshProvider>
      <div style={{ height: 700 }}>
        {view === "list" ? (
          <ListView projectId={projectId} />
        ) : view === "board" ? (
          <BoardView projectId={projectId} />
        ) : view === "manage" ? (
          <ManagePanel />
        ) : (
          <DetailView taskKey="TSK-1" />
        )}
      </div>
    </TasksRefreshProvider>
  );
}
const meta = {
  title: "Screens/Tasks/Views",
  component: TasksView,
  tags: ["autodocs"],
  args: { view: "list" },
  parameters: { host: fixture() },
  beforeEach: () => {
    currentTasks = structuredClone(tasks);
    resetQuerySnapshotStateForTest();
    // Only Storybook's origin is touched; each story starts without prior task snapshots or filters.
    for (const key of Object.keys(localStorage))
      if (key.startsWith("bb-tasks:")) localStorage.removeItem(key);
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText(tasks[0]!.title)).resolves.toBeVisible();
  },
} satisfies Meta<typeof TasksView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const List: Story = {};
export const EmptyList: Story = {
  parameters: { host: fixture("empty") },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("No tasks yet")).resolves.toBeVisible();
  },
};
export const LoadingList: Story = {
  parameters: { host: fixture("loading") },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0),
    );
  },
};
export const OfflineList: Story = {
  parameters: { host: fixture("error") },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("Couldn't load tasks")).resolves.toBeVisible();
  },
};
export const Board: Story = { args: { view: "board" } };
export const EmptyBoard: Story = {
  args: { view: "board" },
  parameters: { host: fixture("empty") },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("In Progress")).resolves.toBeVisible();
    await expect(within(canvasElement).queryByText(tasks[0]!.title)).not.toBeInTheDocument();
  },
};
export const Detail: Story = {
  args: { view: "detail" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("textbox", { name: "Task title" }),
    ).resolves.toHaveTextContent(tasks[0]!.title);
    await expect(within(canvasElement).findByText("Check narrow layout")).resolves.toBeVisible();
  },
};
export const MissingDetail: Story = {
  args: { view: "detail" },
  parameters: { host: fixture("empty") },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Task TSK-1 was not found."),
    ).resolves.toBeVisible();
  },
};
export const OfflineDetail: Story = {
  args: { view: "detail" },
  parameters: { host: fixture("error") },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("The task host is offline. Retry when it reconnects."),
    ).resolves.toBeVisible();
  },
};

export const Manage: Story = {
  args: { view: "manage" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("tab", { name: "Labels" }),
    ).resolves.toBeVisible();
    await expect(within(canvasElement).findByText("Documentation")).resolves.toBeVisible();
  },
};
