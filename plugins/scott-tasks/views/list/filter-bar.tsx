import { useState } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import { TASK_SORTS, type TaskSort } from "../../shared/pagination.js";
import { Badge } from "@/components/ui/badge";
import { CompactButton } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  ResourceControlButton,
  ResourceMultiSelectMenuItems,
  ResourceSortMenuItems,
  type ResourceOption,
} from "@/components/ui/resource/toolbar";
import { isNonImeKey } from "@/lib/ime-keyboard";
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

const FILTER_TRIGGER_CLASS =
  "h-7 max-w-52 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground max-md:pointer-coarse:h-11 [&>span]:truncate";

/** Layout and the retained muted tone for the CompactButton triggers beside the filter chips. */
const COMPACT_TRIGGER_CLASS =
  "max-w-52 shrink-0 text-muted-foreground max-md:pointer-coarse:h-11 [&>span]:truncate";

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
        <CompactButton
          variant="ghost"
          size="sm"
          aria-label={`Sort: ${SORT_LABELS[sort]}`}
          className={COMPACT_TRIGGER_CLASS}
        >
          <Icon name="SlidersHorizontal" className="size-3.5" />
          <span>{sort === "manual" ? "Display" : SORT_LABELS[sort]}</span>
        </CompactButton>
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

function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative w-56 min-w-24">
      <Icon
        name="Search"
        className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label="Search tasks"
        placeholder="Search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (isNonImeKey(event, "Escape") && value !== "") {
            event.preventDefault();
            onChange("");
          }
        }}
        className="h-7 pl-6 text-xs max-md:pointer-coarse:h-11"
      />
    </div>
  );
}

export function ListFilterBar({
  filters,
  onChange,
  search,
  onSearchChange,
  sort,
  onSortChange,
  labelOptions,
  taskCount,
  fixedStatus = false,
}: {
  filters: ListFilterState;
  onChange: (filters: ListFilterState) => void;
  search: string;
  onSearchChange: (search: string) => void;
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  labelOptions: readonly LabelFilterOption[];
  taskCount: number | undefined;
  fixedStatus?: boolean;
}) {
  const [showFilters, setShowFilters] = useState<boolean | null>(null);
  const filterCount =
    filters.statuses.length + filters.priorities.length + filters.labelNames.length;
  const filtersOpen = showFilters ?? filterCount > 0;
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
    <Collapsible
      open={filtersOpen}
      onOpenChange={setShowFilters}
      className="shrink-0 border-b border-border-hairline px-3 @md:px-6"
    >
      <div className="flex min-h-10 items-center gap-1.5">
        <SearchInput value={search} onChange={onSearchChange} />
        <CollapsibleTrigger asChild>
          <CompactButton variant="ghost" size="sm" className={COMPACT_TRIGGER_CLASS}>
            <Icon name="Filter" className="size-3.5" />
            <span>Filter</span>
            {filterCount > 0 ? (
              <Badge variant="count" className="ml-1">
                {filterCount}
              </Badge>
            ) : null}
          </CompactButton>
        </CollapsibleTrigger>
        <span className="ml-auto hidden whitespace-nowrap text-2xs tabular-nums text-muted-foreground @md:inline">
          {taskCount === undefined ? "" : `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`}
        </span>
        <div className="@max-md:ml-auto">
          <SortMenu sort={sort} onChange={onSortChange} />
        </div>
      </div>
      <CollapsibleContent>
        <div
          role="group"
          aria-label="Filter tasks"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-2"
        >
          {!fixedStatus ? (
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
          ) : null}
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
          {hasActiveFilters(filters) || search !== "" ? (
            <CompactButton
              variant="outline"
              size="sm"
              onClick={() => {
                onChange(EMPTY_FILTERS);
                onSearchChange("");
              }}
              className="shrink-0 gap-1 text-muted-foreground max-md:pointer-coarse:h-11"
            >
              <Icon name="X" className="size-3" />
              Clear
            </CompactButton>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
