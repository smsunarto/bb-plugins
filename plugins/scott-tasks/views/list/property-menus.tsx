import type { ReactNode } from "react";
import {
  TASK_STATUSES,
  type Label,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button, CompactButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { TaskEdit } from "../../shell/collections.js";
import { PriorityIcon, StatusIcon } from "./icons.js";
import {
  DUE_DATE_PRESETS,
  formatDueDate,
  localIsoDate,
  PRIORITY_LABELS,
  STATUS_LABELS,
} from "./lib.js";

export type EditFn = (task: Task, patch: TaskEdit) => void;

export const PRIORITY_MENU_ORDER: readonly TaskPriority[] = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
];

export function statusForShortcut(key: string): TaskStatus | null {
  if (!/^[0-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index >= 0 && index < TASK_STATUSES.length ? (TASK_STATUSES[index] ?? null) : null;
}

export function priorityForShortcut(key: string): TaskPriority | null {
  if (!/^[0-9]$/.test(key)) return null;
  const index = Number(key);
  return index >= 0 && index < PRIORITY_MENU_ORDER.length
    ? (PRIORITY_MENU_ORDER[index] ?? null)
    : null;
}

export function isBareKey(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

function MenuHeading({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <DropdownMenuLabel className="flex items-center gap-2">
      <span className="flex-1">{label}</span>
      <DropdownMenuShortcut className="w-3 text-right tabular-nums">
        {shortcut}
      </DropdownMenuShortcut>
    </DropdownMenuLabel>
  );
}

function PickerOption({
  icon,
  label,
  active,
  shortcut,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  shortcut: number;
}) {
  return (
    <>
      <span className="flex flex-1 items-center gap-2">
        {icon}
        {label}
        {active ? <span className="sr-only"> (current)</span> : null}
      </span>
      <span aria-hidden className="flex w-4 items-center justify-center text-subtle-foreground">
        {active ? <Icon name="Check" className="size-3.5" /> : null}
      </span>
      <DropdownMenuShortcut aria-hidden className="w-3 text-right tabular-nums">
        {shortcut}
      </DropdownMenuShortcut>
    </>
  );
}

const TRIGGER_CLASS = "relative z-10 max-md:pointer-coarse:size-11";

export function LabelsEditor({
  task,
  labels,
  onEdit,
  open,
  onOpenChange,
  children,
}: {
  task: Task;
  labels: readonly Label[];
  onEdit: EditFn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Edit task labels"
          aria-keyshortcuts="L"
          className="relative z-10 min-w-0 gap-1 px-1 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:pb-4"
        >
          {children ?? <Icon name="Tag" className="size-3.5 text-subtle-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" mobileTitle="Edit labels">
        <MenuHeading label="Labels" shortcut="L" />
        {labels.length === 0 ? (
          <DropdownMenuItem disabled>No project labels</DropdownMenuItem>
        ) : null}
        {open &&
          labels.map((label) => (
            <DropdownMenuCheckboxItem
              key={label.id}
              checked={task.labelIds.includes(label.id)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onEdit(task, {
                  labelIds: checked
                    ? [...task.labelIds, label.id]
                    : task.labelIds.filter((id) => id !== label.id),
                })
              }
            >
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: label.color }}
              />
              {label.name}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StatusEditor({
  task,
  onEdit,
  open,
  onOpenChange,
  className,
}: {
  task: Task;
  onEdit: EditFn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const select = (status: TaskStatus) => {
    if (status !== task.status) onEdit(task, { status });
  };
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <CompactButton
          variant="ghost"
          size="icon-2xs"
          aria-label={`Change status, currently ${STATUS_LABELS[task.status]}`}
          aria-keyshortcuts="S"
          className={cn(TRIGGER_CLASS, className)}
        >
          <StatusIcon status={task.status} />
        </CompactButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-56"
        mobileTitle="Change status"
        onKeyDown={(event) => {
          const status = statusForShortcut(event.key);
          if (status !== null && isBareKey(event)) {
            event.preventDefault();
            select(status);
            onOpenChange(false);
          }
        }}
      >
        <MenuHeading label="Change status…" shortcut="S" />
        {TASK_STATUSES.map((status, index) => (
          <DropdownMenuItem
            key={status}
            aria-current={status === task.status ? "true" : undefined}
            onSelect={() => select(status)}
          >
            <PickerOption
              icon={<StatusIcon status={status} />}
              label={STATUS_LABELS[status]}
              active={status === task.status}
              shortcut={index + 1}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PriorityEditor({
  task,
  onEdit,
  open,
  onOpenChange,
  className,
}: {
  task: Task;
  onEdit: EditFn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const select = (priority: TaskPriority) => {
    if (priority !== task.priority) onEdit(task, { priority });
  };
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <CompactButton
          variant="ghost"
          size="icon-2xs"
          aria-label={`Set priority, currently ${PRIORITY_LABELS[task.priority]}`}
          aria-keyshortcuts="P"
          className={cn(TRIGGER_CLASS, className)}
        >
          <PriorityIcon priority={task.priority} />
        </CompactButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        mobileTitle="Set priority"
        onKeyDown={(event) => {
          const priority = priorityForShortcut(event.key);
          if (priority !== null && isBareKey(event)) {
            event.preventDefault();
            select(priority);
            onOpenChange(false);
          }
        }}
      >
        <MenuHeading label="Set priority to…" shortcut="P" />
        {PRIORITY_MENU_ORDER.map((priority, index) => (
          <DropdownMenuItem
            key={priority}
            aria-current={priority === task.priority ? "true" : undefined}
            onSelect={() => select(priority)}
          >
            <PickerOption
              icon={<PriorityIcon priority={priority} />}
              label={PRIORITY_LABELS[priority]}
              active={priority === task.priority}
              shortcut={index}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskContextMenu({
  task,
  onEdit,
  projectLabels,
  projects,
  onMoveToProject,
  children,
  selected = false,
  onToggleSelection,
}: {
  task: Task;
  onEdit: EditFn;
  projectLabels: readonly Label[];
  projects: readonly Project[];
  onMoveToProject: (task: Task, projectId: string) => void;
  children: ReactNode;
  selected?: boolean;
  onToggleSelection?: () => void;
}) {
  const toggleLabel = (labelId: string) => {
    const labelIds = task.labelIds.includes(labelId)
      ? task.labelIds.filter((id) => id !== labelId)
      : [...task.labelIds, labelId];
    onEdit(task, { labelIds });
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {onToggleSelection ? (
          <>
            <ContextMenuCheckboxItem checked={selected} onCheckedChange={onToggleSelection}>
              Select task
              <ContextMenuShortcut>X</ContextMenuShortcut>
            </ContextMenuCheckboxItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <StatusIcon status={task.status} />
            <span>Status</span>
            <ContextMenuShortcut>S</ContextMenuShortcut>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            {TASK_STATUSES.map((status) => (
              <ContextMenuItem
                key={status}
                aria-current={status === task.status ? "true" : undefined}
                onSelect={() => {
                  if (status !== task.status) onEdit(task, { status });
                }}
              >
                <span className="flex flex-1 items-center gap-2">
                  <StatusIcon status={status} />
                  {STATUS_LABELS[status]}
                  {status === task.status ? <span className="sr-only"> (current)</span> : null}
                </span>
                {status === task.status ? (
                  <Icon name="Check" aria-hidden className="size-3.5" />
                ) : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <PriorityIcon priority={task.priority} />
            <span>Priority</span>
            <ContextMenuShortcut>P</ContextMenuShortcut>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-44">
            {PRIORITY_MENU_ORDER.map((priority) => (
              <ContextMenuItem
                key={priority}
                aria-current={priority === task.priority ? "true" : undefined}
                onSelect={() => {
                  if (priority !== task.priority) onEdit(task, { priority });
                }}
              >
                <span className="flex flex-1 items-center gap-2">
                  <PriorityIcon priority={priority} />
                  {PRIORITY_LABELS[priority]}
                  {priority === task.priority ? <span className="sr-only"> (current)</span> : null}
                </span>
                {priority === task.priority ? (
                  <Icon name="Check" aria-hidden className="size-3.5" />
                ) : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Icon name="Clock" className="size-3.5" />
            <span>Due date</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-44">
            {DUE_DATE_PRESETS.map(([label, days]) => {
              const value = localIsoDate(days);
              return (
                <ContextMenuItem key={label} onSelect={() => onEdit(task, { dueDate: value })}>
                  <span>{label}</span>
                  <span className="ml-auto text-2xs text-subtle-foreground">
                    {formatDueDate(value)}
                  </span>
                </ContextMenuItem>
              );
            })}
            {task.dueDate !== null ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onEdit(task, { dueDate: null })}>
                  <Icon name="X" className="size-3.5" />
                  <span>No due date</span>
                </ContextMenuItem>
              </>
            ) : null}
          </ContextMenuSubContent>
        </ContextMenuSub>

        {projectLabels.length > 0 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Icon name="ListTodo" className="size-3.5" />
              <span>Labels</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-48">
              {projectLabels.map((label) => (
                <ContextMenuCheckboxItem
                  key={label.id}
                  checked={task.labelIds.includes(label.id)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggleLabel(label.id)}
                >
                  <span
                    aria-hidden
                    className="mr-2 size-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </ContextMenuCheckboxItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}

        {projects.length > 1 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Icon name="ArrowUpRight" className="size-3.5" />
              <span>Move to project</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-48">
              {projects.map((project) => {
                const current = project.id === task.projectId;
                return (
                  <ContextMenuItem
                    key={project.id}
                    aria-current={current ? "true" : undefined}
                    onSelect={() => {
                      if (!current) onMoveToProject(task, project.id);
                    }}
                  >
                    <span className="flex flex-1 items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project.color }}
                      />
                      {project.name}
                      {current ? <span className="sr-only"> (current)</span> : null}
                    </span>
                    {current ? (
                      <Icon name="Check" aria-hidden className="size-3.5" />
                    ) : (
                      <span className="text-2xs text-muted-foreground">{project.prefix}</span>
                    )}
                  </ContextMenuItem>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
