import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ComponentPropsWithRef, ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";

/*
 * bb draws the rows themselves (`experimental_ThreadContextCardRow`); these are
 * the menus and buttons the card's rows carry in their `action` slot.
 */

/** An icon button for a card row's `action` slot. */
export function RowActionButton({
  icon,
  label,
  ...props
}: Omit<ComponentPropsWithRef<"button">, "children" | "className"> & {
  icon: string;
  label: string;
}) {
  // `props.ref` carries Radix's composed trigger ref, so it must reach the button.
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            {...props}
            className="size-5 shrink-0 text-muted-foreground data-[state=open]:bg-state-hover data-[state=open]:text-foreground max-md:pointer-coarse:size-7"
          >
            <Icon name={icon} aria-hidden className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A card row's `action`: a chevron that opens the row's menu. */
export function RowMenu({
  label,
  triggerRef,
  children,
}: {
  label: string;
  triggerRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <RowActionButton icon="ChevronDown" label={label} ref={triggerRef} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        mobileTitle={label}
        className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-48 max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto"
      >
        <DropdownMenuGroup>{children}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MenuItem({
  icon,
  children,
  detail,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof DropdownMenuItem>, "className" | "variant"> & {
  icon?: string;
  detail?: ReactNode;
}) {
  return (
    <DropdownMenuItem {...props}>
      {icon ? <Icon name={icon} aria-hidden /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {detail ? (
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenuLabel>{children}</DropdownMenuLabel>;
}

export function MenuSeparator() {
  return <DropdownMenuSeparator />;
}
