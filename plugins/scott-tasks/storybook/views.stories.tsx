import { recoveryPlan } from "../../../.storybook/fixtures";
import { screenParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { ListView } from "../views/list";
import { BoardView } from "../views/board";
import { ManagePanel } from "../views/manage/manage-panel";
import { DetailView } from "../views/detail";
import { TasksDataRoot } from "../shell/data-root";
import { resetTasksDataForTest } from "../shell/testing";
import { makeTask, rpcInput } from "../test-fixtures";
import { tasksRpcContract, type Task } from "../shared/contract";

const projectId = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const project = {
  id: projectId,
  name: "Atlas · Autumn release",
  prefix: "TSK",
  nextTaskNumber: 13,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-10-01T09:00:00.000Z",
};
const labels = [
  { id: "01HZZZZZZZZZZZZZZZZZZZZAB1", projectId, name: "Reliability", color: "blue" },
  { id: "01HZZZZZZZZZZZZZZZZZZZZAB2", projectId, name: "Accessibility", color: "purple" },
  { id: "01HZZZZZZZZZZZZZZZZZZZZAB3", projectId, name: "Release blocker", color: "red" },
  { id: "01HZZZZZZZZZZZZZZZZZZZZAB4", projectId, name: "Performance", color: "orange" },
];
const tasks: Task[] = [
  makeTask({
    title: "Keep the review panel usable when a checkout goes offline",
    description: recoveryPlan,
    status: "in_progress",
    priority: "high",
    dueDate: "2026-10-26",
    labelIds: [labels[0]!.id, labels[2]!.id],
    createdAt: "2026-10-20T09:15:00.000Z",
    updatedAt: "2026-10-23T10:40:00.000Z",
  }),
  ...(
    [
      {
        title: "Restore keyboard focus after closing the command menu",
        status: "todo",
        priority: "high",
        labelIds: [labels[1]!.id],
      },
      {
        title: "Show the last successful refresh time on cached reviews",
        status: "done",
        priority: "medium",
        labelIds: [labels[0]!.id],
      },
      {
        title: "Ignore stale responses after switching checkouts",
        status: "in_progress",
        priority: "high",
        parentTaskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
        labelIds: [labels[0]!.id],
      },
      {
        title: "Reduce initial file-tree render time for large pull requests",
        status: "in_review",
        priority: "medium",
        labelIds: [labels[3]!.id],
      },
      {
        title: "Fix duplicate comments after retrying a timed-out submission",
        status: "todo",
        priority: "urgent",
        labelIds: [labels[2]!.id],
      },
      {
        title: "Document the recovery flow for disconnected build machines",
        status: "backlog",
        priority: "low",
        labelIds: [labels[0]!.id],
      },
      {
        title: "Preserve a draft comment during reconnect",
        status: "todo",
        priority: "medium",
        parentTaskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
        labelIds: [labels[0]!.id],
      },
      {
        title: "Announce refresh failures to screen readers",
        status: "in_review",
        priority: "high",
        labelIds: [labels[1]!.id],
      },
      {
        title: "Add a retry action to the empty review state",
        status: "done",
        priority: "medium",
        labelIds: [labels[0]!.id],
      },
      {
        title: "Explore background refresh for recently opened reviews",
        status: "backlog",
        priority: "none",
        labelIds: [],
      },
      {
        title: "Replace the file tree before every network refresh",
        status: "canceled",
        priority: "low",
        labelIds: [labels[3]!.id],
      },
    ] satisfies Partial<Task>[]
  ).map((item, index) =>
    makeTask({
      ...item,
      id: `01HZZZZZZZZZZZZZZZZZZZZ${String(index + 2).padStart(3, "0")}`,
      number: index + 2,
      key: `TSK-${index + 2}`,
      position: index + 1,
      createdAt: "2026-10-20T09:15:00.000Z",
      updatedAt: "2026-10-23T10:40:00.000Z",
      dueDate: index < 5 ? "2026-10-27" : null,
    } satisfies Partial<Task>),
  ),
];
// Exercise the real wire schemas so plausible-looking fixture IDs cannot bypass validation.
tasksRpcContract.listTasks.output.parse({ tasks, nextCursor: null });
tasksRpcContract.listProjects.output.parse({ projects: [project] });
tasksRpcContract.listLabels.output.parse({ labels });
const workingThread = tasksRpcContract.listActiveTaskThreads.output.parse({
  taskThreads: [
    {
      id: "01HZZZZZZZZZZZZZZZZZZZZTH1",
      taskId: tasks[0]!.id,
      threadId: "thr_review_recovery",
      presetName: "Implementation",
      title: "Preserve cached reviews across reconnects",
      liveStatus: "working",
      attachedAt: "2026-10-23T09:10:00.000Z",
      updatedAt: "2026-10-23T10:40:00.000Z",
    },
  ],
}).taskThreads[0]!;
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
      listLabels: () => ({ labels }),
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
      getTaskByKey: async (raw) => ({
        task: (await read()).find((task) => task.key === rpcInput(raw).taskKey) ?? null,
      }),
      getTask: (raw) => ({
        task: currentTasks.find((task) => task.id === rpcInput(raw).taskId) ?? null,
      }),
      listTaskThreads: (raw) => ({
        taskThreads: [workingThread].filter((link) => link.taskId === rpcInput(raw).taskId),
      }),
      listActiveTaskThreads: () => ({ taskThreads: [workingThread] }),
      countTaskAttachments: (raw) => ({
        counts: (rpcInput(raw).taskIds as string[]).map((taskId) => ({ taskId, count: 0 })),
      }),
      listComments: (raw) =>
        tasksRpcContract.listComments.output.parse({
          comments: [
            {
              id: "01HZZZZZZZZZZZZZZZZZZZZZC1",
              taskId: tasks[0]!.id,
              kind: "user",
              authorName: "Maya Chen",
              presetName: null,
              threadId: null,
              body: "The cached file list now survives a disconnect. Please check the stale-response case before we merge; switching checkouts still needs coverage.",
              notifiedCount: 0,
              createdAt: "2026-10-22T12:00:00Z",
              threadTitle: null,
              provider: null,
              attachments: [],
            },
          ].filter(() => rpcInput(raw).taskId === tasks[0]!.id),
        }),
      listAttachments: () => ({ attachments: [] }),
      listTaskPullRequests: (raw) =>
        tasksRpcContract.listTaskPullRequests.output.parse({
          pullRequests: [
            {
              url: "https://github.com/example/atlas/pull/284",
              number: 284,
              title: "Keep cached reviews available while the checkout reconnects",
              state: "draft",
              updatedAt: "2026-10-23T10:40:00.000Z",
              threadIds: ["thr_review_recovery"],
            },
          ].filter(() => rpcInput(raw).taskId === tasks[0]!.id),
          unavailableThreadIds: [],
        }),
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
    <TasksDataRoot>
      <div style={{ height: "100%", minHeight: 0 }}>
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
    </TasksDataRoot>
  );
}
const meta = {
  title: "Screens/Tasks/Views",
  component: TasksView,
  tags: ["autodocs"],
  args: { view: "list" },
  parameters: { ...screenParameters, host: fixture() },
  beforeEach: async () => {
    currentTasks = structuredClone(tasks);
    // The Tasks cache outlives a mount by design; each story starts from a cold one.
    await resetTasksDataForTest();
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
    await expect(
      within(canvasElement).findByText("Ignore stale responses after switching checkouts"),
    ).resolves.toBeVisible();
    await expect(
      within(canvasElement).findByRole("link", {
        name: /Pull request #284: Keep cached reviews available/,
      }),
    ).resolves.toBeVisible();
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
    await expect(within(canvasElement).findByText("Reliability")).resolves.toBeVisible();
  },
};
