import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "../button";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../dropdown-menu";
import { Icon, type IconName } from "../icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";
import { cn } from "../../../lib/utils";

export interface ResourceOption {
  id: string;
  label: string;
  leading?: ReactNode;
  description?: string;
  disabled?: boolean;
  omitDirection?: boolean;
}

function ResourceOptionContent({
  option,
  compact = false,
}: {
  option: ResourceOption;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-2",
        compact && "md:gap-1.5 pointer-fine:gap-1.5",
      )}
    >
      {option.leading ? (
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          {option.leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs" title={compact ? option.label : undefined}>
          {option.label}
        </span>
        {option.description ? (
          <span className="truncate text-2xs text-subtle-foreground">{option.description}</span>
        ) : null}
      </span>
    </span>
  );
}

const RESOURCE_MENU_TRIGGER_ENGAGED_CLASS = "bg-state-active text-foreground hover:bg-state-active";

const RESOURCE_MENU_TRIGGER_RESTING_CLASS = "border border-input bg-background";

export const ResourceControlButton = forwardRef<
  HTMLButtonElement,
  ButtonProps & {
    label: string;
    icon?: IconName;
    active?: boolean;
    open?: boolean;
    tooltip?: ReactNode;
    text?: string;
    count?: number;
    trailingIcon?: IconName;
  }
>(function ResourceControlButton(
  {
    label,
    icon,
    active = false,
    open = false,
    tooltip = label,
    text,
    count,
    trailingIcon,
    className,
    ...props
  },
  ref,
) {
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            {...props}
            ref={ref}
            type="button"
            variant="outline"
            size={text ? "sm" : "icon"}
            className={cn(
              "h-8 shrink-0 rounded-md text-muted-foreground",
              text
                ? "gap-2 px-2 text-xs @max-[19rem]/resource-toolbar:gap-1 @max-[19rem]/resource-toolbar:px-1"
                : "size-8 p-0",
              RESOURCE_MENU_TRIGGER_RESTING_CLASS,
              (open || active) && RESOURCE_MENU_TRIGGER_ENGAGED_CLASS,
              className,
            )}
            aria-label={label}
          >
            {icon ? <Icon name={icon} className="size-4" aria-hidden /> : null}
            {text ? <span>{text}</span> : null}
            {count !== undefined && count > 0 ? (
              <span aria-hidden className="rounded bg-surface-recessed px-1 text-2xs">
                {count}
              </span>
            ) : null}
            {trailingIcon ? <Icon name={trailingIcon} className="size-4" aria-hidden /> : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

function nextSelectedValues(
  option: ResourceOption,
  checked: boolean,
  selectedValues: readonly string[],
): string[] | null {
  if (option.disabled) return null;
  const next = new Set(selectedValues);
  if (checked) {
    next.add(option.id);
  } else {
    next.delete(option.id);
  }
  return [...next];
}

export function ResourceMultiSelectMenuItems({
  label,
  selectedValues,
  options,
  onChange,
  compact = false,
  clearInFooter = false,
  showHeading = true,
}: {
  label: string;
  selectedValues: readonly string[];
  options: readonly ResourceOption[];
  onChange: (values: string[]) => void;
  compact?: boolean;
  clearInFooter?: boolean;
  showHeading?: boolean;
}) {
  const selected = new Set(selectedValues);
  function updateValue(option: ResourceOption, checked: boolean) {
    const next = nextSelectedValues(option, checked, selectedValues);
    if (next !== null) onChange(next);
  }
  return (
    <>
      {showHeading ? (
        <DropdownMenuLabel
          className={cn(
            "text-xs font-normal text-subtle-foreground",
            compact && "md:px-1.5 pointer-fine:px-1.5 md:py-1 pointer-fine:py-1",
          )}
        >
          {label}
        </DropdownMenuLabel>
      ) : null}
      {options.map((option) => (
        <DropdownMenuCheckboxItem
          key={option.id}
          checked={selected.has(option.id)}
          disabled={option.disabled}
          className={cn(
            compact &&
              "md:py-1 pointer-fine:py-1 md:pl-1.5 pointer-fine:pl-1.5 md:pr-7 pointer-fine:pr-7",
          )}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) => updateValue(option, checked === true)}
        >
          <ResourceOptionContent option={option} compact={compact} />
        </DropdownMenuCheckboxItem>
      ))}
      {clearInFooter ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={selectedValues.length === 0}
            onSelect={(event) => {
              event.preventDefault();
              onChange([]);
            }}
            className={cn(
              "text-xs text-muted-foreground",
              compact && "md:px-1.5 pointer-fine:px-1.5 md:py-1 pointer-fine:py-1",
            )}
          >
            Clear filter
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}
export function ResourceSortMenuItems({
  value,
  direction,
  options,
  onChange,
  onClear,
  placeholderLabel = "Sort",
  compact = false,
  clearInFooter = false,
  showHeading = true,
}: {
  value: string | null;
  direction: "asc" | "desc";
  options: readonly ResourceOption[];
  onChange: (value: string) => void;
  onClear?: () => void;
  placeholderLabel?: string;
  compact?: boolean;
  clearInFooter?: boolean;
  showHeading?: boolean;
}) {
  return (
    <>
      {showHeading ? (
        <DropdownMenuLabel
          className={cn(
            "text-xs font-normal text-subtle-foreground",
            compact && "md:px-1.5 pointer-fine:px-1.5 md:py-1 pointer-fine:py-1",
          )}
        >
          Sort
        </DropdownMenuLabel>
      ) : null}
      {onClear === undefined || clearInFooter ? null : (
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={value === null}
          onSelect={(event) => {
            event.preventDefault();
            onClear();
          }}
          className={cn(
            "flex items-center justify-between gap-3",
            compact &&
              "md:gap-2 pointer-fine:gap-2 md:px-1.5 pointer-fine:px-1.5 md:py-1 pointer-fine:py-1",
          )}
        >
          {placeholderLabel}
          <Icon
            name="Check"
            aria-hidden
            className={cn(
              "size-4 text-subtle-foreground",
              value === null ? "opacity-100" : "opacity-0",
            )}
          />
        </DropdownMenuItem>
      )}
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <DropdownMenuItem
            key={option.id}
            disabled={option.disabled}
            role="menuitemradio"
            aria-checked={selected}
            onSelect={(event) => {
              event.preventDefault();
              if (option.disabled) return;
              onChange(option.id);
            }}
            className={cn(
              "flex items-center justify-between gap-3",
              compact &&
                "md:gap-2 pointer-fine:gap-2 md:px-1.5 pointer-fine:px-1.5 md:py-1 pointer-fine:py-1",
            )}
          >
            <ResourceOptionContent option={option} compact={compact} />
            <Icon
              name={direction === "asc" ? "ArrowUp" : "ArrowDown"}
              aria-hidden
              className={cn(
                "size-4 text-subtle-foreground",
                option.omitDirection === true ? "hidden" : selected ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        );
      })}
      {clearInFooter && onClear !== undefined ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={value === null}
            onSelect={(event) => {
              event.preventDefault();
              onClear();
            }}
            className={cn(
              "text-xs text-muted-foreground",
              compact && "md:px-1.5 pointer-fine:px-1.5 md:py-1 pointer-fine:py-1",
            )}
          >
            Clear sort
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}
