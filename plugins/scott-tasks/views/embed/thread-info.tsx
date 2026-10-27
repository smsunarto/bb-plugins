import {
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  useBbNavigate,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { eq, inArray } from "@tanstack/react-db";
import type { Task } from "../../shared/contract.js";
import { taskThreadsCollection, tasksCollection } from "../../shell/collections.js";
import { TasksDataRoot } from "../../shell/data-root.js";
import { useTasksLiveQuery } from "../../shell/data.js";
import { StatusIcon } from "../list/icons.js";
import { STATUS_LABELS } from "../list/lib.js";

const THREAD_INFO_TASK_LIMIT = 3;

function ThreadTaskRow({ task }: { task: Task }) {
  const navigate = useBbNavigate();
  return (
    <InfoListRow
      leading={<StatusIcon status={task.status} className="size-3" />}
      leadingLabel={STATUS_LABELS[task.status]}
      name={task.title}
      title={task.title}
      context={task.key}
      onSelect={() =>
        navigate.openThreadPanel({
          actionId: "task",
          title: task.key,
          params: { taskKey: task.key },
        })
      }
    />
  );
}

function TasksThreadInfoSectionContent({ threadId }: ExperimentalThreadInfoProps) {
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
  const tasks = linked.isReady ? linked.data : undefined;
  if (tasks === undefined || tasks.length === 0) return null;
  return (
    <InfoSection label="Tasks" count={tasks.length}>
      <InfoList
        items={tasks}
        getKey={(task) => task.id}
        limit={THREAD_INFO_TASK_LIMIT}
        renderItem={(task) => <ThreadTaskRow task={task} />}
      />
    </InfoSection>
  );
}

export function TasksThreadInfoSection(props: ExperimentalThreadInfoProps) {
  return (
    <TasksDataRoot>
      <TasksThreadInfoSectionContent {...props} />
    </TasksDataRoot>
  );
}
