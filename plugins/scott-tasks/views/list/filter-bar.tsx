import { useState } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import { TASK_SORTS, type TaskSort } from "../../shared/pagination.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  ResourceControlButton,
  ResourceMultiSelectMenuItems,
  ResourceSortMenuItems,
  type ResourceOption,
} from "@/components/ui/resource/toolbar";
import { PriorityIcon, StatusIcon } from "./icons.js";
import { PRIORITY_LABELS, SORT_LABELS, STATUS_LABELS, type LabelFilterOption } from "./lib.js";

const SORT_OPTIONS: readonly ResourceOption[] = TASK_SORTS.map((sort) => ({
  id: sort,
  label: SORT_LABELS[sort],
  omitDirection: true,
}));

const STATUS_OPTIONS: readonly ResourceOption[] = TASK_STATUSES.map((status) => ({
  id: status,
  label: STATUS_LABELS[status],
  leading: <StatusIcon status={status} className="size-3" />,
}));

const PRIORITY_OPTIONS: readonly ResourceOption[] = TASK_PRIORITIES.map((priority) => ({
  id: priority,
  label: PRIORITY_LABELS[priority],
  leading: <PriorityIcon priority={priority} className="size-3" />,
}));

const FILTER_TRIGGER_CLASS = "h-6 max-w-64 max-md:pointer-coarse:h-8 [&>span]:truncate";

function FilterMenu({
  icon,
  label,
  options,
  selectedValues,
  onChange,
}: {
  icon: IconName;
  label: string;
  options: readonly ResourceOption[];
  selectedValues: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedNames = options
    .filter((option) => selectedValues.includes(option.id))
    .map((option) => option.label);
  const summary = selectedNames.length > 0 ? `${label}: ${selectedNames.join(", ")}` : label;
  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <ResourceControlButton
          label={summary}
          text={summary}
          icon={icon}
          active={selectedNames.length > 0}
          open={open}
          className={FILTER_TRIGGER_CLASS}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44" mobileTitle={label}>
        <ResourceMultiSelectMenuItems
          label={label}
          selectedValues={selectedValues}
          options={options}
          onChange={onChange}
          showHeading={false}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortMenu({ sort, onChange }: { sort: TaskSort; onChange: (sort: TaskSort) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <ResourceControlButton
          label={`Sort: ${SORT_LABELS[sort]}`}
          text={sort === "manual" ? "Sort" : SORT_LABELS[sort]}
          icon="Sort"
          active={sort !== "manual"}
          open={open}
          className={FILTER_TRIGGER_CLASS}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" mobileTitle="Sort tasks">
        <ResourceSortMenuItems
          value={sort}
          direction="asc"
          options={SORT_OPTIONS}
          onChange={(next) => {
            const picked = TASK_SORTS.find((option) => option === next);
            if (picked !== undefined) onChange(picked);
            setOpen(false);
          }}
          showHeading={false}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ListFilterState {
  statuses: TaskStatus[];
  priorities: TaskPriority[];
  labelNames: string[];
}

export const EMPTY_FILTERS: ListFilterState = {
  statuses: [],
  priorities: [],
  labelNames: [],
};

export function hasActiveFilters(filters: ListFilterState): boolean {
  return (
    filters.statuses.length > 0 || filters.priorities.length > 0 || filters.labelNames.length > 0
  );
}

export function ListFilterBar({
  filters,
  onChange,
  sort,
  onSortChange,
  labelOptions,
  taskCount,
}: {
  filters: ListFilterState;
  onChange: (filters: ListFilterState) => void;
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  labelOptions: readonly LabelFilterOption[];
  taskCount: number | undefined;
}) {
  const showLabelChip = labelOptions.length > 0 || filters.labelNames.length > 0;
  const labelMenuOptions: ResourceOption[] = [
    ...labelOptions.map((option) => ({
      id: option.name,
      label: option.name,
      leading: (
        <span
          aria-hidden
          className="size-2 rounded-full"
          style={{ backgroundColor: option.color }}
        />
      ),
    })),
    ...filters.labelNames
      .filter((name) => !labelOptions.some((option) => option.name === name))
      .map((name) => ({
        id: name,
        label: name,
        description: "Unavailable",
        leading: <span aria-hidden className="size-2 rounded-full bg-muted-foreground/40" />,
      })),
  ];
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline px-3.5 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <FilterMenu
          icon="Circle"
          label="Status"
          options={STATUS_OPTIONS}
          selectedValues={filters.statuses}
          onChange={(values) =>
            onChange({
              ...filters,
              statuses: TASK_STATUSES.filter((status) => values.includes(status)),
            })
          }
        />
        <FilterMenu
          icon="ArrowUpDown"
          label="Priority"
          options={PRIORITY_OPTIONS}
          selectedValues={filters.priorities}
          onChange={(values) =>
            onChange({
              ...filters,
              priorities: TASK_PRIORITIES.filter((priority) => values.includes(priority)),
            })
          }
        />
        {showLabelChip ? (
          <FilterMenu
            icon="ListTodo"
            label="Label"
            options={labelMenuOptions}
            selectedValues={filters.labelNames}
            onChange={(labelNames) => onChange({ ...filters, labelNames })}
          />
        ) : null}
        {hasActiveFilters(filters) ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="h-6 shrink-0 gap-1 border-dashed px-2.5 text-muted-foreground max-md:pointer-coarse:h-8"
          >
            <Icon name="X" className="size-3" />
            Clear
          </Button>
        ) : null}
      </div>
      <SortMenu sort={sort} onChange={onSortChange} />
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle-foreground">
        {taskCount === undefined ? "" : `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`}
      </span>
    </div>
  );
}
