import {
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  useBbNavigate,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import type { Task } from "../../shared/contract.js";
import { useTasksQuery } from "../../shell/data.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
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
  const { data: tasks } = useTasksQuery(
    async (rpc) => (await rpc.call("listThreadTasks", { threadId })).tasks,
    ["tasks:changed", "threads:changed"],
    [threadId],
  );
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
    <TasksRefreshProvider>
      <TasksThreadInfoSectionContent {...props} />
    </TasksRefreshProvider>
  );
}
