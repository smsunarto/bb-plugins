/**
 * Publishes linked-task segments (`task`, `meta`, `threads`) into the shared
 * `@bb-plugins/header-bar` Vim-style thread statusbar and renders nothing
 * itself so only one unified statusbar appears under the thread header.
 */
import {
  usePublishHeaderBarSegments,
  type HeaderBarClickOptions,
  type HeaderBarGlyph,
  type HeaderBarMenuItem,
  type HeaderBarSegment,
  type HeaderBarTone,
} from "@bb-plugins/header-bar";
import { eq, inArray } from "@tanstack/react-db";
import {
  experimental_useAppPanel,
  experimental_useSidebarThreads,
  useBbNavigate,
  type ExperimentalThreadHeaderRowProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useMemo, useState } from "react";
import type { Task, TaskThread } from "../../shared/contract.js";
import { taskThreadsCollection, tasksCollection } from "../../shell/collections.js";
import { TasksDataRoot } from "../../shell/data-root.js";
import { useTasksLiveQuery } from "../../shell/data.js";
import { PANEL_PATH, tasksRouteToSubPath } from "../../shell/routes.js";
import { isActiveThread, THREAD_STATUS_META } from "../detail/meta.js";
import { formatDueDate, localIsoDate, PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";

/** Primary precedence for task + meta; lower than Captain (10) for sibling threads. */
const TASKS_PRIMARY_PRIORITY = 10;
const TASKS_THREADS_PRIORITY = 20;
const EMPTY_SEGMENTS: readonly HeaderBarSegment[] = [];

interface SiblingThreadItem {
  threadId: string;
  title: string;
  liveStatus: TaskThread["liveStatus"];
  attachedAt: string;
  isActive: boolean;
  isCurrent: boolean;
}

function isTaskOverdue(task: Task): boolean {
  return (
    task.dueDate !== null &&
    task.status !== "done" &&
    task.status !== "canceled" &&
    task.dueDate < localIsoDate(0)
  );
}

function taskButtonAriaLabel(task: Task): string {
  const parts = [`${task.key} — ${task.title}`, STATUS_LABELS[task.status].toLowerCase()];
  if (task.priority !== "none") {
    parts.push(`${PRIORITY_LABELS[task.priority].toLowerCase()} priority`);
  }
  if (task.dueDate !== null) {
    parts.push(`due ${formatDueDate(task.dueDate)}`);
  }
  return `${parts.join(", ")} — open in side panel`;
}

function mapDotTone(tone: string | null | undefined): HeaderBarTone {
  switch (tone) {
    case "success":
      return "success";
    case "warning":
    case "attention":
      return "warning";
    case "destructive":
    case "danger":
      return "destructive";
    case "accent":
    case "info":
      return "accent";
    default:
      return "muted";
  }
}

function sortLinkedTasks(
  linkedTasks: readonly Task[] | undefined,
  links: readonly TaskThread[] | undefined,
): Task[] {
  if (!linkedTasks || linkedTasks.length === 0) return [];
  const attachedAtByTaskId = new Map<string, string>();
  for (const link of links ?? []) {
    const prev = attachedAtByTaskId.get(link.taskId);
    if (prev === undefined || link.attachedAt < prev) {
      attachedAtByTaskId.set(link.taskId, link.attachedAt);
    }
  }
  return [...linkedTasks].sort((a, b) => {
    const aTime = attachedAtByTaskId.get(a.id) ?? "";
    const bTime = attachedAtByTaskId.get(b.id) ?? "";
    if (aTime !== bTime) return aTime.localeCompare(bTime);
    return a.key.localeCompare(b.key);
  });
}

function resolveSiblingThreads(
  taskThreadLinks: readonly TaskThread[] | undefined,
  sidebarStatus: "error" | "loading" | "ready",
  sidebarThreads: readonly PluginSidebarThread[],
  currentThreadId: string,
): SiblingThreadItem[] {
  if (sidebarStatus !== "ready" || !taskThreadLinks || taskThreadLinks.length === 0) return [];
  const sidebarById = new Map<string, PluginSidebarThread>();
  for (const thread of sidebarThreads) {
    sidebarById.set(thread.id, thread);
  }
  const seen = new Set<string>();
  const items: SiblingThreadItem[] = [];
  for (const link of taskThreadLinks) {
    if (seen.has(link.threadId) || link.liveStatus === "archived") continue;
    seen.add(link.threadId);
    const isCurrent = link.threadId === currentThreadId;
    const sidebarThread = sidebarById.get(link.threadId);
    if (sidebarThread?.isArchived) continue;
    if (!isCurrent && sidebarThread === undefined) continue;
    items.push({
      threadId: link.threadId,
      title: sidebarThread?.displayTitle || link.title,
      liveStatus: link.liveStatus,
      attachedAt: link.attachedAt,
      isActive: isActiveThread(link),
      isCurrent,
    });
  }
  items.sort((a, b) => {
    const aActive = a.isActive ? 0 : 1;
    const bActive = b.isActive ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    if (a.attachedAt !== b.attachedAt) return a.attachedAt.localeCompare(b.attachedAt);
    return a.threadId.localeCompare(b.threadId);
  });
  return items;
}

function useThreadLinkedTasks(threadId: string): Task[] {
  const links = useTasksLiveQuery(["thread-task-links", threadId], (q) =>
    q.from({ link: taskThreadsCollection }).where(({ link }) => eq(link.threadId, threadId)),
  );
  const taskIds = useMemo(
    () => [...new Set((links.data ?? []).map((link) => link.taskId))].sort(),
    [links.data],
  );
  const linked = useTasksLiveQuery(["thread-tasks", taskIds], (q) =>
    taskIds.length === 0
      ? undefined
      : q.from({ task: tasksCollection }).where(({ task }) => inArray(task.id, taskIds)),
  );
  return useMemo(
    () => (linked.isReady ? sortLinkedTasks(linked.data, links.data) : []),
    [linked.isReady, linked.data, links.data],
  );
}

function buildTaskSegment(args: {
  readonly primaryTask: Task;
  readonly tasks: readonly Task[];
  readonly onOpenTask: (task: Task) => void;
  readonly onSelectTask: (task: Task) => void;
}): HeaderBarSegment {
  const { primaryTask, tasks, onOpenTask, onSelectTask } = args;
  const label = taskButtonAriaLabel(primaryTask);
  const secondaryMenu =
    tasks.length > 1
      ? {
          triggerLabel: `+${tasks.length - 1}`,
          ariaLabel: `${tasks.length} linked tasks`,
          heading: `Linked tasks (${tasks.length})`,
          testId: "tasks-hb-switcher",
          items: tasks.map<HeaderBarMenuItem>((task) => ({
            id: task.id,
            keyText: task.key,
            label: task.title,
            glyph: { kind: "task-status", status: task.status },
            trailingGlyph:
              task.priority !== "none"
                ? { kind: "task-priority", priority: task.priority }
                : undefined,
            active: task.id === primaryTask.id,
            onSelect: () => onSelectTask(task),
          })),
        }
      : undefined;

  return {
    owner: "scott-tasks",
    slot: "task",
    priority: TASKS_PRIMARY_PRIORITY,
    glyph: { kind: "task-status", status: primaryTask.status },
    keyText: primaryTask.key,
    label: primaryTask.title,
    shrink: true,
    ariaLabel: label,
    title: label,
    testId: "tasks-hb-primary",
    onClick: () => onOpenTask(primaryTask),
    secondaryMenu,
  };
}

function buildMetaSegment(primaryTask: Task): HeaderBarSegment | null {
  const hasPriority = primaryTask.priority !== "none";
  const hasDue = primaryTask.dueDate !== null;
  if (!hasPriority && !hasDue) return null;

  const priorityGlyph: HeaderBarGlyph | undefined = hasPriority
    ? {
        kind: "task-priority",
        priority: primaryTask.priority as Exclude<Task["priority"], "none">,
      }
    : undefined;
  const metaParts: string[] = [];
  if (hasPriority) metaParts.push(`${PRIORITY_LABELS[primaryTask.priority]} priority`);
  if (primaryTask.dueDate !== null) metaParts.push(`Due ${formatDueDate(primaryTask.dueDate)}`);

  return {
    owner: "scott-tasks",
    slot: "meta",
    priority: TASKS_PRIMARY_PRIORITY,
    glyph: priorityGlyph,
    label: primaryTask.dueDate !== null ? formatDueDate(primaryTask.dueDate) : undefined,
    tone: isTaskOverdue(primaryTask) ? "warning" : "muted",
    ariaLabel: metaParts.join(" · "),
    title: metaParts.join(" · "),
    testId: "tasks-hb-meta",
  };
}

function buildTaskThreadsSegment(
  taskKey: string,
  visibleTaskThreads: readonly SiblingThreadItem[],
  onOpenThread: (threadId: string, options?: HeaderBarClickOptions) => void,
): HeaderBarSegment | null {
  const otherSiblings = visibleTaskThreads.filter((entry) => !entry.isCurrent);
  if (otherSiblings.length === 0) return null;

  const hasActiveSibling = otherSiblings.some((entry) => entry.isActive);
  return {
    owner: "scott-tasks",
    slot: "threads",
    priority: TASKS_THREADS_PRIORITY,
    testId: "tasks-hb-threads",
    menu: {
      triggerLabel: `${visibleTaskThreads.length} threads`,
      ariaLabel: `Switch between ${visibleTaskThreads.length} threads on ${taskKey}`,
      title: `Threads on ${taskKey}`,
      glyph: hasActiveSibling
        ? { kind: "dot", tone: "success", pulse: true }
        : { kind: "icon", name: "GitBranch", tone: "muted" },
      tone: "muted",
      heading: `Threads on ${taskKey}`,
      testId: "tasks-hb-threads-trigger",
      items: visibleTaskThreads.map<HeaderBarMenuItem>((entry) => {
        const meta = THREAD_STATUS_META[entry.liveStatus];
        return {
          id: entry.threadId,
          label: entry.title,
          detail: entry.isCurrent ? "Current" : meta.label,
          glyph: {
            kind: "dot",
            tone: mapDotTone(meta.dotTone),
            pulse: meta.pulse,
          },
          active: entry.isCurrent,
          onSelect: (options) => {
            if (!entry.isCurrent) onOpenThread(entry.threadId, options);
          },
        };
      }),
    },
  };
}

function TasksThreadHeaderRowContent({ threadId }: ExperimentalThreadHeaderRowProps) {
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const sidebar = experimental_useSidebarThreads();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const tasks = useThreadLinkedTasks(threadId);
  const primaryTask =
    (selectedTaskId !== null ? tasks.find((task) => task.id === selectedTaskId) : undefined) ??
    tasks[0];

  const primaryTaskId = primaryTask?.id ?? null;
  const taskThreadLinks = useTasksLiveQuery(["task-threads", primaryTaskId], (q) =>
    primaryTaskId === null
      ? undefined
      : q.from({ link: taskThreadsCollection }).where(({ link }) => eq(link.taskId, primaryTaskId)),
  );

  const visibleTaskThreads = useMemo(
    () =>
      resolveSiblingThreads(
        taskThreadLinks.isReady ? taskThreadLinks.data : undefined,
        sidebar.status,
        sidebar.threads,
        threadId,
      ),
    [taskThreadLinks.isReady, taskThreadLinks.data, sidebar.status, sidebar.threads, threadId],
  );

  const openTask = useCallback(
    (task: Task) => {
      const opened = panel.openTab({
        tab: { id: "task", context: { kind: "thread" }, availability: "action" },
        title: task.key,
        params: { taskKey: task.key },
      });
      if (!opened) {
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: tasksRouteToSubPath({ kind: "task", taskKey: task.key }),
        });
      }
    },
    [panel, navigate],
  );

  const openThread = useCallback(
    (targetThreadId: string, options?: HeaderBarClickOptions) => {
      if (options?.split) {
        navigate.toThread(targetThreadId, { split: true });
        return;
      }
      navigate.toThread(targetThreadId);
    },
    [navigate],
  );

  const selectTask = useCallback(
    (task: Task) => {
      setSelectedTaskId(task.id);
      openTask(task);
    },
    [openTask],
  );

  const segments = useMemo<readonly HeaderBarSegment[]>(() => {
    if (primaryTask === undefined) return EMPTY_SEGMENTS;
    const result: HeaderBarSegment[] = [
      buildTaskSegment({ primaryTask, tasks, onOpenTask: openTask, onSelectTask: selectTask }),
    ];
    const meta = buildMetaSegment(primaryTask);
    if (meta !== null) result.push(meta);
    const threadsSeg = buildTaskThreadsSegment(primaryTask.key, visibleTaskThreads, openThread);
    if (threadsSeg !== null) result.push(threadsSeg);
    return result;
  }, [primaryTask, tasks, visibleTaskThreads, openTask, selectTask, openThread]);

  usePublishHeaderBarSegments(threadId, "scott-tasks", segments);
  return null;
}

export function TasksThreadHeaderRow(props: ExperimentalThreadHeaderRowProps) {
  return (
    <TasksDataRoot>
      <TasksThreadHeaderRowContent key={props.threadId} {...props} />
    </TasksDataRoot>
  );
}
