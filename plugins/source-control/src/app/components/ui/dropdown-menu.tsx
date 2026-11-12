/* shadcn/ui-derived */
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { useEscapeLayer } from "../../escape.ts";
import { cn } from "../../lib/utils.ts";
import {
  OverlayContext,
  useOpenState,
  useOverlay,
  useOverlayValue,
  type OpenProps,
} from "./open-state.ts";
import { portalContainer } from "./portal.ts";

function DropdownMenu({
  children,
  modal,
  ...openProps
}: OpenProps & { modal?: boolean; children: ReactNode }) {
  const [open, setOpen] = useOpenState(openProps);
  const overlay = useOverlayValue(open, setOpen);
  return (
    <DropdownMenuPrimitive.Root
      open={open}
      onOpenChange={setOpen}
      {...(modal === undefined ? {} : { modal })}
    >
      <OverlayContext.Provider value={overlay}>{children}</OverlayContext.Provider>
    </DropdownMenuPrimitive.Root>
  );
}

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;

function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "start",
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const { open, close } = useOverlay();
  const node = useRef<HTMLDivElement>(null);
  // Escape goes through escape.ts, which claims it before bb or Radix see it.
  useEscapeLayer(node, close, { open, modal: true });
  return (
    <DropdownMenuPrimitive.Portal container={portalContainer()}>
      <DropdownMenuPrimitive.Content
        ref={node}
        data-slot="dropdown-menu-content"
        // escape.ts owns Escape; Radix sees only one it left alone, for bb's own pickers.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onEscapeKeyDown?.(event);
        }}
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 flex max-h-(--radix-dropdown-menu-content-available-height) min-w-48 flex-col overflow-y-auto rounded-[8px] border border-solid border-border bg-popover p-1 text-foreground shadow-md outline-none",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { variant?: "default" | "destructive" }) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex h-7 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[12px] leading-4 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised",
        variant === "destructive" ? "text-destructive-text" : "text-foreground",
        className,
      )}
      {...props}
    />
  );
}

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/** A radio item; the checked one is set in semibold, as Source Control's pickers mark it. */
function DropdownMenuRadioItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "flex h-7 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[12px] leading-4 text-foreground outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised data-[state=checked]:font-semibold",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1 text-[11px] leading-4 text-muted-foreground", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
