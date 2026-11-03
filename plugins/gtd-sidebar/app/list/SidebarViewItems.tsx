import type { ReactNode } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { experimental_useExperiment } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { GtdFilterItems } from "../gtd/GtdFilters.js";
import {
  sidebarOrganizationModeAtom,
  sidebarChronologicalSortAtom,
  sidebarSortDirectionAtom,
  sidebarGroupThreadsByEnvironmentAtom,
  sidebarEnvironmentGroupingAtom,
  sidebarGroupByReadStatusAtom,
  sidebarShowProviderIconsAtom,
  sidebarShowRowMetadataAtom,
  THREAD_ROW_METADATA_EXPERIMENT,
} from "../preferences/atoms.js";

const SIDEBAR_ORGANIZE_OPTIONS = [
  { label: "By project", mode: "project" },
  { label: "By machine", mode: "machine" },
  { label: "Flat", mode: "chronological" },
] as const;

const SIDEBAR_SORT_OPTIONS = [
  { label: "Arrival", sort: "arrival", direction: "descending" },
  { label: "Updated at", sort: "updated", direction: "descending" },
  { label: "Created at", sort: "created", direction: "descending" },
  { label: "Alphabetical", sort: "alpha", direction: "ascending" },
] as const;

type SidebarViewPage = "organize" | "sort" | "filter";

export function SidebarHeaderMenuContents({
  compact,
  page,
  onPageChange,
  children,
}: {
  compact: boolean;
  page: SidebarViewPage | null;
  onPageChange: (page: SidebarViewPage | null) => void;
  children?: ReactNode;
}) {
  if (compact && page) {
    return (
      <>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onPageChange(null);
          }}
        >
          <Icon name="ChevronLeft" />
          Back
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <SidebarViewItems page={page} />
      </>
    );
  }
  return (
    <>
      {(
        [
          { page: "organize", label: "Organize", icon: "Layers" },
          { page: "sort", label: "Sort by", icon: "ArrowUpDown" },
          { page: "filter", label: "Filter", icon: "SlidersHorizontal" },
        ] as const
      ).map((item) =>
        compact ? (
          <DropdownMenuItem
            key={item.page}
            className="[&>[data-icon-root]:last-child]:size-3 [&>[data-icon-root]:last-child]:text-subtle-foreground"
            onSelect={(event) => {
              event.preventDefault();
              onPageChange(item.page);
            }}
          >
            <Icon name={item.icon} />
            {item.label}
            <Icon name="ChevronRight" className="ml-auto" />
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub key={item.page}>
            <DropdownMenuSubTrigger className="[&>[data-icon-root]:last-child]:size-3 [&>[data-icon-root]:last-child]:text-subtle-foreground">
              <Icon name={item.icon} />
              {item.label}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                className={item.page === "organize" ? "min-w-32" : "w-max min-w-28 max-w-64"}
              >
                <SidebarViewItems page={item.page} />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        ),
      )}
      {children ? (
        <>
          <DropdownMenuSeparator />
          {children}
        </>
      ) : null}
    </>
  );
}

function SidebarViewItems({ page }: { page: SidebarViewPage }) {
  const [organization, setOrganization] = useAtom(sidebarOrganizationModeAtom);
  const [sort, setSort] = useAtom(sidebarChronologicalSortAtom);
  const [savedDirection, setDirection] = useAtom(sidebarSortDirectionAtom);
  const setEnvironmentGrouping = useSetAtom(sidebarEnvironmentGroupingAtom);
  const groupByEnvironment = useAtomValue(sidebarGroupThreadsByEnvironmentAtom);
  const [groupByReadStatus, setGroupByReadStatus] = useAtom(sidebarGroupByReadStatusAtom);
  const [showProviderIcons, setShowProviderIcons] = useAtom(sidebarShowProviderIconsAtom);
  const [showRowMetadata, setShowRowMetadata] = useAtom(sidebarShowRowMetadataAtom);
  const rowMetadataEnabled = experimental_useExperiment(THREAD_ROW_METADATA_EXPERIMENT);
  const selectedSort = sort === "none" ? "updated" : sort;
  if (page === "filter") {
    return <GtdFilterItems />;
  }
  if (page === "organize") {
    return (
      <>
        <DropdownMenuGroup aria-label="Sections">
          <DropdownMenuLabel>Sections</DropdownMenuLabel>
          {SIDEBAR_ORGANIZE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.mode}
              role="menuitemradio"
              aria-checked={organization === option.mode}
              onSelect={(event) => {
                event.preventDefault();
                setOrganization(option.mode);
              }}
            >
              {option.label}
              <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
                {organization === option.mode && <Icon name="Check" className="size-4" />}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup aria-label="Groups">
          <DropdownMenuLabel>Groups</DropdownMenuLabel>
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={groupByEnvironment}
            onSelect={(event) => {
              event.preventDefault();
              setEnvironmentGrouping(!groupByEnvironment);
              if (!groupByEnvironment) setGroupByReadStatus(false);
            }}
          >
            By environment
            <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
              {groupByEnvironment && <Icon name="Check" className="size-4" />}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={groupByReadStatus}
            onSelect={(event) => {
              event.preventDefault();
              setGroupByReadStatus(!groupByReadStatus);
            }}
          >
            By read status
            <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
              {groupByReadStatus && <Icon name="Check" className="size-4" />}
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup aria-label="Rows">
          <DropdownMenuLabel>Rows</DropdownMenuLabel>
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={showProviderIcons}
            onSelect={(event) => {
              event.preventDefault();
              setShowProviderIcons(!showProviderIcons);
            }}
          >
            Provider icons
            <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
              {showProviderIcons && <Icon name="Check" className="size-4" />}
            </span>
          </DropdownMenuItem>
          {rowMetadataEnabled ? (
            <DropdownMenuItem
              role="menuitemcheckbox"
              aria-checked={showRowMetadata}
              onSelect={(event) => {
                event.preventDefault();
                setShowRowMetadata(!showRowMetadata);
              }}
            >
              Metadata
              <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
                {showRowMetadata && <Icon name="Check" className="size-4" />}
              </span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </>
    );
  }
  return (
    <DropdownMenuGroup aria-label="Sort">
      {SIDEBAR_SORT_OPTIONS.map((option) => {
        const selected = selectedSort === option.sort;
        const direction = savedDirection === "default" ? option.direction : savedDirection;
        const nextDirection = selected
          ? direction === "ascending"
            ? "descending"
            : "ascending"
          : option.direction;
        return (
          <DropdownMenuItem
            key={option.sort}
            role="menuitemradio"
            aria-checked={selected}
            aria-label={
              selected ? `${option.label}, ${direction}. Sort ${nextDirection}` : option.label
            }
            onSelect={(event) => {
              event.preventDefault();
              setSort(option.sort);
              setDirection(nextDirection);
            }}
          >
            {option.label}
            {selected && (
              <span className="sr-only">
                , {direction}. Sort {nextDirection}
              </span>
            )}
            <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
              {selected && (
                <Icon
                  name={direction === "ascending" ? "ArrowUp" : "ArrowDown"}
                  className="size-4"
                />
              )}
            </span>
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuGroup>
  );
}
