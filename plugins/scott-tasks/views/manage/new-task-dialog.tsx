import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import {
  AttachmentChip,
  settleStagedUploads,
  stageFiles,
  uploadStagedAttachments,
  useStagedAttachmentRetry,
  type StagedAttachment,
} from "../../components/staged-attachments.js";
import {
  clearNewTaskDraft,
  hasDraftContent,
  loadNewTaskDraft,
  storeNewTaskDraft,
  type NewTaskDraft,
} from "./new-task-draft.js";
import { useLabels, useProjects, useTasksRpc } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, CompactButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { CreateLabelItem } from "../../components/create-label-item.js";
import { Hint } from "../../components/hint.js";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { DEFAULT_COLOR } from "./shared.js";
import { PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";
import { isNonImeKey } from "@/lib/ime-keyboard";

const CHIP_TRIGGER = "h-7 w-auto gap-1 rounded-md px-2 text-xs text-muted-foreground";

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  defaultStatus?: TaskStatus;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  projectId,
  defaultStatus,
}: NewTaskDialogProps) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const projects = useProjects();

  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>(defaultStatus ?? "todo");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [createMore, setCreateMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelQuery, setLabelQuery] = useState("");
  const [creatingLabel, setCreatingLabel] = useState(false);
  const createMoreId = useId();
  const [pendingFiles, setPendingFiles] = useState<StagedAttachment[]>([]);
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  // False until the fields hold the restored draft, so the first render after opening
  // doesn't save blank fields over it.
  const [draftRestored, setDraftRestored] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetFields = (draft: NewTaskDraft | null) => {
    setSelectedProjectId(draft?.projectId ?? projectId);
    setTitle(draft?.title ?? "");
    setDescription(draft?.description ?? "");
    setStatus(draft?.status ?? defaultStatus ?? "todo");
    setPriority(draft?.priority ?? "none");
    setLabelIds(draft?.labelIds ?? []);
    setDueDate(draft?.dueDate ?? "");
  };

  useEffect(() => {
    setDraftRestored(open);
    if (!open) return;
    resetFields(loadNewTaskDraft());
    setLabelQuery("");
    setPendingFiles([]);
    setCreatedTask(null);
    setError(null);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [open]);

  // A dismissal (outside click, Escape, reload) keeps what was typed.
  useEffect(() => {
    if (!open || !draftRestored || createdTask !== null) return;
    storeNewTaskDraft({
      projectId: selectedProjectId,
      title,
      description,
      status,
      priority,
      labelIds,
      dueDate,
    });
  }, [
    open,
    draftRestored,
    createdTask,
    selectedProjectId,
    title,
    description,
    status,
    priority,
    labelIds,
    dueDate,
  ]);

  const discardDraft = () => {
    clearNewTaskDraft();
    resetFields(null);
    setPendingFiles([]);
    titleRef.current?.focus();
  };

  const projectList = projects.data ?? [];
  const effectiveProjectId = selectedProjectId ?? projectId ?? projectList[0]?.id ?? null;
  const project = projectList.find((entry) => entry.id === effectiveProjectId) ?? null;

  const allLabels = useLabels();
  const labels = {
    data: allLabels.data?.filter((label) => label.projectId === effectiveProjectId),
  };

  const changeProject = (id: string) => {
    setSelectedProjectId(id);
    setLabelIds([]);
  };

  const toggleLabel = (labelId: string) =>
    setLabelIds((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId],
    );

  const trimmedLabelQuery = labelQuery.trim();
  const createLabelFromQuery = async () => {
    const name = trimmedLabelQuery;
    if (!name || effectiveProjectId === null || creatingLabel) return;
    setCreatingLabel(true);
    try {
      const { label } = await rpc.call("createLabel", {
        projectId: effectiveProjectId,
        name,
        color: DEFAULT_COLOR,
      });
      void allLabels.refetch();
      setLabelIds((current) => [...current, label.id]);
      setLabelQuery("");
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setCreatingLabel(false);
    }
  };

  const stageMore = (files: File[]) => {
    if (files.length === 0 || submitting || createdTask !== null) return;
    setPendingFiles((current) => [...current, ...stageFiles(files)]);
  };

  const removeFile = (id: number) => {
    if (submitting) return;
    setPendingFiles((files) => files.filter((entry) => entry.id !== id));
  };

  const retryUpload = useStagedAttachmentRetry(setPendingFiles);

  const finish = (task: Task) => {
    onOpenChange(false);
    navigation.go({ kind: "task", taskKey: task.key });
  };

  const requestClose = (next: boolean) => {
    if (!next && createdTask !== null && pendingFiles.length > 0) return;
    onOpenChange(next);
  };

  useEffect(() => {
    if (createdTask && pendingFiles.length === 0) finish(createdTask);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [createdTask, pendingFiles.length]);

  const hasOversized = pendingFiles.some((entry) => entry.status === "oversized");
  const canSubmit =
    effectiveProjectId !== null &&
    title.trim().length > 0 &&
    !submitting &&
    !hasOversized &&
    createdTask === null;

  const submit = async () => {
    if (!canSubmit || effectiveProjectId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await rpc.call("createTask", {
        projectId: effectiveProjectId,
        title: title.trim(),
        description,
        status,
        priority,
        dueDate: dueDate === "" ? null : dueDate,
        parentTaskId: null,
        labelIds,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      clearNewTaskDraft();
      const staged = pendingFiles.filter((entry) => entry.status === "staged");
      const failed = await uploadStagedAttachments(staged, {
        kind: "task",
        taskId: result.task.id,
      });
      if (failed.length > 0) {
        setPendingFiles((files) => settleStagedUploads(files, staged, failed));
        setCreatedTask(result.task);
        return;
      }
      if (createMore) {
        setTitle("");
        setDescription("");
        setLabelIds([]);
        setDueDate("");
        setPendingFiles([]);
        titleRef.current?.focus();
      } else {
        finish(result.task);
      }
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedLabels = useMemo(
    () => (labels.data ?? []).filter((label) => labelIds.includes(label.id)),
    [labels.data, labelIds],
  );
  const failedCount = pendingFiles.filter((entry) => entry.status === "failed").length;

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        className="flex max-h-[85dvh] min-h-0 max-w-xl flex-col gap-0 p-0"
        onKeyDown={(event) => {
          if (isNonImeKey(event, "Enter") && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        onPaste={(event) => {
          if (event.defaultPrevented || submitting || createdTask !== null) return;
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length === 0) return;
          event.preventDefault();
          stageMore(files);
        }}
      >
        <DialogTitle className="flex items-center gap-2 px-4 pt-4 text-xs font-normal text-muted-foreground">
          {project ? (
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-sm"
              style={{ backgroundColor: project.color }}
            />
          ) : null}
          New task
          {project ? ` · ${project.name}` : ""}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Create a task with a title, description, attributes, and attachments.
        </DialogDescription>
        {createdTask ? (
          <div className="px-4 pt-2">
            <Alert variant="warning">
              <AlertTitle>
                Task {createdTask.key} was created, but {failedCount} attachment
                {failedCount === 1 ? "" : "s"} failed to upload.
              </AlertTitle>
              <AlertDescription>
                Retry the uploads below, remove a file to skip it, or skip them all and open the
                task.
              </AlertDescription>
            </Alert>
            <div className="mt-3 flex flex-wrap gap-2">
              {pendingFiles.map((entry) => (
                <AttachmentChip
                  key={entry.id}
                  entry={entry}
                  onRemove={() => removeFile(entry.id)}
                  onRetry={retryUpload}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className={cn("flex min-h-0 flex-auto flex-col px-4 pt-2", createdTask && "hidden")}>
          <input
            ref={titleRef}
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (isNonImeKey(event, "Enter")) {
                event.preventDefault();
                event.stopPropagation();
                void submit();
              }
            }}
            placeholder="Task title"
            aria-label="Task title"
            className="w-full bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-muted-foreground"
          />
          <TasksEditor
            markdownDocument
            variant="comment"
            value={description}
            onChange={setDescription}
            placeholder="Description — rich text, round-trips as markdown for agents"
            className="mt-2 min-h-16 flex-auto overflow-y-auto"
            onAttachFiles={stageMore}
          />
          {createdTask === null && pendingFiles.length > 0 ? (
            <div className="mt-2 flex max-h-24 shrink-0 flex-wrap gap-2 overflow-y-auto">
              {pendingFiles.map((entry) => (
                <AttachmentChip
                  key={entry.id}
                  entry={entry}
                  disabled={submitting}
                  onRemove={() => removeFile(entry.id)}
                  onRetry={retryUpload}
                />
              ))}
            </div>
          ) : null}
          {hasOversized ? (
            <FieldError role="none" className="mt-2">
              Remove attachments over the 25 MB limit before creating the task.
            </FieldError>
          ) : null}
        </div>
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3",
            createdTask && "hidden",
          )}
        >
          <Select value={effectiveProjectId ?? undefined} onValueChange={changeProject}>
            <SelectTrigger aria-label="Project" className={cn(CHIP_TRIGGER, "max-w-44")}>
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projectList.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 rounded-sm"
                        style={{ backgroundColor: entry.color }}
                      />
                      {entry.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => setStatus(value as TaskStatus)}>
            <SelectTrigger aria-label="Status" className={CHIP_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TASK_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={priority} onValueChange={(value) => setPriority(value as TaskPriority)}>
            <SelectTrigger aria-label="Priority" className={CHIP_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TASK_PRIORITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {PRIORITY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(CHIP_TRIGGER, "border-input font-normal")}
              >
                {selectedLabels.length === 0 ? (
                  <>
                    <Icon name="Plus" className="size-3" />
                    Labels
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-1">
                      {selectedLabels.slice(0, 3).map((label) => (
                        <span
                          key={label.id}
                          aria-hidden
                          className="size-2 rounded-full"
                          style={{ backgroundColor: label.color }}
                        />
                      ))}
                    </span>
                    {selectedLabels.length === 1
                      ? selectedLabels[0]!.name
                      : `${selectedLabels.length} labels`}
                  </>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-0" align="start">
              <Command>
                <CommandInput
                  placeholder="Add labels…"
                  value={labelQuery}
                  onValueChange={setLabelQuery}
                />
                <CommandList>
                  {trimmedLabelQuery === "" ? (
                    <CommandEmpty>No labels in this project.</CommandEmpty>
                  ) : null}
                  <CreateLabelItem
                    name={trimmedLabelQuery}
                    disabled={creatingLabel}
                    onCreate={() => void createLabelFromQuery()}
                  />
                  <CommandGroup>
                    {(labels.data ?? []).map((label) => (
                      <CommandItem
                        key={label.id}
                        value={label.name}
                        onSelect={() => toggleLabel(label.id)}
                      >
                        <span
                          aria-hidden
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: label.color }}
                        />
                        <span className="flex-1">{label.name}</span>
                        {labelIds.includes(label.id) ? (
                          <Icon name="Check" className="size-3.5" />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Input
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            aria-label="Due date"
            className="h-7 w-auto px-2 text-xs text-muted-foreground"
          />
        </div>
        <FieldError className="mx-4 mt-2">{error}</FieldError>
        <DialogFooter className="mt-4 shrink-0 flex-row items-center border-t border-border-hairline px-4 py-3 sm:justify-between">
          {createdTask ? (
            <>
              <span />
              <Button size="sm" onClick={() => finish(createdTask)}>
                Skip attachments and open task
              </Button>
            </>
          ) : (
            <>
              <Field orientation="horizontal" className="w-auto gap-2">
                <Checkbox
                  id={createMoreId}
                  checked={createMore}
                  onCheckedChange={(checked) => setCreateMore(checked === true)}
                />
                <FieldLabel htmlFor={createMoreId}>Create more</FieldLabel>
              </Field>
              <div className="flex items-center gap-2">
                {hasDraftContent({ title, description }) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={submitting}
                    className="text-muted-foreground"
                    onClick={discardDraft}
                  >
                    Discard draft
                  </Button>
                ) : null}
                <Hint label="Attach files">
                  <CompactButton
                    variant="ghost"
                    tone="muted"
                    size="icon-sm"
                    aria-label="Attach files"
                    disabled={submitting}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Icon name="Paperclip" className="size-4" />
                  </CompactButton>
                </Hint>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  aria-hidden
                  tabIndex={-1}
                  className="hidden"
                  onChange={(event) => {
                    stageMore([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
                  Create task
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
