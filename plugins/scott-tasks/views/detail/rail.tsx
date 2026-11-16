import { useState } from "react";
import type {
  Label,
  Project,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
  Preset,
  BbProjectOption,
} from "../../shared/contract.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { useQuery } from "@tanstack/react-query";
import { useTasksRpc } from "../../shell/data.js";
import { bbProjectsQuery } from "../../shell/query.js";
import { PriorityIcon, StatusIcon, formatDueDate, isActiveThread } from "./meta.js";
import { DUE_DATE_PRESETS, localIsoDate, PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";
import { DispatchControl } from "./threads.js";
import { CreateLabelItem } from "../../components/create-label-item.js";
import { DEFAULT_COLOR } from "../manage/shared.js";
import { BbProjectLinkPicker } from "../manage/bb-project-link.js";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface TaskPropertyUpdate {
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  labelIds?: string[];
}

interface TaskPropertiesProps {
  task: Task;
  project: Project | undefined;
  labels: Label[] | undefined;
  threads: TaskThread[];
  onUpdate: (update: TaskPropertyUpdate) => void;
}

/** How a property menu's trigger looks: a full-width rail row or an inline chip. */
type PropertyTrigger = Pick<ButtonProps, "variant" | "className">;

const RAIL_TRIGGER: PropertyTrigger = {
  variant: "ghost",
  className: "-mx-2 h-7 w-[calc(100%+1rem)] justify-start px-2 text-sm font-normal",
};

const CHIP_TRIGGER: PropertyTrigger = {
  variant: "secondary",
  className: "h-6 gap-1 px-2 font-normal",
};

function LabelChip({ label }: { label: Label }) {
  return (
    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      {label.name}
    </Badge>
  );
}

function StatusMenu({
  task,
  onUpdate,
  trigger,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  trigger: PropertyTrigger;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" {...trigger}>
          <StatusIcon status={task.status} />
          {STATUS_LABELS[task.status]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_STATUSES.map((status) => (
          <DropdownMenuItem key={status} onSelect={() => onUpdate({ status })}>
            <StatusIcon status={status} />
            {STATUS_LABELS[status]}
            {status === task.status ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityMenu({
  task,
  onUpdate,
  trigger,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  trigger: PropertyTrigger;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" {...trigger}>
          <PriorityIcon priority={task.priority} />
          {PRIORITY_LABELS[task.priority]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_PRIORITIES.map((priority) => (
          <DropdownMenuItem key={priority} onSelect={() => onUpdate({ priority })}>
            <PriorityIcon priority={priority} />
            {PRIORITY_LABELS[priority]}
            {priority === task.priority ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DueDateMenu({
  task,
  onUpdate,
  trigger,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  trigger: PropertyTrigger;
}) {
  const [open, setOpen] = useState(false);
  const pick = (dueDate: string | null) => {
    onUpdate({ dueDate });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" {...trigger}>
          <Icon name="Clock" className="size-3.5 shrink-0" />
          {task.dueDate ? formatDueDate(task.dueDate) : "Set due date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-2">
        <div className="flex flex-col">
          {DUE_DATE_PRESETS.map(([label, days]) => (
            <Button
              key={label}
              variant="ghost"
              size="sm"
              className="justify-between px-2 text-sm font-normal"
              onClick={() => pick(localIsoDate(days))}
            >
              {label}
              <span className="text-xs text-muted-foreground">
                {formatDueDate(localIsoDate(days))}
              </span>
            </Button>
          ))}
          <Input
            type="date"
            aria-label="Due date"
            className="mt-1 h-7 px-2"
            value={task.dueDate ?? ""}
            onChange={(event) => {
              if (event.target.value) pick(event.target.value);
            }}
          />
          {task.dueDate ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 justify-start px-2 text-sm font-normal text-muted-foreground"
              onClick={() => pick(null)}
            >
              <Icon name="X" className="size-3.5" />
              Remove due date
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabelsMenu({
  task,
  labels,
  onUpdate,
  children,
}: {
  task: Task;
  labels: Label[] | undefined;
  onUpdate: (update: TaskPropertyUpdate) => void;
  children: React.ReactNode;
}) {
  const rpc = useTasksRpc();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const toggle = (labelId: string) => {
    const next = task.labelIds.includes(labelId)
      ? task.labelIds.filter((id) => id !== labelId)
      : [...task.labelIds, labelId];
    onUpdate({ labelIds: next });
  };

  const createLabel = async (name: string) => {
    if (!name || creating) return;
    setCreating(true);
    try {
      const { label } = await rpc.call("createLabel", {
        projectId: task.projectId,
        name,
        color: DEFAULT_COLOR,
      });
      onUpdate({ labelIds: [...task.labelIds, label.id] });
      setQuery("");
    } finally {
      setCreating(false);
    }
  };

  const labelList = labels ?? [];
  const trimmed = query.trim();
  return (
    <Popover onOpenChange={(open) => open || setQuery("")}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Add labels…" value={query} onValueChange={setQuery} />
          <CommandList>
            {trimmed === "" ? <CommandEmpty>No labels in this project.</CommandEmpty> : null}
            <CreateLabelItem
              name={trimmed}
              disabled={creating}
              onCreate={() => void createLabel(trimmed)}
            />
            {labels !== undefined && labelList.length === 0 && trimmed === "" ? (
              <CommandGroup>
                <CommandItem
                  disabled={creating}
                  onSelect={() => {
                    const name = query.trim();
                    if (name) void createLabel(name);
                  }}
                >
                  <Icon name="Plus" className="size-3.5" />
                  New label{query.trim() ? ` “${query.trim()}”` : "…"}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {labelList.length > 0 ? (
              <CommandGroup>
                {labelList.map((label) => (
                  <CommandItem key={label.id} value={label.name} onSelect={() => toggle(label.id)}>
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1">{label.name}</span>
                    {task.labelIds.includes(label.id) ? (
                      <Icon name="Check" className="size-3.5" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DispatchTargetMenu({
  project,
  bbProjects,
  onError,
  trigger,
}: {
  project: Project;
  bbProjects: readonly BbProjectOption[];
  onError: (message: string) => void;
  trigger: PropertyTrigger;
}) {
  const rpc = useTasksRpc();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const linkedBbProjectId = project.linkedBbProjectId;
  const linkedName = bbProjects.find((candidate) => candidate.id === linkedBbProjectId)?.name;

  const save = async (linkedId: string | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await rpc.call("updateProject", {
        projectId: project.id,
        linkedBbProjectId: linkedId,
      });
      setOpen(false);
    } catch (saveError) {
      onError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setSelection(linkedBbProjectId);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" aria-label="Edit dispatch target" {...trigger}>
          <Icon name="ArrowUpRight" className="size-3.5 shrink-0" />
          {linkedBbProjectId !== null ? (
            <span className="truncate" title={linkedBbProjectId}>
              {linkedName ?? linkedBbProjectId}
            </span>
          ) : (
            <span className="truncate text-muted-foreground">Link a bb project…</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <BbProjectLinkPicker
          value={selection}
          onChange={setSelection}
          bbProjects={bbProjects}
          noneLabel={linkedBbProjectId !== null ? "Unlink" : "Not linked"}
        />
        <div className="mt-3 flex items-center justify-between gap-2">
          {linkedBbProjectId !== null ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              disabled={saving}
              onClick={() => void save(null)}
            >
              <Icon name="X" className="size-3.5" />
              Unlink
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" className="h-7" disabled={saving} onClick={() => void save(selection)}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function PropertiesRail({
  task,
  project,
  labels,
  threads,
  presets,
  onUpdate,
  onError,
  className,
}: TaskPropertiesProps & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) => task.labelIds.includes(label.id));
  const active = threads.filter(isActiveThread);
  const bbProjects = useQuery(bbProjectsQuery);
  return (
    <aside className={cn("w-56 shrink-0 py-10 pl-2 pr-6", className)}>
      <h2 className="mb-1 text-xs font-semibold text-muted-foreground">Properties</h2>
      <StatusMenu task={task} onUpdate={onUpdate} trigger={RAIL_TRIGGER} />
      <PriorityMenu task={task} onUpdate={onUpdate} trigger={RAIL_TRIGGER} />
      <DueDateMenu task={task} onUpdate={onUpdate} trigger={RAIL_TRIGGER} />

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">Labels</div>
      <div className="flex min-h-6 flex-wrap items-center gap-1">
        {taskLabels.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
        <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
          <Button
            variant="outline"
            size="icon"
            aria-label="Edit labels"
            className="h-5 w-6 border-dashed text-muted-foreground"
          >
            <Icon name="Plus" className="size-3" />
          </Button>
        </LabelsMenu>
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">Project</div>
      <div className="flex h-6 items-center gap-2 text-sm">
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-sm"
          style={{ backgroundColor: project?.color }}
        />
        <span className="truncate">{project?.name ?? "…"}</span>
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">Dispatch target</div>
      {project !== undefined ? (
        <DispatchTargetMenu
          project={project}
          bbProjects={bbProjects.data ?? []}
          onError={onError}
          trigger={RAIL_TRIGGER}
        />
      ) : (
        <div className="flex h-6 items-center text-sm text-muted-foreground">…</div>
      )}

      <div className="mt-3">
        <DispatchControl
          taskId={task.id}
          presets={presets}
          onError={onError}
          align="start"
          className="w-full"
        />
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">Agents</div>
      <div className="flex flex-col gap-1 text-xs">
        {active.length > 0 ? (
          active.map((thread) => (
            <span key={thread.id} className="flex items-center gap-1 font-medium text-success">
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
              />
              <span className="truncate">
                {thread.presetName} {thread.liveStatus === "starting" ? "starting" : "working"}
              </span>
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">none active</span>
        )}
      </div>
    </aside>
  );
}

export function InlineProperties({
  task,
  labels,
  presets,
  onUpdate,
  onError,
  className,
}: Omit<TaskPropertiesProps, "project" | "threads"> & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) => task.labelIds.includes(label.id));
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <StatusMenu task={task} onUpdate={onUpdate} trigger={CHIP_TRIGGER} />
      <PriorityMenu task={task} onUpdate={onUpdate} trigger={CHIP_TRIGGER} />
      <DueDateMenu task={task} onUpdate={onUpdate} trigger={CHIP_TRIGGER} />
      {taskLabels.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
        <Button
          variant="outline"
          size="icon"
          aria-label="Edit labels"
          className="h-6 w-7 border-dashed text-muted-foreground"
        >
          <Icon name="Plus" className="size-3" />
        </Button>
      </LabelsMenu>
      <DispatchControl
        taskId={task.id}
        presets={presets}
        onError={onError}
        className="ml-auto max-w-56"
      />
    </div>
  );
}
