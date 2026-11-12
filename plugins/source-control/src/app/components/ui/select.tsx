/* shadcn/ui-derived */
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import * as SelectPrimitive from "@radix-ui/react-select";
import { useRef, type ComponentProps } from "react";
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

function Select({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: Omit<ComponentProps<typeof SelectPrimitive.Root>, keyof OpenProps> & OpenProps) {
  const [open, setOpen] = useOpenState({
    ...(openProp === undefined ? {} : { open: openProp }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange ? { onOpenChange } : {}),
  });
  const overlay = useOverlayValue(open, setOpen);
  return (
    <OverlayContext.Provider value={overlay}>
      <SelectPrimitive.Root open={open} onOpenChange={setOpen} {...props} />
    </OverlayContext.Provider>
  );
}

const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "inline-flex h-7 min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded-[6px] border border-solid border-border-hairline bg-transparent px-2 text-[12px] leading-4 whitespace-nowrap text-foreground enabled:hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-60 data-[placeholder]:text-muted-foreground [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex shrink-0 opacity-60">
        <Icon name="ChevronDown" className="size-3" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  const { open, close } = useOverlay();
  const node = useRef<HTMLDivElement>(null);
  // Escape goes through escape.ts, which claims it before bb or Radix see it.
  useEscapeLayer(node, close, { open, modal: true });
  return (
    <SelectPrimitive.Portal container={portalContainer()}>
      <SelectPrimitive.Content
        ref={node}
        data-slot="select-content"
        // escape.ts owns Escape; Radix sees only one it left alone, for bb's own pickers.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onEscapeKeyDown?.(event);
        }}
        position={position}
        sideOffset={4}
        className={cn(
          "relative z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-y-auto rounded-[8px] border border-solid border-border bg-popover p-1 text-foreground shadow-md",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex h-7 cursor-pointer items-center rounded-[6px] pr-7 pl-2 text-[12px] leading-4 text-foreground outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icon name="Check" className="size-3" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue };
