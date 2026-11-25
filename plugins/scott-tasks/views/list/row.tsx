import { memo, useId, useState } from "react";
import type { Label, Project, Task, TaskThread } from "../../shared/contract.js";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { PriorityIcon } from "./icons.js";
import { activeWorkLabel, formatDueDate, formatUpdatedAt, partitionLabels } from "./lib.js";
import type { EditFn } from "./property-menus.js";
import {
  isBareKey,
  LabelsEditor,
  PriorityEditor,
  StatusEditor,
  TaskContextMenu,
} from "./property-menus.js";

const RAIL_CHIP_CLASS =
  "h-4.5 gap-1 rounded-full px-1.5 py-0 text-2xs font-normal text-muted-foreground";

function ActiveChip({ threads }: { threads: readonly TaskThread[] }) {
  if (threads.length === 0) return null;
  return (
    <span
      title={activeWorkLabel(threads)}
      className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-recessed text-muted-foreground"
    >
      <Icon name="Bot" className="size-3" aria-hidden />
      <span aria-hidden className="absolute bottom-0 right-0 size-1.5 rounded-full bg-success" />
      <span className="sr-only">Active</span>
    </span>
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
      <span className="hidden items-center gap-1 @xl:flex">
        <LabelChipRow labels={labels} maxVisible={2} />
      </span>
      <span className="flex items-center gap-1 @xl:hidden">
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
  const date = task.dueDate ?? task.updatedAt;
  const dateLabel = task.dueDate === null ? formatUpdatedAt(date) : formatDueDate(date);

  return (
    <TaskContextMenu
      task={task}
      onEdit={onEdit}
      projectLabels={projectLabels}
      projects={projects}
      onMoveToProject={onMoveToProject}
      selected={selected}
      onToggleSelection={onToggleSelection ? () => onToggleSelection(task.id) : undefined}
    >
      <div
        data-task-key={task.key}
        onKeyDown={(event) => {
          // Menus portal out of the row; their events still bubble through React.
          if (
            !event.currentTarget.contains(event.target as Node) ||
            !isBareKey(event) ||
            event.defaultPrevented
          )
            return;
          const key = event.key.toLowerCase();
          if (key === "s" || key === "p" || key === "l") {
            event.preventDefault();
            setOpenMenu(key === "s" ? "status" : key === "p" ? "priority" : "labels");
          } else if (key === "x" && onToggleSelection) {
            event.preventDefault();
            onToggleSelection(task.id);
          }
        }}
        aria-busy={pending || undefined}
        className={cn(
          "group relative grid min-h-14 w-full grid-cols-[2.75rem_minmax(0,1fr)] grid-rows-[1.75rem_1.75rem] items-center gap-x-2 px-3 text-left hover:bg-state-hover pointer-coarse:grid-rows-[1.5rem_2.75rem]",
          "pointer-fine:@md:h-9 pointer-fine:@md:min-h-9 pointer-fine:@md:grid-cols-[1.25rem_3.7rem_1.25rem_minmax(0,1fr)_minmax(0,9rem)_2.25rem_4.25rem] pointer-fine:@md:grid-rows-1 pointer-fine:@md:pl-7 pointer-fine:@md:pr-6",
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
          className="absolute inset-0 scroll-mt-11 rounded-none focus-visible:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
        {onToggleSelection ? (
          <label
            htmlFor={selectionId}
            className={cn(
              "absolute inset-y-0 left-3 z-20 grid w-11 cursor-pointer place-items-center pointer-fine:@md:left-0 pointer-fine:@md:w-7",
              selectionActive || selected
                ? "bg-background group-hover:bg-state-hover"
                : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 pointer-fine:group-hover:pointer-events-auto pointer-fine:group-hover:opacity-100",
              selected && "bg-surface-selected",
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
          className="col-start-1 row-start-1 hidden pointer-fine:@md:inline-flex"
        />
        <span className="pointer-events-none relative col-start-2 row-start-2 flex min-w-0 items-center gap-1 self-center whitespace-nowrap text-2xs tabular-nums text-muted-foreground pointer-coarse:-translate-y-2 pointer-fine:@md:row-start-1 pointer-fine:@md:text-xs">
          <PriorityIcon priority={task.priority} className="size-3 pointer-fine:@md:hidden" />
          <span className="truncate">{task.key}</span>
        </span>
        <StatusEditor
          task={task}
          onEdit={onEdit}
          open={openMenu === "status"}
          onOpenChange={(next) => setOpenMenu(next ? "status" : null)}
          className="col-start-1 row-start-1 justify-self-center pointer-coarse:row-span-2 pointer-coarse:size-11 pointer-coarse:self-start pointer-coarse:pb-4 pointer-fine:@md:col-start-3"
        />
        <span className="pointer-events-none relative col-start-2 row-start-1 min-w-0 truncate text-sm font-semibold pointer-coarse:self-end pointer-fine:@md:col-start-4 pointer-fine:@md:text-[0.9375rem] pointer-fine:@md:font-medium">
          {task.title}
        </span>
        <span className="pointer-events-none relative col-start-2 row-start-2 flex max-w-[calc(100%-4.25rem)] min-w-0 items-center gap-1 self-center justify-self-end text-2xs text-muted-foreground pointer-fine:@md:col-span-3 pointer-fine:@md:col-start-5 pointer-fine:@md:row-start-1 pointer-fine:@md:grid pointer-fine:@md:w-full pointer-fine:@md:max-w-none pointer-fine:@md:grid-cols-[minmax(0,1fr)_2.25rem_4.25rem] pointer-fine:@md:self-center">
          <span className="pointer-events-auto min-w-0 overflow-hidden justify-self-end">
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
          <span className="flex shrink-0 items-center justify-center gap-1 pointer-coarse:-translate-y-2">
            {activeThreads ? <ActiveChip threads={activeThreads} /> : null}
            {showProject && project !== undefined ? (
              <span
                aria-hidden
                title={project.name}
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: project.color }}
              />
            ) : null}
          </span>
          <time
            dateTime={date}
            title={`${task.dueDate === null ? "Updated" : "Due"} ${dateLabel}`}
            className="flex min-h-5 shrink-0 items-center justify-end gap-1 whitespace-nowrap tabular-nums pointer-coarse:-translate-y-2"
          >
            {task.dueDate !== null ? <Icon name="Clock" className="size-3 shrink-0" /> : null}
            {dateLabel}
          </time>
        </span>
      </div>
    </TaskContextMenu>
  );
});
