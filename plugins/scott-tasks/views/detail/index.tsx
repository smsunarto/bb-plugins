import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { eq } from "@tanstack/react-db";
import type { Task } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import {
  writeServerTask,
  editTask,
  taskThreadsCollection,
  tasksCollection,
} from "../../shell/collections.js";
import {
  tasksLoadError,
  useLabels,
  useMentionItems,
  usePresets,
  useProjects,
  useTasksLiveQuery,
  useTasksRpc,
} from "../../shell/data.js";
import { attachmentsQuery, tasksKeys } from "../../shell/query.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { TaskActivity } from "../activity/task-activity.js";
import { AttachmentsGrid, uploadAttachment } from "./attachments.js";
import { createDescriptionSaver, type DescriptionSaver } from "./description-save.js";
import { StatusIcon } from "./meta.js";
import { STATUS_LABELS } from "../list/lib.js";
import { sortTasks } from "../../shared/sort.js";
import { PropertiesRail, type TaskPropertyUpdate } from "./rail.js";
import { ThreadsSection } from "./threads.js";
import { DetailToasts, useDetailToasts } from "./toast.js";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Button, CompactButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Item, ItemGroup } from "@/components/ui/item";
import { Hint } from "../../components/hint.js";
import { Skeleton } from "@/components/ui/skeleton";
import { isNonImeKey } from "@/lib/ime-keyboard";

interface DetailViewProps {
  taskKey: string;
}

const DESCRIPTION_SAVE_DELAY_MS = 800;
function SubTaskDonut({ subtasks, onClick }: { subtasks: Task[]; onClick: () => void }) {
  if (subtasks.length === 0) return null;
  const done = subtasks.filter((subtask) => subtask.status === "done").length;
  const degrees = (done / subtasks.length) * 360;
  return (
    <Hint label="Sub-tasks completed">
      <Button
        variant="outline"
        size="sm"
        onClick={onClick}
        className="h-6 gap-1 rounded-full px-2 font-normal text-muted-foreground"
      >
        <span
          aria-hidden
          className="inline-block size-3 rounded-full"
          style={{
            background: `conic-gradient(var(--primary) ${degrees}deg, var(--muted) 0)`,
          }}
        />
        {done}/{subtasks.length} sub-tasks
      </Button>
    </Hint>
  );
}

function EditableTitle({ task, onSave }: { task: Task; onSave: (title: string) => void }) {
  return (
    <h1
      key={`${task.id}:${task.title}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Task title"
      className="text-[1.75rem] font-semibold leading-tight tracking-tight outline-none focus-visible:underline focus-visible:decoration-ring focus-visible:underline-offset-4 @[45rem]:text-[2.125rem]"
      onKeyDown={(event) => {
        if (isNonImeKey(event, "Enter")) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = event.currentTarget.textContent?.trim() ?? "";
        if (!next) {
          event.currentTarget.textContent = task.title;
          return;
        }
        if (next !== task.title) onSave(next);
      }}
    >
      {task.title}
    </h1>
  );
}

function SubTasksSection({
  ref,
  task,
  subtasks,
  onCreate,
}: {
  ref: React.Ref<HTMLElement>;
  task: Task;
  subtasks: Task[];
  onCreate: (title: string) => Promise<boolean>;
}) {
  const navigation = useTasksNavigation();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const created = await onCreate(trimmed);
    setBusy(false);
    if (created) setTitle("");
  };

  return (
    <section ref={ref} className="mt-5">
      <ItemGroup variant="flush" role="none">
        {subtasks.map((subtask) => (
          <Item key={subtask.id} asChild size="row">
            <button
              type="button"
              title={STATUS_LABELS[subtask.status]}
              onClick={() => navigation.go({ kind: "task", taskKey: subtask.key })}
            >
              <StatusIcon status={subtask.status} />
              <span className="shrink-0 text-xs text-muted-foreground">{subtask.key}</span>
              <span className="min-w-0 truncate">{subtask.title}</span>
            </button>
          </Item>
        ))}
        {adding ? (
          <Item size="row">
            <StatusIcon status="todo" className="opacity-60" />
            <input
              autoFocus
              value={title}
              placeholder={`Sub-task of ${task.key}…`}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (isNonImeKey(event, "Enter")) void submit();
                if (isNonImeKey(event, "Escape")) {
                  setAdding(false);
                  setTitle("");
                }
              }}
              onBlur={() => {
                if (!title.trim()) setAdding(false);
              }}
            />
          </Item>
        ) : null}
      </ItemGroup>
      <CompactButton
        variant="ghost"
        size="sm"
        className="gap-1 text-muted-foreground"
        onClick={() => setAdding(true)}
      >
        <Icon name="Plus" className="size-3" />
        Add sub-task
      </CompactButton>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <DelayedLoading>
      <div className="mx-auto w-full max-w-3xl px-8 py-12">
        <Skeleton className="mb-4 h-7 w-2/3" />
        <Skeleton className="mb-2 h-4 w-full" />
        <Skeleton className="mb-2 h-4 w-5/6" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </DelayedLoading>
  );
}

function TaskDetail({ task }: { task: Task }) {
  const rpc = useTasksRpc();
  const queryClient = useQueryClient();
  const delegationRpc = useRpc<DelegationRpcContract>();
  const navigation = useTasksNavigation();
  const { toasts, push, dismiss } = useDetailToasts();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtasksRef = useRef<HTMLElement>(null);

  const [draft, setDraft] = useState<{ taskId: string; markdown: string }>();
  const rpcRef = useRef(rpc);
  const pushRef = useRef(push);
  useLayoutEffect(() => {
    rpcRef.current = rpc;
    pushRef.current = push;
  });
  const saverRef = useRef<DescriptionSaver | null>(null);
  saverRef.current ??= createDescriptionSaver({
    save: async (taskId, markdown) => {
      const result = await rpcRef.current.call("updateTask", {
        taskId,
        description: markdown,
      });
      return result.ok ? { ok: true } : { ok: false, errorMessage: result.error.message };
    },
    onError: (message) => pushRef.current(message),
    delayMs: DESCRIPTION_SAVE_DELAY_MS,
  });

  const projects = useProjects();
  const project = projects.data?.find((entry) => entry.id === task.projectId);

  const { parentTaskId } = task;
  const parent = useTasksLiveQuery(["task-by-id", parentTaskId], (q) =>
    parentTaskId === null
      ? undefined
      : q
          .from({ parent: tasksCollection })
          .where(({ parent }) => eq(parent.id, parentTaskId))
          .findOne(),
  );
  const subtaskRows = useTasksLiveQuery(["subtasks", task.id], (q) =>
    q.from({ subtask: tasksCollection }).where(({ subtask }) => eq(subtask.parentTaskId, task.id)),
  );
  const subtasks = useMemo(
    () => ({ data: subtaskRows.data && sortTasks(subtaskRows.data, "manual") }),
    [subtaskRows.data],
  );
  const allLabels = useLabels();
  const labels = useMemo(
    () => allLabels.data?.filter((label) => label.projectId === task.projectId),
    [allLabels.data, task.projectId],
  );
  const attachments = useQuery(attachmentsQuery(task.id));
  const threads = useTasksLiveQuery(["task-threads", task.id], (q) =>
    q.from({ link: taskThreadsCollection }).where(({ link }) => eq(link.taskId, task.id)),
  );
  const presets = usePresets();
  const refreshAttachments = () =>
    queryClient.invalidateQueries({ queryKey: tasksKeys.attachments(task.id) });

  // Title and property edits draw on the click, the same way the list's do,
  // and roll back with a toast when the write fails.
  const updateTask = (input: TaskPropertyUpdate & { title?: string }) => {
    editTask(task.id, input).catch((error: unknown) => push(errorMessage(error)));
  };

  // A move gives the task a new key, so the page follows it there.
  const moveToProject = async (projectId: string) => {
    saverRef.current?.flush(task.id);
    try {
      const result = await rpc.call("moveTaskToProject", { taskId: task.id, projectId });
      if (!result.ok) {
        push(result.error.message);
        return;
      }
      await writeServerTask(result.task);
      navigation.go({ kind: "task", taskKey: result.task.key }, { replace: true });
    } catch (error) {
      push(errorMessage(error));
    }
  };

  const onDescriptionChange = (markdown: string) => {
    setDraft({ taskId: task.id, markdown });
    saverRef.current?.onChange(task.id, markdown);
  };

  useEffect(() => {
    return () => saverRef.current?.flush(task.id);
  }, [task.id]);

  const uploadForTask = async (file: File) => {
    const result = await uploadAttachment(file, { kind: "task", taskId: task.id });
    void refreshAttachments();
    return result;
  };

  const onPickFiles = async (files: FileList | null) => {
    for (const file of files ?? []) {
      try {
        await uploadAttachment(file, { kind: "task", taskId: task.id });
      } catch (error) {
        push(errorMessage(error));
      }
    }
    void refreshAttachments();
  };

  const createSubtask = async (title: string): Promise<boolean> => {
    try {
      const result = await rpc.call("createTask", {
        projectId: task.projectId,
        title,
        parentTaskId: task.id,
        status: "todo",
      });
      if (!result.ok) {
        push(result.error.message);
        return false;
      }
      await writeServerTask(result.task);
      return true;
    } catch (error) {
      push(errorMessage(error));
      return false;
    }
  };

  const mentionItems = useMentionItems();
  const navigate = useBbNavigate();

  const descriptionValue = draft && draft.taskId === task.id ? draft.markdown : task.description;
  const parentTask = parent.data ?? null;

  return (
    <div className="@container min-h-full bg-background">
      <article className="grid min-h-full grid-cols-[minmax(0,1fr)] @[45rem]:grid-cols-[minmax(0,1fr)_16rem] @[45rem]:grid-rows-[auto_1fr] @[70rem]:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="mx-auto w-full min-w-0 max-w-[49rem] px-4 pb-4 pt-5 @[45rem]:col-start-1 @[45rem]:row-start-1 @[45rem]:px-8 @[45rem]:pb-7 @[45rem]:pt-12 @[70rem]:px-10">
          {parentTask || subtasks.data?.length ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {parentTask ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 max-w-full gap-1 rounded-full px-2 font-normal text-muted-foreground"
                  onClick={() => navigation.go({ kind: "task", taskKey: parentTask.key })}
                >
                  Sub-task of
                  <StatusIcon status={parentTask.status} className="size-3" />
                  <span className="font-medium text-foreground">{parentTask.key}</span>
                  <span className="min-w-0 truncate">{parentTask.title}</span>
                </Button>
              ) : null}
              <SubTaskDonut
                subtasks={subtasks.data ?? []}
                onClick={() =>
                  subtasksRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  })
                }
              />
            </div>
          ) : null}

          <EditableTitle task={task} onSave={(title) => updateTask({ title })} />
        </div>
        <PropertiesRail
          key={task.id}
          task={task}
          project={project}
          projects={projects.data}
          labels={labels}
          threads={threads.data ?? []}
          presets={presets.data}
          onUpdate={updateTask}
          onMoveToProject={(projectId) => void moveToProject(projectId)}
          onError={(message) => push(message)}
          className="mx-auto w-full max-w-[55rem] px-4 pb-4 @[45rem]:col-start-2 @[45rem]:row-span-2 @[45rem]:row-start-1 @[45rem]:max-w-none @[45rem]:p-0"
        >
          {(threads.data ?? []).length > 0 ? (
            <div className="w-full @[45rem]:mt-4">
              <ThreadsSection
                threads={threads.data ?? []}
                onDetach={async (thread) => {
                  await delegationRpc.call("taskThreadsDetach", {
                    taskId: task.id,
                    threadId: thread.threadId,
                  });
                  await queryClient.invalidateQueries({ queryKey: ["taskThreads"] });
                }}
                onError={(message) => push(message)}
              />
            </div>
          ) : null}
        </PropertiesRail>
        <div className="mx-auto w-full min-w-0 max-w-[49rem] px-4 pb-14 @[45rem]:col-start-1 @[45rem]:row-start-2 @[45rem]:px-8 @[70rem]:px-10">
          <TasksEditor
            value={descriptionValue}
            onChange={onDescriptionChange}
            variant="doc"
            className="min-h-20 @[45rem]:[--tasks-editor-font-size:15px]"
            placeholder="Add a description…"
            onUploadImage={uploadForTask}
            mentionItems={mentionItems}
            onOpenThread={(threadId) => navigate.toThread(threadId)}
          />

          <div className="mb-1 mt-3 flex items-center gap-1">
            <Hint label="Attach file">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Attach file"
                className="size-7 text-muted-foreground max-md:pointer-coarse:size-11"
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="Paperclip" className="size-4" />
              </Button>
            </Hint>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void onPickFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>

          <AttachmentsGrid
            attachments={attachments.data ?? []}
            onRemove={async (attachment) => {
              const result = await rpc.call("deleteAttachment", {
                attachmentId: attachment.id,
                removeDescriptionReferences: true,
              });
              if (!result.ok) throw new Error(result.error.message);
              void refreshAttachments();
            }}
            onError={(message) => push(message)}
          />

          <SubTasksSection
            ref={subtasksRef}
            task={task}
            subtasks={subtasks.data ?? []}
            onCreate={createSubtask}
          />

          <div className="mt-1">
            <TaskActivity taskId={task.id} />
          </div>
        </div>
      </article>
      <DetailToasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export function DetailView({ taskKey }: DetailViewProps) {
  // Task keys are an upper-case project prefix and a number.
  const key = taskKey.trim().toUpperCase();
  const query = useTasksLiveQuery(["task-by-key", key], (q) =>
    q
      .from({ task: tasksCollection })
      .where(({ task }) => eq(task.key, key))
      .findOne(),
  );

  if (!query.isReady) {
    return query.isError ? (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {tasksLoadError()}
      </div>
    ) : (
      <DetailSkeleton />
    );
  }
  if (query.data === undefined) return <MovedTaskRedirect taskKey={key} />;
  return <TaskDetail task={query.data} />;
}

/**
 * The local collection only knows live keys. A key a task had before it moved projects still
 * resolves on the server, so ask it once and follow the task to its current key.
 */
function MovedTaskRedirect({ taskKey }: { taskKey: string }) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const lookup = useQuery({
    queryKey: ["tasks", "task-key-alias", taskKey],
    queryFn: async () => (await rpc.call("getTaskByKey", { taskKey })).task,
    staleTime: Infinity,
  });
  const currentKey = lookup.data?.key;
  useEffect(() => {
    if (currentKey !== undefined && currentKey !== taskKey) {
      navigation.go({ kind: "task", taskKey: currentKey }, { replace: true });
    }
  }, [currentKey, taskKey, navigation]);

  if (lookup.isPending || (currentKey !== undefined && currentKey !== taskKey)) {
    return <DetailSkeleton />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      <Icon name="FileQuestion" className="size-5" />
      Task {taskKey} was not found.
    </div>
  );
}
