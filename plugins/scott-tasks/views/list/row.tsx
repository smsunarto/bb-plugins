import { memo, useId, useState } from "react";
import type { Label, Project, Task, TaskThread } from "../../shared/contract.js";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { PriorityIcon } from "./icons.js";
import { activeWorkLabel, formatDueDate, partitionLabels } from "./lib.js";
import type { EditFn } from "./property-menus.js";
import {
  isBareKey,
  LabelsEditor,
  PriorityEditor,
  StatusEditor,
  TaskContextMenu,
} from "./property-menus.js";

const RAIL_CHIP_CLASS =
  "h-5 gap-1 rounded-full px-1.5 py-0 text-2xs font-normal text-muted-foreground";

function ActiveChip({ threads }: { threads: readonly TaskThread[] }) {
  if (threads.length === 0) return null;
  return (
    <Badge variant="outline" title={activeWorkLabel(threads)} className={RAIL_CHIP_CLASS}>
      <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
      <Icon name="Bot" className="size-3 shrink-0" />
      Active
    </Badge>
  );
}

function LabelChip({ label }: { label: Label }) {
  return (
    <Badge variant="outline" className={cn(RAIL_CHIP_CLASS, "max-w-32")}>
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      <span className="truncate">{label.name}</span>
    </Badge>
  );
}

function LabelChipRow({ labels, maxVisible }: { labels: readonly Label[]; maxVisible: number }) {
  const { visible, hidden } = partitionLabels(labels, maxVisible);
  return (
    <>
      {visible.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      {hidden.length > 0 ? (
        <Badge
          variant="outline"
          title={hidden.map((label) => label.name).join(", ")}
          className={cn(RAIL_CHIP_CLASS, "tabular-nums")}
        >
          +{hidden.length}
        </Badge>
      ) : null}
    </>
  );
}

function LabelChips({ task, labelsById }: { task: Task; labelsById: Map<string, Label> }) {
  const labels = task.labelIds.flatMap((id) => labelsById.get(id) ?? []);
  if (labels.length === 0) return null;
  return (
    <>
      <span className="hidden items-center gap-2 @xl:flex">
        <LabelChipRow labels={labels} maxVisible={2} />
      </span>
      <span className="flex items-center gap-2 @xl:hidden">
        <LabelChipRow labels={labels} maxVisible={1} />
      </span>
    </>
  );
}

interface TaskRowProps {
  task: Task;
  /** The task's live agent threads, if any. */
  activeThreads: readonly TaskThread[] | undefined;
  project: Project | undefined;
  showProject: boolean;
  labelsById: Map<string, Label>;
  projectLabels: readonly Label[];
  projects: readonly Project[];
  onEdit: EditFn;
  onMoveToProject: (task: Task, projectId: string) => void;
  onOpen: (taskKey: string) => void;
  selected?: boolean;
  selectionActive?: boolean;
  onToggleSelection?: (taskId: string) => void;
  pending: boolean;
}

export const TaskRow = memo(function TaskRow({
  task,
  activeThreads,
  project,
  showProject,
  labelsById,
  projectLabels,
  projects,
  onEdit,
  onMoveToProject,
  onOpen,
  selected = false,
  selectionActive = false,
  onToggleSelection,
  pending,
}: TaskRowProps) {
  const [openMenu, setOpenMenu] = useState<"status" | "priority" | "labels" | null>(null);
  const selectionId = useId();
  const date = task.dueDate ?? task.updatedAt.slice(0, 10);

  return (
    <TaskContextMenu
      task={task}
      onEdit={onEdit}
      projectLabels={projectLabels}
      projects={projects}
      onMoveToProject={onMoveToProject}
    >
      <div
        data-task-key={task.key}
        aria-busy={pending || undefined}
        className={cn(
          "group relative grid min-h-15 w-full grid-cols-[auto_auto_auto_minmax(0,1fr)] items-center gap-x-1 border-b border-border-hairline px-2 text-left hover:bg-state-hover @md:px-5",
          "@md:flex @md:h-9 @md:min-h-9 @md:gap-2 max-md:pointer-coarse:h-auto",
          selected && "bg-surface-selected",
          pending && "opacity-70",
        )}
      >
        <button
          type="button"
          aria-label={`Open ${task.key}: ${task.title}`}
          aria-keyshortcuts="Enter"
          data-open-task={task.key}
          title="Open task (Enter) · Move (↑/↓ or J/K)"
          onClick={() => onOpen(task.key)}
          onKeyDown={(event) => {
            if (!isBareKey(event)) return;
            const key = event.key.toLowerCase();
            if (key === "s") {
              event.preventDefault();
              setOpenMenu("status");
            } else if (key === "p") {
              event.preventDefault();
              setOpenMenu("priority");
            } else if (key === "l") {
              event.preventDefault();
              setOpenMenu("labels");
            } else if (key === "x" && onToggleSelection) {
              event.preventDefault();
              onToggleSelection(task.id);
            }
          }}
          className="absolute inset-0 scroll-mt-11 rounded-none focus-visible:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
        {onToggleSelection ? (
          <label
            htmlFor={selectionId}
            className={cn(
              "relative z-10 col-start-1 row-span-2 row-start-1 grid h-full w-7 cursor-pointer place-items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 max-md:pointer-coarse:min-h-11 max-md:pointer-coarse:w-11 max-md:pointer-coarse:opacity-100",
              selectionActive && "opacity-100",
            )}
            title="Select task (X)"
          >
            <Checkbox
              id={selectionId}
              checked={selected}
              aria-label={`Select ${task.key}`}
              aria-keyshortcuts="X"
              onCheckedChange={() => onToggleSelection(task.id)}
            />
          </label>
        ) : null}
        <PriorityEditor
          task={task}
          onEdit={onEdit}
          open={openMenu === "priority"}
          onOpenChange={(next) => setOpenMenu(next ? "priority" : null)}
          className="col-start-2 row-span-2 row-start-1 max-md:pointer-coarse:hidden"
        />
        <span className="pointer-events-none relative col-start-4 row-start-2 flex min-w-0 items-center gap-1 self-center font-mono text-xs tabular-nums text-muted-foreground @md:w-16 @md:shrink-0">
          <PriorityIcon priority={task.priority} className="hidden max-md:pointer-coarse:block" />
          <span className="truncate">{task.key}</span>
        </span>
        <StatusEditor
          task={task}
          onEdit={onEdit}
          open={openMenu === "status"}
          onOpenChange={(next) => setOpenMenu(next ? "status" : null)}
          className="col-start-3 row-span-2 row-start-1"
        />
        <span className="pointer-events-none relative col-start-4 row-start-1 min-w-0 self-end truncate text-sm font-medium @md:flex-1 @md:self-auto">
          {task.title}
        </span>
        <span className="pointer-events-none relative col-start-4 row-start-2 flex max-w-[calc(100%-3.75rem)] min-w-0 items-center gap-1 justify-self-end text-xs text-muted-foreground @md:max-w-none @md:shrink-0 @md:gap-2">
          <span className="pointer-events-auto min-w-0 overflow-hidden">
            <LabelsEditor
              task={task}
              labels={projectLabels}
              onEdit={onEdit}
              open={openMenu === "labels"}
              onOpenChange={(next) => setOpenMenu(next ? "labels" : null)}
            >
              {task.labelIds.some((id) => labelsById.has(id)) ? (
                <LabelChips task={task} labelsById={labelsById} />
              ) : null}
            </LabelsEditor>
          </span>
          {activeThreads ? <ActiveChip threads={activeThreads} /> : null}
          {showProject && project !== undefined ? (
            <span
              aria-hidden
              title={project.name}
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project.color }}
            />
          ) : null}
          <time
            dateTime={date}
            title={
              task.dueDate === null
                ? `Updated ${formatDueDate(date)}`
                : `Due ${formatDueDate(date)}`
            }
            className="flex shrink-0 items-center justify-end gap-1 whitespace-nowrap tabular-nums @md:w-21"
          >
            {task.dueDate !== null ? <Icon name="Clock" className="size-3 shrink-0" /> : null}
            {formatDueDate(date)}
          </time>
        </span>
      </div>
    </TaskContextMenu>
  );
});
