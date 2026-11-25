import { useEffect, useRef, useState } from "react";
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
import { isBareKey, priorityForShortcut, statusForShortcut } from "../list/property-menus.js";
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
  DropdownMenuLabel,
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
  projects: Project[] | undefined;
  labels: Label[] | undefined;
  threads: TaskThread[];
  children?: React.ReactNode;
  onUpdate: (update: TaskPropertyUpdate) => void;
  onMoveToProject: (projectId: string) => void;
}

/** How a property menu's trigger looks: a full-width rail row or an inline chip. */
type PropertyTrigger = Pick<ButtonProps, "variant" | "className">;

const RAIL_TRIGGER: PropertyTrigger = {
  variant: "ghost",
  className:
    "h-8 shrink-0 justify-start gap-2 rounded-full bg-surface-recessed-solid px-3 text-xs font-normal @[45rem]:w-full @[45rem]:rounded-md @[45rem]:bg-transparent @[45rem]:px-2 @[45rem]:text-sm max-md:pointer-coarse:h-11",
};

type PropertyMenuState = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  menu,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  trigger: PropertyTrigger;
  menu: PropertyMenuState;
}) {
  return (
    <DropdownMenu {...menu}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" {...trigger} aria-keyshortcuts="S">
          <StatusIcon status={task.status} />
          {STATUS_LABELS[task.status]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Change status"
        onKeyDown={(event) => {
          const status = statusForShortcut(event.key);
          if (status === null || !isBareKey(event)) return;
          event.preventDefault();
          if (status !== task.status) onUpdate({ status });
          menu.onOpenChange(false);
        }}
      >
        <DropdownMenuLabel>Change status (S)</DropdownMenuLabel>
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
  menu,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  trigger: PropertyTrigger;
  menu: PropertyMenuState;
}) {
  return (
    <DropdownMenu {...menu}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" {...trigger} aria-keyshortcuts="P">
          <PriorityIcon priority={task.priority} />
          {PRIORITY_LABELS[task.priority]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Set priority"
        onKeyDown={(event) => {
          const priority = priorityForShortcut(event.key);
          if (priority === null || !isBareKey(event)) return;
          event.preventDefault();
          if (priority !== task.priority) onUpdate({ priority });
          menu.onOpenChange(false);
        }}
      >
        <DropdownMenuLabel>Set priority (P)</DropdownMenuLabel>
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
  menu,
}: {
  task: Task;
  labels: Label[] | undefined;
  onUpdate: (update: TaskPropertyUpdate) => void;
  children: React.ReactNode;
  menu: PropertyMenuState;
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
    <Popover
      open={menu.open}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        menu.onOpenChange(open);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Add labels… (L)" value={query} onValueChange={setQuery} />
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

function ProjectSwatch({ project }: { project: Project | undefined }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: project?.color }}
    />
  );
}

/** Moves the task, with its sub-tasks, to another project. The task gets a new key there. */
function ProjectMenu({
  task,
  project,
  projects,
  onMoveToProject,
  trigger,
}: {
  task: Task;
  project: Project | undefined;
  projects: Project[] | undefined;
  onMoveToProject: (projectId: string) => void;
  trigger: PropertyTrigger;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={trigger.variant}
          aria-label="Move to project"
          className={cn("gap-2", trigger.className)}
        >
          <ProjectSwatch project={project} />
          <span className="truncate">{project?.name ?? "…"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Move to project…" />
          <CommandList>
            <CommandEmpty>No matching projects.</CommandEmpty>
            <CommandGroup>
              {(projects ?? []).map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={`${candidate.name} ${candidate.prefix}`}
                  onSelect={() => {
                    setOpen(false);
                    if (candidate.id !== task.projectId) onMoveToProject(candidate.id);
                  }}
                >
                  <ProjectSwatch project={candidate} />
                  <span className="flex-1 truncate">{candidate.name}</span>
                  {candidate.id === task.projectId ? (
                    <Icon name="Check" className="size-3.5" />
                  ) : (
                    <span className="text-2xs text-muted-foreground">{candidate.prefix}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
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

const PROPERTY_KEYS = {
  s: "status",
  p: "priority",
  l: "labels",
  a: "agent",
} as const;
type PropertyMenu = (typeof PROPERTY_KEYS)[keyof typeof PROPERTY_KEYS];

export function PropertiesRail({
  task,
  project,
  projects,
  labels,
  threads,
  presets,
  onUpdate,
  onMoveToProject,
  onError,
  className,
  children,
}: TaskPropertiesProps & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) => task.labelIds.includes(label.id));
  const active = threads.filter(isActiveThread);
  const bbProjects = useQuery(bbProjectsQuery);
  const rail = useRef<HTMLElement>(null);
  const [openMenu, setOpenMenu] = useState<PropertyMenu | null>(null);
  const menu = (property: PropertyMenu): PropertyMenuState => ({
    open: openMenu === property,
    onOpenChange: (open) =>
      setOpenMenu((current) => (open ? property : current === property ? null : current)),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !isBareKey(event)) return;
      const key = event.key.toLowerCase();
      const property = PROPERTY_KEYS[key as keyof typeof PROPERTY_KEYS];
      if (!property || (property === "agent" && presets === undefined)) return;
      const target = event.target;
      const article = rail.current?.closest("article");
      if (!article || !(target instanceof HTMLElement)) return;
      if (target !== document.body && !article.contains(target)) return;
      if (target.isContentEditable || target.closest("input, textarea, select, [role='textbox']"))
        return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (rail.current?.getClientRects().length === 0) return;
      event.preventDefault();
      setOpenMenu(property);
    };
    // The Tasks page owns these letters before BB's window-level commands run.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [presets]);

  return (
    <aside
      ref={rail}
      className={cn("min-w-0 @[45rem]:border-l @[45rem]:border-border-hairline", className)}
    >
      <div className="@[45rem]:sticky @[45rem]:top-0 @[45rem]:px-4 @[45rem]:py-11">
        <h2 className="sr-only @[45rem]:not-sr-only @[45rem]:mb-3 @[45rem]:px-2 @[45rem]:text-xs @[45rem]:font-semibold @[45rem]:text-muted-foreground">
          Properties
        </h2>
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto pb-1 @[45rem]:block @[45rem]:overflow-visible @[45rem]:pb-0">
          <StatusMenu
            task={task}
            onUpdate={onUpdate}
            trigger={RAIL_TRIGGER}
            menu={menu("status")}
          />
          <PriorityMenu
            task={task}
            onUpdate={onUpdate}
            trigger={RAIL_TRIGGER}
            menu={menu("priority")}
          />
          <DueDateMenu task={task} onUpdate={onUpdate} trigger={RAIL_TRIGGER} />

          <ProjectMenu
            task={task}
            project={project}
            projects={projects}
            onMoveToProject={onMoveToProject}
            trigger={RAIL_TRIGGER}
          />

          <div className="flex shrink-0 items-center gap-1 @[45rem]:flex-wrap @[45rem]:px-2 @[45rem]:py-1">
            {taskLabels.map((label) => (
              <LabelChip key={label.id} label={label} />
            ))}
            <LabelsMenu task={task} labels={labels} onUpdate={onUpdate} menu={menu("labels")}>
              <Button
                variant="outline"
                size="icon"
                aria-label="Edit labels (L)"
                aria-keyshortcuts="L"
                className="size-7 text-muted-foreground max-md:pointer-coarse:size-11"
              >
                <Icon name="Tag" className="size-3.5" />
              </Button>
            </LabelsMenu>
          </div>

          {project !== undefined ? (
            <DispatchTargetMenu
              project={project}
              bbProjects={bbProjects.data ?? []}
              onError={onError}
              trigger={RAIL_TRIGGER}
            />
          ) : (
            <div className="hidden text-sm text-muted-foreground @[45rem]:block">…</div>
          )}

          <div className="shrink-0 @[45rem]:mt-3">
            <DispatchControl
              taskId={task.id}
              presets={presets}
              onError={onError}
              align="start"
              className="max-w-56 @[45rem]:w-full"
              menu={menu("agent")}
            />
          </div>
        </div>
        {active.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1 text-xs">
            {active.map((thread) => (
              <span key={thread.id} className="flex items-center gap-1 font-medium text-success">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
                />
                <span className="truncate">
                  {thread.presetName} {thread.liveStatus === "starting" ? "starting" : "working"}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {children}
      </div>
    </aside>
  );
}
